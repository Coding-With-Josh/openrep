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
import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { ToolCall, ExternalVerification } from "../types/attestation.js";
import type { AgentPermission } from "../types/identity.js";
import type { AgentId } from "../types/identity.js";
import type { KeyRotationRecord } from "../types/identity.js";
import type { SessionKeyBackend, SessionKeyRow } from "../types/security.js";
import type {
  AccountLink,
  AgentRecord,
  AttestationRecord,
  ChatMessage,
  ChatMessageRecord,
  ChatRole,
  ChatSession,
  Paginated,
  PaginationParams,
  StorageAdapter,
  UserRecord,
} from "../types/storage.js";
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
  external_verification TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(public_key)
);

CREATE TABLE IF NOT EXISTS registered_sources (
  source_name TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  trust_weight REAL NOT NULL
);

-- rotation lineage audit table. both ends foreign key to agents(public_key)
-- so an audit row can never point at a nonexistent identity and the old
-- agent row can never be dropped while its lineage still names it. the two
-- writes (agents + key_rotations) happen in ONE transaction inside
-- rotateAgent below; the table is new in this pass so fresh and legacy
-- databases both get it from this CREATE, no ALTER is needed.
CREATE TABLE IF NOT EXISTS key_rotations (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  old_public_key TEXT NOT NULL,
  new_public_key TEXT NOT NULL,
  signed_by TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  signature TEXT NOT NULL,
  FOREIGN KEY (old_public_key) REFERENCES agents(public_key),
  FOREIGN KEY (new_public_key) REFERENCES agents(public_key)
);

-- web session key custody: encrypted envelopes only (never raw keys, the
-- SessionKeyRow type structurally cannot carry one), one row per
-- (agent_id, owner_user_id) pair, expiry persisted so a serverless cold
-- start cannot forget a live session. the agent foreign key keeps a session
-- row from ever naming a nonexistent identity; owner_user_id deliberately
-- has no foreign key because the ledger has no users table (single user
-- demo, ownership is a web-minted session id, and pair-scoped reads are the
-- enforcement, see the SessionKeyBackend contract in types/security.ts).
-- new in this pass, so fresh and legacy databases both get it from this
-- CREATE, no ALTER is needed.
CREATE TABLE IF NOT EXISTS session_keys (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at_epoch_ms INTEGER NOT NULL,
  UNIQUE (agent_id, owner_user_id),
  FOREIGN KEY (agent_id) REFERENCES agents(public_key)
);

-- web chat history: one session per (agent, owner) pair, and an append-only
-- message ledger hanging off it. the session id is storage generated
-- (randomUUID) and deliberately not part of any public addressing scheme:
-- every read and write resolves the (agent_id, owner_user_id) pair instead,
-- so an owner can never address another owner's conversation even if they
-- knew its id. the agent foreign key keeps a session from naming a
-- nonexistent identity; owner_user_id has no foreign key for the same
-- single-user-ledger reason as session_keys. new in this pass, so fresh and
-- legacy databases both get them from these CREATEs, no ALTER is needed.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, owner_user_id),
  FOREIGN KEY (agent_id) REFERENCES agents(public_key)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tools_used TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);

-- web account layer: one users row per real account, plus identity links.
-- these tables are web-owned (the storage adapter persists them, the web
-- auth layer owns the policy). email is globally unique so a duplicate
-- sign-in attempt always collides at insert; password_hash is NULL exactly
-- when the account is oauth-only, and the web layer must refuse any
-- password attempt against a NULL hash (no password claim on an oauth
-- account). accounts uniquely map one external identity
-- (provider, provider_account_id) to one user, so the same google sub can
-- never own two openrep accounts; the user_id foreign key keeps a link
-- from naming a nonexistent account. no ALTER path needed: the tables are
-- new in this pass, fresh and legacy databases both get them from CREATE.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_account_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`;

// the hand written indexes in the base schema. the unique and primary key
// constraints above already create indexes for agents.name, agents.public_key,
// attestations.id, and registered_sources.source_name, so these cover the
// lookups the constraints do not: paging attestations by agent, and the
// rotation audit lookup by either end of the lineage (old and new key are
// both queried, so each column gets its own index).
const ATTESTATIONS_BY_AGENT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_attestations_agent_id ON attestations (agent_id);
`;

const KEY_ROTATION_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_key_rotations_old ON key_rotations (old_public_key);
CREATE INDEX IF NOT EXISTS idx_key_rotations_new ON key_rotations (new_public_key);
`;

// chat message reads join on session_id and order by row_id. sqlite does not
// create an index for foreign key columns automatically, so without this the
// message lookup would scan the whole ledger per session; the index keeps a
// conversation read proportional to the conversation, not the database.
const CHAT_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages (session_id);
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

// external verification provenance: the external_verification column on
// attestations, carrying ingest()'s optional check metadata as json. fresh
// databases get the column from the CREATE TABLE above; pre-existing files
// (created before this pass) get it through the same guarded ALTER pattern.
// the column is nullable by design: native attestations and legacy rows have
// no external check, and null is "no check ran", never "check failed".
function ensureExternalVerificationSchema(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(attestations)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "external_verification")) {
    db.exec("ALTER TABLE attestations ADD COLUMN external_verification TEXT");
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

// the external_verification column is either sql NULL ("no external check
// ran") or a json object with exactly the ExternalVerification shape. a
// corrupt or unexpected value fails loudly instead of shipping a mangled
// provenance record upstream, matching the parseToolsUsed discipline.
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

// session key rows come back as plain records; the accessors fail loudly on
// a corrupt or unexpected shape instead of shipping a mangled envelope, and
// the numeric expiry handles both number and bigint representations.
function sessionKeyFromRow(row: SqlRow): SessionKeyRow {
  return {
    agentId: str(row, "agentId"),
    ownerUserId: str(row, "ownerUserId"),
    encryptedPrivateKey: str(row, "encryptedPrivateKey"),
    iv: str(row, "iv"),
    algorithm: str(row, "algorithm"),
    createdAt: str(row, "createdAt"),
    expiresAtEpochMs: num(row, "expiresAtEpochMs"),
  };
}

// chat rows come back as plain records like every other read; the accessors
// fail loudly on a corrupt shape. the role check is explicit (not a blind
// cast) so an unknown role can never be shipped upstream.
function chatSessionFromRow(row: SqlRow): ChatSession {
  return {
    id: str(row, "id"),
    agentId: str(row, "agentId"),
    ownerUserId: str(row, "ownerUserId"),
    createdAt: str(row, "createdAt"),
  };
}

function chatMessageFromRow(row: SqlRow): ChatMessage {
  const role = str(row, "role");
  if (role !== "user" && role !== "assistant") {
    throw new Error(`stored row column role has an unknown chat role: ${role}`);
  }
  return {
    role: role as ChatRole,
    content: str(row, "content"),
    toolsUsed: parseToolsUsed(row),
    timestamp: str(row, "timestamp"),
  };
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
  schema_version AS schemaVersion,
  external_verification AS externalVerification
`;

// the chat session select list, shared so read aliasing cannot drift.
const CHAT_SESSION_COLUMNS = `
  id,
  agent_id AS agentId,
  owner_user_id AS ownerUserId,
  created_at AS createdAt
`;

// the chat message select list. every column is qualified with the session
// alias because the read joins chat_messages against chat_sessions.
const CHAT_MESSAGE_COLUMNS = `
  m.role,
  m.content,
  m.tools_used AS toolsUsed,
  m.timestamp
`;

// the join-scoped agent read used by listOwnedAgents. every column is
// qualified with the agents alias because row_id exists in both joined
// tables and an unqualified reference would be ambiguous.
const OWNED_AGENT_COLUMNS = `
  a.row_id AS rowId,
  a.name,
  a.public_key AS publicKey,
  a.owner_public_key AS ownerPublicKey,
  a.memory_pointer AS memoryPointer,
  a.permissions,
  a.created_at AS createdAt,
  a.manifest_version AS manifestVersion,
  a.signature,
  a.revoked_at AS revokedAt
`;

// the users select list, shared so read aliasing cannot drift between the
// two user reads.
const USER_COLUMNS = `
  id,
  email,
  password_hash AS passwordHash,
  name,
  created_at AS createdAt
`;

// the accounts select list: getAccountLink is the only read, but keeping the
// list a constant means the read aliases cannot drift from a future second
// read.
const ACCOUNT_COLUMNS = `
  id,
  user_id AS userId,
  provider,
  provider_account_id AS providerAccountId,
  created_at AS createdAt
`;

class SqliteStorageAdapter implements StorageAdapter, SessionKeyBackend {
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

  async rotateAgent(record: AgentRecord, rotation: KeyRotationRecord): Promise<void> {
    assertNoPrivateKey(record);
    // the ONE atomic write behind sdk-level rotateAgent: the successor
    // agents row and its key_rotations audit row commit or roll back
    // together. the append-only ledger has no delete path, so an
    // app-level "undo the successor if the audit write fails" is
    // impossible; the transaction is what makes a partial rotation
    // unobservable (adversarial review: partial write / state injection).
    // BEGIN IMMEDIATE takes the write lock up front so two processes
    // rotating on the same file cannot deadlock with each other, and
    // busy_timeout covers the short contention window.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // same-connection insert inside the open transaction; saveAgent's
      // DUPLICATE_NAME / DUPLICATE_PUBLIC_KEY mapping applies unchanged.
      await this.saveAgent(record);
      this.db
        .prepare(
          `INSERT INTO key_rotations (old_public_key, new_public_key, signed_by, timestamp, signature)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          rotation.oldPublicKey,
          rotation.newPublicKey,
          rotation.signedBy,
          rotation.timestamp,
          rotation.signature,
        );
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // a failed rollback must not mask the original error; nothing
        // further can be done with a broken transaction anyway.
      }
      throw err; // saveAgent's coded errors propagate unchanged
    }
  }

  async getKeyRotations(agentId: AgentId): Promise<KeyRotationRecord[]> {
    // audit lineage lookup: an agent id can appear on either end of a
    // rotation (it was the old id once, then became an old id again after
    // a later rotation... no: it can be the old end of rotations it was
    // rotated out of, and the new end of the rotation that created it),
    // so rows match on old OR new. not-found is an empty array.
    const rows = this.db
      .prepare(
        `SELECT old_public_key AS oldPublicKey, new_public_key AS newPublicKey, signed_by AS signedBy, timestamp, signature
         FROM key_rotations WHERE old_public_key = ? OR new_public_key = ? ORDER BY row_id DESC`,
      )
      .all(agentId, agentId);
    return rows.map((row) => ({
      oldPublicKey: str(row, "oldPublicKey"),
      newPublicKey: str(row, "newPublicKey"),
      signedBy: str(row, "signedBy"),
      timestamp: str(row, "timestamp"),
      signature: str(row, "signature"),
    }));
  }

  async getSessionKey(agentId: AgentId, ownerUserId: string): Promise<SessionKeyRow | null> {
    // pair-scoped read: an owner can only ever see its own row for an
    // agent, and a wrong owner is a miss, never a fallthrough
    // (adversarial review: cross-owner access). not-found returns null.
    const row = this.db
      .prepare(
        `SELECT agent_id AS agentId, owner_user_id AS ownerUserId, encrypted_private_key AS encryptedPrivateKey,
                iv, algorithm, created_at AS createdAt, expires_at_epoch_ms AS expiresAtEpochMs
         FROM session_keys WHERE agent_id = ? AND owner_user_id = ?`,
      )
      .get(agentId, ownerUserId);
    return row ? sessionKeyFromRow(row) : null;
  }

  async setSessionKey(row: SessionKeyRow): Promise<void> {
    // upsert: one row per (agent, owner) pair, replacing any previous
    // envelope for the same pair. the agent foreign key refuses a session
    // for a nonexistent identity at the schema level.
    this.db
      .prepare(
        `INSERT INTO session_keys (agent_id, owner_user_id, encrypted_private_key, iv, algorithm, created_at, expires_at_epoch_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, owner_user_id) DO UPDATE SET
           encrypted_private_key = excluded.encrypted_private_key,
           iv = excluded.iv,
           algorithm = excluded.algorithm,
           created_at = excluded.created_at,
           expires_at_epoch_ms = excluded.expires_at_epoch_ms`,
      )
      .run(
        row.agentId,
        row.ownerUserId,
        row.encryptedPrivateKey,
        row.iv,
        row.algorithm,
        row.createdAt,
        row.expiresAtEpochMs,
      );
  }

  async touchSessionKey(agentId: AgentId, ownerUserId: string, expiresAtEpochMs: number): Promise<void> {
    // idempotent expiry slide. zero rows changed is fine: the store only
    // touches after a successful read, so a row vanishing mid-flight just
    // means the slide did not land.
    this.db
      .prepare("UPDATE session_keys SET expires_at_epoch_ms = ? WHERE agent_id = ? AND owner_user_id = ?")
      .run(expiresAtEpochMs, agentId, ownerUserId);
  }

  async deleteSessionKey(agentId: AgentId, ownerUserId: string): Promise<void> {
    this.db.prepare("DELETE FROM session_keys WHERE agent_id = ? AND owner_user_id = ?").run(agentId, ownerUserId);
  }

  async sweepExpiredSessionKeys(beforeEpochMs: number): Promise<void> {
    this.db.prepare("DELETE FROM session_keys WHERE expires_at_epoch_ms <= ?").run(beforeEpochMs);
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
             (id, agent_id, idempotency_key, task, output, tools_used, source, content_hash, signature, signed_by, timestamp, schema_version, external_verification)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          // nullable json: absent (native) and null both persist as null,
          // "no external check ran", and are read back as null.
          record.externalVerification === undefined || record.externalVerification === null
            ? null
            : JSON.stringify(record.externalVerification),
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

  async createChatSession(agentId: AgentId, ownerUserId: string, createdAt: string): Promise<ChatSession> {
    // optimistic read first: the schema unique constraint on the pair is the
    // source of truth, this lookup only avoids throwing away work. the
    // session id is storage generated (randomUUID), never caller supplied,
    // so no caller can collide or guess another owner's session id.
    const existing = this.db
      .prepare(`SELECT ${CHAT_SESSION_COLUMNS} FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`)
      .get(agentId, ownerUserId);
    if (existing) return chatSessionFromRow(existing);
    try {
      // ON CONFLICT DO NOTHING (no target) suppresses unique conflicts on
      // both the id primary key and the (agent_id, owner_user_id) pair, so a
      // concurrent create for the same pair is a no-op, never an error.
      // foreign key violations are NOT suppressed by ON CONFLICT, so an
      // unknown agent still surfaces as AGENT_NOT_FOUND below.
      this.db
        .prepare(
          `INSERT INTO chat_sessions (id, agent_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(randomUUID(), agentId, ownerUserId, createdAt);
    } catch (err) {
      // the session foreign key is the schema level guarantee that a
      // conversation never names a nonexistent identity. translating the
      // violation keeps every failure mode machine readable.
      if (isForeignKeyViolation(err)) {
        throw codedError("AGENT_NOT_FOUND", `cannot create chat session for unknown agent: ${agentId}`, err);
      }
      throw err;
    }
    // whichever concurrent insert won, the pair now has exactly one session;
    // the second read is authoritative and cannot miss.
    const row = this.db
      .prepare(`SELECT ${CHAT_SESSION_COLUMNS} FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`)
      .get(agentId, ownerUserId);
    if (!row) {
      throw new Error("chat session insert reported success but no row is readable");
    }
    return chatSessionFromRow(row);
  }

  async getChatSession(agentId: AgentId, ownerUserId: string): Promise<ChatSession | null> {
    // pair-scoped read: a wrong owner is a miss, never a fallthrough to
    // another owner's session (adversarial review: cross-owner access).
    const row = this.db
      .prepare(`SELECT ${CHAT_SESSION_COLUMNS} FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`)
      .get(agentId, ownerUserId);
    return row ? chatSessionFromRow(row) : null;
  }

  async appendChatMessage(message: ChatMessageRecord): Promise<void> {
    // the insert resolves the stored session id FROM the ownership pair in
    // the same statement, so there is no check-then-write window and no
    // session id ever crosses this boundary: a message physically cannot
    // land in a session the caller cannot see, even under a race
    // (adversarial review: state injection / cross-owner access).
    const result = this.db
      .prepare(
        `INSERT INTO chat_messages (session_id, role, content, tools_used, timestamp)
         SELECT id, ?, ?, ?, ? FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`,
      )
      .run(
        message.role,
        message.content,
        JSON.stringify(message.toolsUsed),
        message.timestamp,
        message.agentId,
        message.ownerUserId,
      );
    // zero affected rows means the pair has no session: fail closed, never a
    // silent drop (the web layer creates the session first, so this path is
    // a real race or a caller bug, both of which must be loud).
    if (Number(result.changes) === 0) {
      throw codedError(
        "CHAT_SESSION_NOT_FOUND",
        `cannot append message: no chat session for agent ${message.agentId} and owner ${message.ownerUserId}`,
        new Error("no matching session"),
      );
    }
  }

  async getChatMessages(agentId: AgentId, ownerUserId: string): Promise<ChatMessage[]> {
    // pair-scoped read joined through the session, oldest first. a missing
    // session reads as an empty array, never an error.
    const rows = this.db
      .prepare(
        `SELECT ${CHAT_MESSAGE_COLUMNS}
         FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE s.agent_id = ? AND s.owner_user_id = ?
         ORDER BY m.row_id ASC`,
      )
      .all(agentId, ownerUserId);
    return rows.map(chatMessageFromRow);
  }

  async listOwnedAgents(ownerUserId: string): Promise<AgentRecord[]> {
    // ownership is resolved from the session key ledger at query level:
    // listing an owner's agents is exactly "agents that owner holds a
    // session key row for". there is no global list call and no owner
    // parameter that could be substituted for another user's (adversarial
    // review: idor / tenant scoping).
    const rows = this.db
      .prepare(
        `SELECT ${OWNED_AGENT_COLUMNS}
         FROM session_keys sk
         JOIN agents a ON a.public_key = sk.agent_id
         WHERE sk.owner_user_id = ?
         ORDER BY sk.row_id ASC`,
      )
      .all(ownerUserId);
    return rows.map(recordFromRow);
  }

  async createUser(user: UserRecord): Promise<void> {
    try {
      // the users.email unique constraint is the authoritative duplicate
      // guard: two concurrent sign-ins for the same email cannot both land,
      // whichever insert loses surfaces DUPLICATE_EMAIL for the web layer to
      // resolve (refetch the winner).
      this.db
        .prepare(`INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(user.id, user.email, user.passwordHash, user.name, user.createdAt);
    } catch (err) {
      if (isUniqueViolation(err, "users.email")) {
        throw codedError("DUPLICATE_EMAIL", `user email already exists: ${user.email}`, err);
      }
      throw err;
    }
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`).get(email);
    return row ? userFromRow(row) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = this.db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id);
    return row ? userFromRow(row) : null;
  }

  async createAccountLink(link: AccountLink): Promise<void> {
    try {
      // the (provider, provider_account_id) unique pair is the authoritative
      // guard: one external identity can never own two openrep accounts, and
      // the user_id foreign key means a link can never name a missing user
      // (the auth layer creating a link for a just-created account cannot
      // race into an orphaned link).
      this.db
        .prepare(`INSERT INTO accounts (id, user_id, provider, provider_account_id, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(link.id, link.userId, link.provider, link.providerAccountId, link.createdAt);
    } catch (err) {
      if (isUniqueViolation(err, "accounts.provider, accounts.provider_account_id")) {
        throw codedError(
          "DUPLICATE_ACCOUNT",
          `account link already exists for provider ${link.provider}`,
          err,
        );
      }
      if (isForeignKeyViolation(err)) {
        throw codedError("USER_NOT_FOUND", `cannot link provider ${link.provider} to unknown user ${link.userId}`, err);
      }
      throw err;
    }
  }

  async getAccountLink(provider: string, providerAccountId: string): Promise<AccountLink | null> {
    // provider-scoped read: a caller can only ever read the exact
    // (provider, providerAccountId) pair it asked for, never a scan.
    const row = this.db
      .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE provider = ? AND provider_account_id = ?`)
      .get(provider, providerAccountId);
    return row ? accountLinkFromRow(row) : null;
  }

  async mergeOwner(fromUserId: string, toUserId: string): Promise<void> {
    // merging an owner into itself is a no-op, never an error: the auth
    // layer's merge path can re-run idempotently after a partial failure.
    if (fromUserId === toUserId) return;
    if (fromUserId === "" || toUserId === "") {
      throw codedError("INVALID_INPUT", "mergeOwner requires two non-empty owner ids", new Error("empty owner id"));
    }
    const tx = (fn: () => void): void => {
      // explicit BEGIN/COMMIT/ROLLBACK because node:sqlite exposes no
      // transaction helper; every path between BEGIN and COMMIT rolls back
      // on any throw so a failed merge can never be observed half done
      // (phase 3 threat: partial ownership split on a guest->account merge).
      this.db.exec("BEGIN");
      try {
        fn();
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    };
    tx(() => {
      // owner-scoped rows only (session_keys, chat_sessions): agents and
      // attestations carry key-based ownership, not this ledger, and
      // accounts must never move under a merge. the WHERE clause keeps the
      // move scoped to exactly the source owner, so a caller can never
      // rewrite another owner's rows.
      this.db
        .prepare(`UPDATE session_keys SET owner_user_id = ? WHERE owner_user_id = ?`)
        .run(toUserId, fromUserId);
      this.db
        .prepare(`UPDATE chat_sessions SET owner_user_id = ? WHERE owner_user_id = ?`)
        .run(toUserId, fromUserId);
    });
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

function userFromRow(row: SqlRow): UserRecord {
  return {
    id: str(row, "id"),
    email: str(row, "email"),
    // null means oauth-only account; the web layer refuses password
    // attempts against a null hash, so this value must round-trip exactly.
    passwordHash: nullableStr(row, "passwordHash"),
    name: nullableStr(row, "name"),
    createdAt: str(row, "createdAt"),
  };
}

function accountLinkFromRow(row: SqlRow): AccountLink {
  return {
    id: str(row, "id"),
    userId: str(row, "userId"),
    provider: str(row, "provider"),
    providerAccountId: str(row, "providerAccountId"),
    createdAt: str(row, "createdAt"),
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
    // null means "no external check ran" (native or legacy rows).
    externalVerification: parseExternalVerification(row),
  };
}

// direct construction, always opens a fresh connection and a fresh file (or
// a fresh in-memory database for ":memory:"). tests use this so every test
// gets complete isolation. the return type carries both contracts: the sdk
// reputation ledger (StorageAdapter) and the session key custody backend
// (SessionKeyBackend) that DurableSessionKeyStore consumes, so the web layer
// holds one handle for both.
export function createSqliteStorage(databasePath: string): StorageAdapter & SessionKeyBackend {
  let db: DatabaseSync;
  try {
    // enableForeignKeyConstraints is set explicitly even though node:sqlite
    // currently defaults it on, so enforcement never depends on a default
    // value changing under us. busy_timeout keeps concurrent file access
    // from failing instantly under the cli.
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
    db.exec("PRAGMA busy_timeout = 5000");
    // WAL journal mode on file-backed databases is the cross-process
    // concurrency fix: in delete mode a writer takes an exclusive lock and
    // blocks every reader, and concurrent writers fail with database is
    // locked. WAL lets readers proceed while a writer holds the write
    // mutex, and the write mutex itself is short-held, so busy_timeout
    // above covers the only remaining fights. the mode is a persistent
    // property stored in the database file, asserted on readback exactly
    // like the foreign keys pragma, so it never depends on a default
    // drifting under us. in-memory databases cannot be WAL, the pragma
    // reports "memory" and is a verified no-op, so skip it there.
    // PRAGMA synchronous = NORMAL is the canonical WAL durability setting:
    // crash-safe against app and os crashes (no corruption), with the rare
    // tradeoff that a power loss right after commit may lose the very last
    // transaction. the sqlite docs recommend NORMAL over FULL specifically
    // for WAL, and it is the user-confirmed choice for this adapter.
    const fileBacked = databasePath !== ":memory:";
    if (fileBacked) {
      db.exec("PRAGMA journal_mode = WAL");
      const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown };
      if (journal.journal_mode !== "wal") {
        throw new Error(`PRAGMA journal_mode did not report wal after enabling; refusing to boot a store that blocks readers (got ${String(journal.journal_mode)})`);
      }
      db.exec("PRAGMA synchronous = NORMAL");
    }
    db.exec(SCHEMA);
    db.exec(ATTESTATIONS_BY_AGENT_INDEX);
    db.exec(KEY_ROTATION_INDEXES);
    db.exec(CHAT_INDEXES);
    ensureIdempotencySchema(db);
    ensureRevocationSchema(db);
    ensureExternalVerificationSchema(db);
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
const openConnections = new Map<string, StorageAdapter & SessionKeyBackend>();

export function getSqliteStorage(databasePath: string): StorageAdapter & SessionKeyBackend {
  let adapter = openConnections.get(databasePath);
  if (adapter === undefined) {
    adapter = createSqliteStorage(databasePath);
    openConnections.set(databasePath, adapter);
  }
  return adapter;
}