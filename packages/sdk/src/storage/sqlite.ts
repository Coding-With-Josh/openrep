// sqlite storage adapter, the concrete persistence layer behind
// StorageAdapter. uses the node built-in node:sqlite (DatabaseSync) so the
// sdk has no native dependency and no extra install step.
//
// correctness and security decisions, each tied to the design review:
// - uniqueness of agents.name, agents.public_key, attestations.id, and
//   registered_sources.source_name is enforced by the schema constraints,
//   there is no application level pre-check anywhere in this layer. the
//   storage adapter is never asked "does this name exist" as a guard, it
//   just inserts and lets the constraint fire. this is the load bearing fix
//   for the check-then-write race between two concurrent createAgent calls,
//   see the contract comment in types/storage.ts.
// - every value reaching sqlite travels as a prepared statement positional
//   parameter, so caller controlled names, ids, and text can never inject
//   sql (adversarial review: sql injection).
// - agent records never persist private key material. beyond the structural
//   type guarantee, saveAgent asserts at runtime that the passed object does
//   not carry a privateKey property (adversarial review: key custody).
// - foreign keys are enforced per connection (sqlite defaults them off
//   unless told otherwise), so saving an attestation for a nonexistent agent
//   fails at the schema level and surfaces as AGENT_NOT_FOUND.
// - error classification below matches the exact node:sqlite error shape
//   verified against node 24.10.0: unique violations carry
//   "UNIQUE constraint failed: <table>.<column>" in the message and a
//   foreign key violation carries "FOREIGN KEY constraint failed". the
//   classifier never matches on message substrings of caller supplied data
//   because those messages are produced by sqlite from index names, not from
//   user values.
//
// error contract: saveAgent throws an error whose code property is exactly
// "DUPLICATE_NAME" on a name collision and "DUPLICATE_PUBLIC_KEY" on a
// public key collision. saveAttestation throws "AGENT_NOT_FOUND" when the
// referenced agent does not exist. saveRegisteredSource throws
// "DUPLICATE_SOURCE_NAME" on a source name collision. every other failure
// propagates as the raw node:sqlite error (code ERR_SQLITE_ERROR) so a disk
// failure is never miscategorized as a name conflict. read paths never throw
// for not-found, they return null.
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { ToolCall } from "../types/attestation.js";
import type { AgentPermission } from "../types/identity.js";
import type { AgentId } from "../types/identity.js";
import type { AgentRecord, AttestationRecord, Paginated, PaginationParams, StorageAdapter } from "../types/storage.js";
import type { RegisteredSource } from "../types/sources.js";

// schema bootstrap. idempotent by design: this project is pre-release with
// no deployed databases to migrate, so a numbered migration runner would be
// processional. additive schema changes can be appended with IF NOT EXISTS.
// the moment real user data exists anywhere a numbered migration strategy
// (sql files plus a schema_migrations table) becomes warranted. the unique
// constraint on agents.name is the authoritative uniqueness guard, the
// foreign key on attestations.agent_id is the referential integrity guard.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL UNIQUE,
  owner_public_key TEXT,
  memory_pointer TEXT,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  manifest_version INTEGER NOT NULL,
  signature TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS attestations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  idempotency_key TEXT,
  task TEXT NOT NULL,
  output TEXT NOT NULL,
  tools_used TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  signature TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(public_key)
);

CREATE TABLE IF NOT EXISTS registered_sources (
  source_name TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  trust_weight REAL NOT NULL
);
`;

// the only hand written index in the base schema. the unique and primary key
// constraints above already create indexes for agents.name, agents.public_key,
// attestations.id, and registered_sources.source_name, so this covers the
// one lookup the constraints do not: paging attestations by agent.
const ATTESTATIONS_BY_AGENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_attestations_agent_id ON attestations (agent_id);
`;

// idempotency dedup: the column plus the composite unique index. fresh
// databases get the column from the reinterpreted CREATE TABLE above;
// pre-existing files (created before this pass) get it through a guarded
// ALTER because sqlite has no ADD COLUMN IF NOT EXISTS. the composite unique
// index is the authoritative guard for attest()'s idempotency race: an
// identical (agent_id, idempotency_key) pair collides at insert, while NULL
// keys stay unbounded because sqlite treats NULLs as distinct in unique
// indexes. this is the one schema addition this pass permits beyond the
// original bootstrap.
function ensureIdempotencySchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(attestations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "idempotency_key")) {
    db.exec("ALTER TABLE attestations ADD COLUMN idempotency_key TEXT");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_idempotency ON attestations (agent_id, idempotency_key)`);
}

// revocation schema: owner_public_key + revoked_at on agents. fresh databases
// get both from the CREATE TABLE above; pre-existing files get them through
// the same guarded ALTER pattern as the idempotency column, because sqlite
// has no ADD COLUMN IF NOT EXISTS. both stay nullable on purpose: legacy rows
// have no owner key, and an absent revoked_at IS "not revoked". the sdk layer
// (recordFromRow + revokeAgent in the sdk module) turns a null owner key into
// the fail-closed OWNER_KEY_MISSING, never into an unauthenticated path.
function ensureRevocationSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "owner_public_key")) {
    db.exec("ALTER TABLE agents ADD COLUMN owner_public_key TEXT");
  }
  if (!columns.some((column) => column.name === "revoked_at")) {
    db.exec("ALTER TABLE agents ADD COLUMN revoked_at TEXT");
  }
}

const UNIQUE_AGENT_NAME = "agents.name";
const UNIQUE_AGENT_PUBLIC_KEY = "agents.public_key";
const UNIQUE_SOURCE_NAME = "registered_sources.source_name";
// verified against node 24.10.0: a two-column unique constraint violates with
// exactly this comma separated index string in the message.
const UNIQUE_IDEMPOTENCY = "attestations.agent_id, attestations.idempotency_key";
const FK_VIOLATION_MESSAGE = "FOREIGN KEY constraint failed";

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 1000;

// narrows to the concrete failure node:sqlite throws on constraint
// violations. the code and message shapes were verified against node
// 24.10.0 before this mapping was written.
function isSqliteError(err: unknown): err is Error {
  return err instanceof Error && (err as { code?: unknown }).code === "ERR_SQLITE_ERROR";
}

function isUniqueViolation(err: unknown, index: string): boolean {
  return isSqliteError(err) && err.message === `UNIQUE constraint failed: ${index}`;
}

function isForeignKeyViolation(err: unknown): boolean {
  return isSqliteError(err) && err.message === FK_VIOLATION_MESSAGE;
}

// builds an error carrying the machine readable code callers branch on, see
// the contract comment at the top of the file.
function codedError(code: string, message: string, cause: unknown): Error {
  const err = new Error(message, { cause });
  (err as { code?: string }).code = code;
  return err;
}

// runtime backstop for the structural guarantee in types/identity.ts: an
// AgentRecord cannot contain a private key by type, but a caller casting an
// AgentIdentity into an AgentRecord would defeat the type system. key
// material must never reach the disk, so this throws before any sql runs.
// the backstop covers both the identity private key and the higher-value
// owner private key; the structural type forbids both already.
function assertNoPrivateKey(record: AgentRecord): void {
  if (record !== null && typeof record === "object" && ("privateKey" in record || "ownerPrivateKey" in record)) {
    throw new Error("refusing to persist an agent record that carries a private key");
  }
}

// rows come back from node:sqlite as plain records whose values cannot
// express the domain types. these accessors translate with shape checks so
// a corrupt or unexpected row fails loudly instead of shipping a mangled
// record upstream.
type SqlRow = Record<string, SQLOutputValue>;

function col(row: SqlRow, name: string): SQLOutputValue {
  const value = row[name];
  if (value === undefined) throw new Error(`stored row is missing column ${name}`);
  return value;
}

function str(row: SqlRow, name: string): string {
  const value = col(row, name);
  if (typeof value !== "string") throw new Error(`stored row column ${name} is not text`);
  return value;
}

function num(row: SqlRow, name: string): number {
  const value = col(row, name);
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new Error(`stored row column ${name} is not numeric`);
  }
  return Number(value);
}

function nullableStr(row: SqlRow, name: string): string | null {
  const value = col(row, name);
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`stored row column ${name} is not text`);
  return value;
}

function jsonArrayField(row: SqlRow, name: string, label: string): string[] {
  const raw = str(row, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`stored row has unreadable json in ${label}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`stored row column ${label} is not a json array of strings`);
  }
  return parsed;
}

function parseToolsUsed(row: SqlRow): ToolCall[] {
  const raw = str(row, "toolsUsed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`stored row has unreadable json in tools_used: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) throw new Error("stored row column tools_used is not a json array");
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || typeof (item as { tool?: unknown }).tool !== "string") {
      throw new Error("stored row column tools_used contains a malformed tool call");
    }
  }
  return parsed as ToolCall[];
}

function normalizeLimit(limit: number | undefined): number {
  // strict validation before any sql runs. a caller passing NaN, decimals,
  // or negatives is a bug that must not silently become a different query.
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`pagination limit must be a positive integer, got ${limit}`);
  }
  if (limit > MAX_PAGE_LIMIT) {
    throw new RangeError(`pagination limit cannot exceed ${MAX_PAGE_LIMIT}, got ${limit}`);
  }
  return limit;
}

function parseCursor(cursor: string): number {
  // the cursor is an opaque token by contract, encoded here as the decimal
  // row_id of the last row of the previous page. strict shape validation
  // keeps garbage out of sql and out of the row_id comparison.
  if (!/^[0-9]+$/.test(cursor)) {
    throw new RangeError(`pagination cursor must be a non-negative integer, got ${cursor}`);
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`pagination cursor out of range: ${cursor}`);
  }
  return value;
}

// the four SELECT lists, shared so read aliasing cannot drift per method.
const AGENT_COLUMNS = `
  row_id AS rowId,
  name,
  public_key AS publicKey,
  owner_public_key AS ownerPublicKey,
  memory_pointer AS memoryPointer,
  permissions,
  created_at AS createdAt,
  manifest_version AS manifestVersion,
  signature,
  revoked_at AS revokedAt
`;

const ATTESTATION_COLUMNS = `
  row_id AS rowId,
  id,
  agent_id AS agentId,
  task,
  output,
  tools_used AS toolsUsed,
  source,
  content_hash AS contentHash,
  signature,
  signed_by AS signedBy,
  timestamp,
  schema_version AS schemaVersion
`;

class SqliteStorageAdapter implements StorageAdapter {
  constructor(private readonly db: DatabaseSync) {}

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
    // rows are keyed by the canonical id, which per types/identity.ts equals
    // the public key. not-found returns null, never throws.
    const row = this.db.prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE public_key = ?`).get(agentId);
    return row ? recordFromRow(row) : null;
  }

  async getAgentByName(name: string): Promise<AgentRecord | null> {
    // deliberately an optimistic read: uniqueness is enforced by the schema
    // constraint on save, never by checking here first (see the contract
    // comment in types/storage.ts).
    const row = this.db.prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE name = ?`).get(name);
    return row ? recordFromRow(row) : null;
  }

  async revokeAgent(agentId: AgentId, revokedAt: string): Promise<void> {
    // the actual revocation write. note what this method does NOT do: it does
    // not verify any signature. sdk-level revokeAgent() has already checked
    // the owner-key authorization and the replay window before calling here;
    // storage is deliberately dumb so there is exactly one enforcement point.
    const result = this.db.prepare("UPDATE agents SET revoked_at = ? WHERE public_key = ?").run(revokedAt, agentId);
    // a missing row surfaces the same way the attestation foreign key does:
    // the caller already looked the agent up, so zero rows changed means
    // something raced or the lookup lied, never a silent success.
    // Number() normalizes sqlite's number-or-bigint changes return.
    if (Number(result.changes) === 0) {
      throw codedError("AGENT_NOT_FOUND", `cannot revoke unknown agent: ${agentId}`, new Error("no matching row"));
    }
  }

  async saveAgent(record: AgentRecord): Promise<void> {
    assertNoPrivateKey(record);
    try {
      this.db
        .prepare(
          `INSERT INTO agents (name, public_key, owner_public_key, memory_pointer, permissions, created_at, manifest_version, signature, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.name,
          record.publicKey,
          record.ownerPublicKey,
          record.memoryPointer,
          JSON.stringify(record.permissions),
          record.createdAt,
          record.manifestVersion,
          record.signature,
          record.revokedAt,
        );
    } catch (err) {
      // the schema unique constraint on agents.name is the authoritative
      // uniqueness guard. a violation here means a caller name or a
      // concurrent create collided and must surface as exactly
      // DUPLICATE_NAME per the storage contract, which is what createAgent
      // branches on for its retry loop.
      if (isUniqueViolation(err, UNIQUE_AGENT_NAME)) {
        throw codedError("DUPLICATE_NAME", `agent name already exists: ${record.name}`, err);
      }
      // a fresh public key colliding with an existing row is either
      // corruption or astronomically unlikely keygen output. it is never a
      // name conflict and never a generic disk failure, so it gets its own
      // code instead of being miscategorized into the retryable path.
      if (isUniqueViolation(err, UNIQUE_AGENT_PUBLIC_KEY)) {
        throw codedError("DUPLICATE_PUBLIC_KEY", `agent public key already exists: ${record.publicKey}`, err);
      }
      // any other failure (disk full, locked db, ...) propagates distinctly
      // as the raw node:sqlite error. callers treat it as a generic storage
      // failure and never as a retryable name conflict.
      throw err;
    }
  }

  async getAttestations(agentId: AgentId, pagination: PaginationParams = {}): Promise<Paginated<AttestationRecord>> {
    const limit = normalizeLimit(pagination.limit);
    const cursor = pagination.cursor === undefined ? null : parseCursor(pagination.cursor);

    // cursor pagination on the immutable, monotonic row_id. ordering is
    // newest first, and the next page filters row_id < cursor, so rows
    // inserted between page loads (higher row_id) can never shift or
    // duplicate an already returned page.
    const base = `SELECT ${ATTESTATION_COLUMNS} FROM attestations WHERE agent_id = ?`;
    const rows =
      cursor === null
        ? this.db.prepare(`${base} ORDER BY row_id DESC LIMIT ?`).all(agentId, limit)
        : this.db.prepare(`${base} AND row_id < ? ORDER BY row_id DESC LIMIT ?`).all(agentId, cursor, limit);
    const items = rows.map(attestationFromRow);
    const nextCursor = items.length === limit && items.length > 0 ? String(items[items.length - 1].rowId) : null;
    return { items, nextCursor };
  }

  async getAttestationByIdempotencyKey(agentId: AgentId, idempotencyKey: string): Promise<AttestationRecord | null> {
    // deliberately an optimistic read: dedup is enforced by the composite
    // unique index on save, never by checking here first (see the contract
    // comment in types/storage.ts). not-found returns null, never throws.
    const row = this.db
      .prepare(`SELECT ${ATTESTATION_COLUMNS} FROM attestations WHERE agent_id = ? AND idempotency_key = ?`)
      .get(agentId, idempotencyKey);
    return row ? attestationFromRow(row) : null;
  }

  async saveAttestation(record: AttestationRecord): Promise<void> {
    try {
      this.db
        .prepare(
          `INSERT INTO attestations
             (id, agent_id, idempotency_key, task, output, tools_used, source, content_hash, signature, signed_by, timestamp, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.agentId,
          record.idempotencyKey ?? null,
          record.task,
          record.output,
          JSON.stringify(record.toolsUsed),
          record.source,
          record.contentHash,
          record.signature,
          record.signedBy,
          record.timestamp,
          record.schemaVersion,
        );
    } catch (err) {
      // the foreign key constraint is the schema level guarantee that an
      // attestation never references a nonexistent agent. translating the
      // violation into AGENT_NOT_FOUND keeps every failure mode machine
      // readable for the caller instead of leaking a raw sqlite error.
      if (isForeignKeyViolation(err)) {
        throw codedError("AGENT_NOT_FOUND", `cannot save attestation for unknown agent: ${record.agentId}`, err);
      }
      // the composite unique index is the authoritative dedup guard for
      // attest()'s idempotency race. a violation means a concurrent call
      // with the same (agent, key) won the insert, and attest() must
      // fetch-and-return the existing record, not treat this as a generic
      // failure. NULL keys never reach this branch because sqlite treats
      // NULLs as distinct in unique indexes.
      if (isUniqueViolation(err, UNIQUE_IDEMPOTENCY)) {
        throw codedError(
          "DUPLICATE_IDEMPOTENCY_KEY",
          `attestation already exists for agent ${record.agentId} with this idempotency key`,
          err,
        );
      }
      // a duplicate attestation id propagates as the raw sqlite unique error
      // for now. whether retries collapse into one attestation is a decision
      // for the attest() implementation pass, not for the storage layer.
      throw err;
    }
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    const rows = this.db
      .prepare(
        `SELECT source_name AS sourceName, registered_at AS registeredAt, trust_weight AS trustWeight
         FROM registered_sources ORDER BY source_name ASC`,
      )
      .all();
    return rows.map((row) => ({
      sourceName: str(row, "sourceName"),
      registeredAt: str(row, "registeredAt"),
      trustWeight: num(row, "trustWeight"),
    }));
  }

  async saveRegisteredSource(source: RegisteredSource): Promise<void> {
    try {
      this.db
        .prepare(`INSERT INTO registered_sources (source_name, registered_at, trust_weight) VALUES (?, ?, ?)`)
        .run(source.sourceName, source.registeredAt, source.trustWeight);
    } catch (err) {
      // a registered source is keyed by its own name and ingested records
      // hang off it, so a duplicate is a real caller-visible failure with
      // its own code, never a retry hint and never a generic disk error.
      if (isUniqueViolation(err, UNIQUE_SOURCE_NAME)) {
        throw codedError("DUPLICATE_SOURCE_NAME", `source name already registered: ${source.sourceName}`, err);
      }
      throw err;
    }
  }
}

function recordFromRow(row: SqlRow): AgentRecord {
  return {
    rowId: num(row, "rowId"),
    name: str(row, "name"),
    publicKey: str(row, "publicKey"),
    // null on legacy rows: those agents have no owner key, and the sdk layer
    // must fail closed on them, never fabricate an authorization path.
    ownerPublicKey: nullableStr(row, "ownerPublicKey"),
    memoryPointer: nullableStr(row, "memoryPointer"),
    permissions: jsonArrayField(row, "permissions", "permissions") as AgentPermission[],
    createdAt: str(row, "createdAt"),
    manifestVersion: num(row, "manifestVersion"),
    signature: str(row, "signature"),
    // null means not revoked; sqlite never stores an empty string here.
    revokedAt: nullableStr(row, "revokedAt"),
  };
}

function attestationFromRow(row: SqlRow): AttestationRecord {
  return {
    rowId: num(row, "rowId"),
    id: str(row, "id"),
    agentId: str(row, "agentId"),
    task: str(row, "task"),
    output: str(row, "output"),
    toolsUsed: parseToolsUsed(row),
    source: str(row, "source"),
    contentHash: str(row, "contentHash"),
    signature: str(row, "signature"),
    signedBy: str(row, "signedBy"),
    timestamp: str(row, "timestamp"),
    schemaVersion: num(row, "schemaVersion"),
  };
}

// direct construction, always opens a fresh connection and a fresh file (or
// a fresh in-memory database for ":memory:"). tests use this so every test
// gets complete isolation.
export function createSqliteStorage(databasePath: string): StorageAdapter {
  let db: DatabaseSync;
  try {
    // enableForeignKeyConstraints is set explicitly even though node:sqlite
    // currently defaults it on, so enforcement never depends on a default
    // value changing under us. busy_timeout keeps concurrent file access
    // from failing instantly under the cli.
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(SCHEMA);
    db.exec(ATTESTATIONS_BY_AGENT_INDEX);
    ensureIdempotencySchema(db);
    ensureRevocationSchema(db);
  } catch (err) {
    // fail loudly at construction: a database that cannot open or bootstrap
    // surfaces immediately, never lazily on the first call. the adapter
    // never silently falls back to anything else.
    throw new Error(`failed to open sqlite database at ${databasePath}: ${(err as Error).message}`, { cause: err });
  }
  return new SqliteStorageAdapter(db);
}

// memoized access point for application code: one open connection per path
// per process, as advertised in the design. a new connection per call would
// be a waste and could surface stale behavior on the same file.
const openConnections = new Map<string, StorageAdapter>();

export function getSqliteStorage(databasePath: string): StorageAdapter {
  let adapter = openConnections.get(databasePath);
  if (adapter === undefined) {
    adapter = createSqliteStorage(databasePath);
    openConnections.set(databasePath, adapter);
  }
  return adapter;
}