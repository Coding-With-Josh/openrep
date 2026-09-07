// libsql storage adapter, the second concrete persistence layer behind
// StorageAdapter, alongside sqlite.ts. uses the official @libsql/client
// library (pinned to 0.17.4), which speaks both the embedded local dialect
// (":memory:", "file:...") and the hosted libsql/Turso wire protocol
// ("libsql://...", "https://..."), so one adapter serves both backends. the
// sdk has no native dependency: @libsql/client is pure js on the remote
// path and uses a bundled native binding only for embedded files.
//
// design decisions, each tied to the empirical B1 spike run against the
// real hosted database (libsql://openrep-josh-scriptz.aws-us-east-2.turso.io)
// and the local embedded engine, both on @libsql/client 0.17.4:
// - foreign keys are ON by default in libsql (PRAGMA foreign_keys reads 1
//   on both engines), but the adapter still sets PRAGMA foreign_keys = ON
//   at bootstrap and reads it back to assert 1, so enforcement never
//   depends on a default changing under us. saving an attestation for a
//   nonexistent agent fails at the schema level and surfaces as
//   AGENT_NOT_FOUND. this is the load bearing guard against orphaned
//   attestation rows.
// - the pragma persists across separate execute() calls on one client
//   (verified: PRAGMA OFF then a bogus insert lands, PRAGMA ON then the
//   same insert throws), so bootstrap-time enforcement covers every later
//   statement on that client.
// - client.batch([...], "deferred") is the schema bootstrap mechanism.
//   executeMultiple() was probed and returns undefined on the local
//   engine, so it is never used here.
// - execute() must never be handed a multi-statement string: probing
//   showed @libsql/client runs BOTH statements in one call (unlike
//   node:sqlite which rejects them), so a splicing bug would silently
//   execute two statements. every call in this adapter is exactly one
//   statement.
// - error classification is message based, never extendedCode based.
//   the hosted engine does not populate extendedCode (undefined), and its
//   message text is "SQLITE_CONSTRAINT: SQLite error: UNIQUE constraint
//   failed: agents.name" while the local engine says "SQLITE_CONSTRAINT:
//   UNIQUE constraint failed: agents.name". both contain the same static
//   index strings, and libsql produces those strings from schema
//   constraint names, never from caller supplied values, so substring
//   matching cannot be spoofed by user data (same invariant as sqlite.ts).
// - lastInsertRowid is a bigint in @libsql/client. this adapter never
//   serializes it; pagination reads row_id back through SELECT. integers
//   beyond Number.MAX_SAFE_INTEGER make the driver throw a RangeError,
//   which is acceptable: this schema stores no such values.
//
// serverless lifecycle (per the storage design review): there is no
// memoized connection here, unlike sqlite.ts. a serverless function that
// holds a connection across invocations would pin a socket that may die
// between requests; instead the caller creates one client per invocation
// via createLibsqlStorage, uses it, and closes it (LibsqlStorageAdapter
// exposes close()). the libsql:// scheme keeps a persistent websocket for
// long lived server processes; https:// is the documented swap for
// cold-start sensitive edge deployments.
//
// error contract: identical to sqlite.ts. saveAgent throws DUPLICATE_NAME
// / DUPLICATE_PUBLIC_KEY on the schema unique violations, saveAttestation
// throws AGENT_NOT_FOUND on the foreign key violation and
// DUPLICATE_IDEMPOTENCY_KEY on the composite index, saveRegisteredSource
// throws DUPLICATE_SOURCE_NAME. every other failure propagates as the raw
// libsql error so a network or server failure is never miscategorized as a
// constraint conflict. read paths never throw for not-found, they return
// null.
import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
import type { ToolCall, ExternalVerification } from "../types/attestation.js";
import type { AgentPermission } from "../types/identity.js";
import type { AgentId } from "../types/identity.js";
import type { KeyRotationRecord } from "../types/identity.js";
import type { AgentRecord, AttestationRecord, Paginated, PaginationParams, StorageAdapter } from "../types/storage.js";
import type { RegisteredSource } from "../types/sources.js";

// the connection config for one libsql storage adapter instance. the
// authToken is held only in this object and in the client, never logged,
// never serialized into errors, and it is absent for local embedded
// databases (":memory:" / "file:...").
export interface LibsqlStorageConfig {
  url: string; // "libsql://...", "https://...", "file:...", or ":memory:"
  authToken?: string;
}

// schema bootstrap, identical in effect to sqlite.ts's SCHEMA string but
// split into statements because client.batch() (the verified bootstrap
// mechanism) takes an array. idempotent by design: the moment real user
// data exists anywhere a numbered migration strategy becomes warranted.
// the unique constraint on agents.name is the authoritative uniqueness
// guard and the foreign key on attestations.agent_id the referential
// integrity guard, exactly as in sqlite.ts.
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS agents (
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
);`,
  `CREATE TABLE IF NOT EXISTS attestations (
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
  external_verification TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(public_key)
);`,
  `CREATE TABLE IF NOT EXISTS registered_sources (
  source_name TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  trust_weight REAL NOT NULL
);`,
  `CREATE INDEX IF NOT EXISTS idx_attestations_agent_id ON attestations (agent_id);`,
  // rotation lineage audit table, identical to sqlite.ts: both ends foreign
  // key to agents(public_key), written with the successor agent inside ONE
  // "write" batch transaction in rotateAgent below. new in this pass, so
  // fresh and legacy databases both get it from this CREATE, no ALTER.
  `CREATE TABLE IF NOT EXISTS key_rotations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_public_key TEXT NOT NULL,
  new_public_key TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  signature TEXT NOT NULL,
  FOREIGN KEY (old_public_key) REFERENCES agents(public_key),
  FOREIGN KEY (new_public_key) REFERENCES agents(public_key)
);`,
  `CREATE INDEX IF NOT EXISTS idx_key_rotations_old ON key_rotations (old_public_key);`,
  `CREATE INDEX IF NOT EXISTS idx_key_rotations_new ON key_rotations (new_public_key);`,
];

// idempotency dedup, revocation columns, and external verification
// provenance: same guarded ALTER pattern as sqlite.ts because neither
// engine has ADD COLUMN IF NOT EXISTS. the composite unique index on
// (agent_id, idempotency_key) is the authoritative guard for attest()'s
// idempotency race: NULL keys stay unbounded because sqlite treats NULLs
// as distinct in unique indexes.

// returns the column names of a table. the table name is always a static
// constant from this module (never caller input), so string interpolation
// here cannot inject anything.
async function tableColumns(client: Client, table: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${table})`);
  return result.rows.map((row) => {
    const value = row["name"];
    if (typeof value !== "string") throw new Error(`PRAGMA table_info(${table}) returned a malformed name column`);
    return value;
  });
}

async function ensureIdempotencySchema(client: Client): Promise<void> {
  const columns = await tableColumns(client, "attestations");
  if (!columns.includes("idempotency_key")) {
    await client.execute("ALTER TABLE attestations ADD COLUMN idempotency_key TEXT");
  }
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_attestations_idempotency ON attestations (agent_id, idempotency_key)");
}

async function ensureRevocationSchema(client: Client): Promise<void> {
  const columns = await tableColumns(client, "agents");
  if (!columns.includes("owner_public_key")) {
    await client.execute("ALTER TABLE agents ADD COLUMN owner_public_key TEXT");
  }
  if (!columns.includes("revoked_at")) {
    await client.execute("ALTER TABLE agents ADD COLUMN revoked_at TEXT");
  }
}

async function ensureExternalVerificationSchema(client: Client): Promise<void> {
  const columns = await tableColumns(client, "attestations");
  if (!columns.includes("external_verification")) {
    await client.execute("ALTER TABLE attestations ADD COLUMN external_verification TEXT");
  }
}

// one shared bootstrap so createLibsqlStorage cannot forget a guard.
async function bootstrap(client: Client, url: string): Promise<void> {
  try {
    // explicit foreign key enforcement + readback assert, so even a future
    // libsql that defaults enforcement off cannot silently orphan
    // attestation rows under this adapter.
    await client.execute("PRAGMA foreign_keys = ON");
    const fk = await client.execute("PRAGMA foreign_keys");
    const fkValue = fk.rows[0]?.["foreign_keys"];
    if (Number(fkValue) !== 1) {
      throw new Error("PRAGMA foreign_keys did not report 1 after enabling; refusing to boot a store that may orphan attestations");
    }
    // WAL journal mode on embedded file databases, the same cross-process
    // hardening as sqlite.ts: in delete mode a writer takes an exclusive
    // lock and blocks every reader. the mode is a persistent file property
    // (spike verified on the embedded engine), so the readback assert
    // covers every later connection to the file, cli style. hosted
    // databases (libsql:// and https://) are a network server where WAL is
    // configured server side, deliberately skipped; :memory: cannot be WAL
    // and the engine reports "memory", so only file: prefixes set it.
    if (url.startsWith("file:")) {
      await client.execute("PRAGMA journal_mode = WAL");
      const journal = await client.execute("PRAGMA journal_mode");
      const journalValue = journal.rows[0]?.["journal_mode"];
      if (journalValue !== "wal") {
        throw new Error("PRAGMA journal_mode did not report wal after enabling; refusing to boot a store that blocks readers");
      }
      // WAL crash-safety with NORMAL is the canonical combination (same
      // rationale and caveat as sqlite.ts); per-connection like busy_timeout
      // and foreign_keys, so the readback assert above is the load bearing
      // check and this line is the durability tuning for this connection.
      await client.execute("PRAGMA synchronous = NORMAL");
    }
    // schema bootstrap verified against both engines in the B1 spike.
    await client.batch([...SCHEMA_STATEMENTS], "deferred");
    await ensureIdempotencySchema(client);
    await ensureRevocationSchema(client);
    await ensureExternalVerificationSchema(client);
  } catch (err) {
    // fail loudly at construction, exactly like sqlite.ts: a database that
    // cannot bootstrap surfaces immediately, never lazily on first use,
    // and never falls back to anything else. the error must not include
    // the auth token; the url is safe to report.
    throw new Error(`failed to bootstrap libsql database: ${(err as Error).message}`, { cause: err });
  }
}

const UNIQUE_AGENT_NAME = "agents.name";
const UNIQUE_AGENT_PUBLIC_KEY = "agents.public_key";
const UNIQUE_SOURCE_NAME = "registered_sources.source_name";
// verified in the B1 spike against both engines: the two-column unique
// constraint violates with exactly this comma separated index string in
// the message, prefixed by the engine's error envelope.
const UNIQUE_IDEMPOTENCY = "attestations.agent_id, attestations.idempotency_key";
const FK_VIOLATION_MESSAGE = "FOREIGN KEY constraint failed";

// the agent insert shared by saveAgent and rotateAgent, so the two write
// paths cannot drift about the column set or the parameter order. positional
// parameters only, precisely like every other statement in this adapter.
const INSERT_AGENT_SQL = `INSERT INTO agents (name, public_key, owner_public_key, memory_pointer, permissions, created_at, manifest_version, signature, revoked_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function agentRecordArgs(record: AgentRecord): Array<string | number | null> {
  return [
    record.name,
    record.publicKey,
    record.ownerPublicKey,
    record.memoryPointer,
    JSON.stringify(record.permissions),
    record.createdAt,
    record.manifestVersion,
    record.signature,
    record.revokedAt,
  ];
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 1000;

// narrows to the libsql failure family that all schema constraints surface
// through. code is "SQLITE_CONSTRAINT" on both engines; extendedCode is
// NOT used because the hosted engine leaves it undefined (spike finding).
function isConstraintError(err: unknown): err is Error {
  return err instanceof Error && (err as { code?: unknown }).code === "SQLITE_CONSTRAINT";
}

function isUniqueViolation(err: unknown, index: string): boolean {
  // message based, never extendedCode based: the hosted engine reports
  // "SQLITE_CONSTRAINT: SQLite error: UNIQUE constraint failed: agents.name"
  // and the local engine "SQLITE_CONSTRAINT: UNIQUE constraint failed:
  // agents.name". the index string is produced by libsql from the schema
  // constraint, never from caller data, so this cannot be spoofed.
  return isConstraintError(err) && err.message.includes(`UNIQUE constraint failed: ${index}`);
}

function isForeignKeyViolation(err: unknown): boolean {
  return isConstraintError(err) && err.message.includes(FK_VIOLATION_MESSAGE);
}

// builds an error carrying the machine readable code callers branch on,
// identical to sqlite.ts's contract.
function codedError(code: string, message: string, cause: unknown): Error {
  const err = new Error(message, { cause });
  (err as { code?: string }).code = code;
  return err;
}

// runtime backstop for the structural guarantee in types/identity.ts,
// replicated verbatim from sqlite.ts: key material must never reach the
// store, so this throws before any sql runs, per adapter.
function assertNoPrivateKey(record: AgentRecord): void {
  if (record !== null && typeof record === "object" && ("privateKey" in record || "ownerPrivateKey" in record)) {
    throw new Error("refusing to persist an agent record that carries a private key");
  }
}

// rows come back from @libsql/client as plain objects whose values cannot
// express the domain types. these accessors translate with shape checks so
// a corrupt or unexpected row fails loudly instead of shipping a mangled
// record upstream, mirroring sqlite.ts.
type SqlRow = Row;

function col(row: SqlRow, name: string): unknown {
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

function parseExternalVerification(row: SqlRow): ExternalVerification | null {
  const raw = nullableStr(row, "externalVerification");
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`stored row has unreadable json in external_verification: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("stored row column external_verification is not a json object");
  }
  const value = parsed as { checked?: unknown; valid?: unknown; reason?: unknown };
  if (typeof value.checked !== "boolean") {
    throw new Error("stored row column external_verification has a malformed checked field");
  }
  if (value.valid !== null && typeof value.valid !== "boolean") {
    throw new Error("stored row column external_verification has a malformed valid field");
  }
  if (value.reason !== null && typeof value.reason !== "string") {
    throw new Error("stored row column external_verification has a malformed reason field");
  }
  return { checked: value.checked, valid: value.valid, reason: value.reason };
}

function normalizeLimit(limit: number | undefined): number {
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
// identical to sqlite.ts.
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
  schema_version AS schemaVersion,
  external_verification AS externalVerification
`;

export class LibsqlStorageAdapter implements StorageAdapter {
  constructor(private readonly client: Client) {}

  // request scoped lifecycle: call at the end of the invocation that
  // created the adapter. not part of StorageAdapter; application code
  // holding the concrete type uses it, and the interface keeps working
  // for code that only needs the storage contract.
  async close(): Promise<void> {
    await this.client.close();
  }

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
    // rows are keyed by the canonical id, which per types/identity.ts equals
    // the public key. not-found returns null, never throws.
    const result = await this.client.execute({
      sql: `SELECT ${AGENT_COLUMNS} FROM agents WHERE public_key = ?`,
      args: [agentId],
    });
    return result.rows.length > 0 ? recordFromRow(result.rows[0]) : null;
  }

  async getAgentByName(name: string): Promise<AgentRecord | null> {
    // deliberately an optimistic read: uniqueness is enforced by the schema
    // constraint on save, never by checking here first.
    const result = await this.client.execute({
      sql: `SELECT ${AGENT_COLUMNS} FROM agents WHERE name = ?`,
      args: [name],
    });
    return result.rows.length > 0 ? recordFromRow(result.rows[0]) : null;
  }

  async revokeAgent(agentId: AgentId, revokedAt: string): Promise<void> {
    // storage is deliberately dumb: sdk-level revokeAgent() has already
    // checked owner-key authorization and replay window before calling here.
    const result = await this.client.execute({
      sql: "UPDATE agents SET revoked_at = ? WHERE public_key = ?",
      args: [revokedAt, agentId],
    });
    // zero rows changed means the lookup lied or the agent vanished mid
    // flight; never a silent success. rowsAffected is a number in libsql.
    if (result.rowsAffected === 0) {
      throw codedError("AGENT_NOT_FOUND", `cannot revoke unknown agent: ${agentId}`, new Error("no matching row"));
    }
  }

  async saveAgent(record: AgentRecord): Promise<void> {
    assertNoPrivateKey(record);
    try {
      await this.client.execute({ sql: INSERT_AGENT_SQL, args: agentRecordArgs(record) });
    } catch (err) {
      // schema unique constraint on agents.name is the authoritative guard
      // for createAgent's concurrent-create retry loop.
      if (isUniqueViolation(err, UNIQUE_AGENT_NAME)) {
        throw codedError("DUPLICATE_NAME", `agent name already exists: ${record.name}`, err);
      }
      if (isUniqueViolation(err, UNIQUE_AGENT_PUBLIC_KEY)) {
        throw codedError("DUPLICATE_PUBLIC_KEY", `agent public key already exists: ${record.publicKey}`, err);
      }
      // any other failure (network, server error, other constraint)
      // propagates as the raw libsql error; callers treat it as a generic
      // storage failure, never as a retryable name conflict.
      throw err;
    }
  }

  async rotateAgent(record: AgentRecord, rotation: KeyRotationRecord): Promise<void> {
    assertNoPrivateKey(record);
    try {
      // one "write" batch IS one transaction on both engines: the successor
      // agents row and its key_rotations audit row commit or roll back
      // together, so a partial rotation (new identity with no lineage, or a
      // lineage pointing at nothing) cannot be observed (adversarial
      // review: partial write / state injection). the agent insert comes
      // first so the audit row's foreign keys resolve inside the batch.
      await this.client.batch(
        [
          { sql: INSERT_AGENT_SQL, args: agentRecordArgs(record) },
          {
            sql: `INSERT INTO key_rotations (old_public_key, new_public_key, signed_by, timestamp, signature)
                  VALUES (?, ?, ?, ?, ?)`,
            args: [
              rotation.oldPublicKey,
              rotation.newPublicKey,
              rotation.signedBy,
              rotation.timestamp,
              rotation.signature,
            ],
          },
        ],
        "write",
      );
    } catch (err) {
      // same classification as saveAgent: the name constraint is what the
      // sdk's retry loop branches on, a public key collision is corruption,
      // and everything else is a generic storage failure.
      if (isUniqueViolation(err, UNIQUE_AGENT_NAME)) {
        throw codedError("DUPLICATE_NAME", `agent name already exists: ${record.name}`, err);
      }
      if (isUniqueViolation(err, UNIQUE_AGENT_PUBLIC_KEY)) {
        throw codedError("DUPLICATE_PUBLIC_KEY", `agent public key already exists: ${record.publicKey}`, err);
      }
      throw err;
    }
  }

  async getKeyRotations(agentId: AgentId): Promise<KeyRotationRecord[]> {
    // audit lineage lookup on either end of the lineage, newest first.
    const result = await this.client.execute({
      sql: `SELECT old_public_key AS oldPublicKey, new_public_key AS newPublicKey, signed_by AS signedBy, timestamp, signature
            FROM key_rotations WHERE old_public_key = ? OR new_public_key = ? ORDER BY row_id DESC`,
      args: [agentId, agentId],
    });
    return result.rows.map((row) => ({
      oldPublicKey: str(row, "oldPublicKey"),
      newPublicKey: str(row, "newPublicKey"),
      signedBy: str(row, "signedBy"),
      timestamp: str(row, "timestamp"),
      signature: str(row, "signature"),
    }));
  }

  async getAttestations(agentId: AgentId, pagination: PaginationParams = {}): Promise<Paginated<AttestationRecord>> {
    const limit = normalizeLimit(pagination.limit);
    const cursor = pagination.cursor === undefined ? null : parseCursor(pagination.cursor);

    // cursor pagination on the immutable, monotonic row_id. ordering newest
    // first, next page filters row_id < cursor, so rows inserted between
    // page loads can never shift or duplicate an already returned page.
    const base = `SELECT ${ATTESTATION_COLUMNS} FROM attestations WHERE agent_id = ?`;
    const statement: InStatement =
      cursor === null
        ? { sql: `${base} ORDER BY row_id DESC LIMIT ?`, args: [agentId, limit] }
        : { sql: `${base} AND row_id < ? ORDER BY row_id DESC LIMIT ?`, args: [agentId, cursor, limit] };
    const result = await this.client.execute(statement);
    const items = result.rows.map(attestationFromRow);
    const nextCursor = items.length === limit && items.length > 0 ? String(items[items.length - 1].rowId) : null;
    return { items, nextCursor };
  }

  async getAttestationByIdempotencyKey(agentId: AgentId, idempotencyKey: string): Promise<AttestationRecord | null> {
    // optimistic read: dedup is enforced by the composite unique index on
    // save, never by checking here first.
    const result = await this.client.execute({
      sql: `SELECT ${ATTESTATION_COLUMNS} FROM attestations WHERE agent_id = ? AND idempotency_key = ?`,
      args: [agentId, idempotencyKey],
    });
    return result.rows.length > 0 ? attestationFromRow(result.rows[0]) : null;
  }

  async saveAttestation(record: AttestationRecord): Promise<void> {
    try {
      await this.client.execute({
        sql: `INSERT INTO attestations
                (id, agent_id, idempotency_key, task, output, tools_used, source, content_hash, signature, signed_by, timestamp, schema_version, external_verification)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
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
          record.externalVerification === undefined || record.externalVerification === null
            ? null
            : JSON.stringify(record.externalVerification),
        ],
      });
    } catch (err) {
      // the foreign key constraint is the schema level guarantee that an
      // attestation never references a nonexistent agent. enforcement is the
      // bootstrap-time pragma (B1 verified it persists per client).
      if (isForeignKeyViolation(err)) {
        throw codedError("AGENT_NOT_FOUND", `cannot save attestation for unknown agent: ${record.agentId}`, err);
      }
      // composite unique index fires on a concurrent attest() with the same
      // (agent, key); attest() resolves it by fetch-and-return. NULL keys
      // never reach this branch (sqlite treats NULLs as distinct).
      if (isUniqueViolation(err, UNIQUE_IDEMPOTENCY)) {
        throw codedError(
          "DUPLICATE_IDEMPOTENCY_KEY",
          `attestation already exists for agent ${record.agentId} with this idempotency key`,
          err,
        );
      }
      throw err;
    }
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    const result = await this.client.execute({
      sql: `SELECT source_name AS sourceName, registered_at AS registeredAt, trust_weight AS trustWeight
            FROM registered_sources ORDER BY source_name ASC`,
    });
    return result.rows.map((row) => ({
      sourceName: str(row, "sourceName"),
      registeredAt: str(row, "registeredAt"),
      trustWeight: num(row, "trustWeight"),
    }));
  }

  async saveRegisteredSource(source: RegisteredSource): Promise<void> {
    try {
      await this.client.execute({
        sql: "INSERT INTO registered_sources (source_name, registered_at, trust_weight) VALUES (?, ?, ?)",
        args: [source.sourceName, source.registeredAt, source.trustWeight],
      });
    } catch (err) {
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
    ownerPublicKey: nullableStr(row, "ownerPublicKey"),
    memoryPointer: nullableStr(row, "memoryPointer"),
    permissions: jsonArrayField(row, "permissions", "permissions") as AgentPermission[],
    createdAt: str(row, "createdAt"),
    manifestVersion: num(row, "manifestVersion"),
    signature: str(row, "signature"),
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
    externalVerification: parseExternalVerification(row),
  };
}

// direct construction: opens one client and bootstraps the schema on it.
// async because a hosted client bootstraps over the network (the sqlite
// adapter is sync because it opens a local file). every caller that needs
// the adapter for a request scope must await this and close() the result
// at the end of the request. no module level memoization: a serverless
// function creates one client per invocation.
export async function createLibsqlStorage(config: LibsqlStorageConfig): Promise<LibsqlStorageAdapter> {
  const client = createClient({ url: config.url, authToken: config.authToken });
  await bootstrap(client, config.url);
  return new LibsqlStorageAdapter(client);
}