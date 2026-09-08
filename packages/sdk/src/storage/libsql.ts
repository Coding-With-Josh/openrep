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
import { randomUUID } from "node:crypto";
import { createClient, type Client, type InStatement, type Row } from "@libsql/client";
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
  // web session key custody, identical to sqlite.ts: encrypted envelopes
  // only (SessionKeyRow structurally cannot carry a raw key), one row per
  // (agent_id, owner_user_id) pair, persisted expiry so a serverless cold
  // start cannot forget a live session. owner_user_id has no foreign key
  // (no users table in the ledger; pair-scoped reads are the enforcement,
  // see the SessionKeyBackend contract in types/security.ts). new in this
  // pass, so fresh and legacy databases both get it from this CREATE.
  `CREATE TABLE IF NOT EXISTS session_keys (
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
);`,
  // web chat history, identical to sqlite.ts: one session per (agent, owner)
  // pair enforced by a schema unique constraint, and an append-only message
  // ledger. the session id is storage generated (randomUUID) and never part
  // of any public addressing scheme: every read and write resolves the
  // (agent_id, owner_user_id) pair, so an owner can never address another
  // owner's conversation. new in this pass, so fresh and legacy databases
  // both get these from CREATE IF NOT EXISTS, no ALTER.
  `CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, owner_user_id),
  FOREIGN KEY (agent_id) REFERENCES agents(public_key)
);`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tools_used TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  attestation_id TEXT,
  FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
);`,
  // message reads join on session_id and order by row_id; sqlite does not
  // index foreign key columns automatically, so this keeps a conversation
  // read proportional to the conversation, not the database.
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages (session_id);`,
  // web account layer, identical to sqlite.ts: web-owned tables persisted
  // here, policy owned by the web auth layer. email is globally unique so a
  // duplicate sign-in collides at insert; password_hash NULL means the
  // account is oauth-only and password claims against it must be refused by
  // the web layer. accounts uniquely map one external identity
  // (provider, provider_account_id) to one user; the user_id foreign key
  // keeps a link from naming a nonexistent account. new in this pass, fresh
  // and legacy databases both get them from CREATE IF NOT EXISTS, no ALTER.
  `CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT,
  created_at TEXT NOT NULL
);`,
  `CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_account_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);`,
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

// per-message attestation linkage, identical to sqlite.ts: the guarded
// ALTER keeps pre-existing chat_messages tables working, nullable by
// design because user messages and legacy rows have no attestation.
async function ensureChatAttestationSchema(client: Client): Promise<void> {
  const columns = await tableColumns(client, "chat_messages");
  if (!columns.includes("attestation_id")) {
    await client.execute("ALTER TABLE chat_messages ADD COLUMN attestation_id TEXT");
  }
}

// retrofit for assistant messages appended before attestation_id existed,
// same join and rationale as sqlite.ts: same agent, identical output, and
// the latest attestation at or before the message timestamp is the turn's
// own record. idempotent: only NULL rows are touched, reruns are no-ops.
async function backfillChatAttestationLinks(client: Client): Promise<void> {
  await client.execute(`
    UPDATE chat_messages AS m
    SET attestation_id = (
      SELECT a.id
      FROM attestations AS a
      JOIN chat_sessions AS s ON s.id = m.session_id
      WHERE a.agent_id = s.agent_id
        AND a.output = m.content
        AND datetime(a.timestamp) <= datetime(m.timestamp)
      ORDER BY datetime(a.timestamp) DESC, a.row_id DESC
      LIMIT 1
    )
    WHERE m.role = 'assistant'
      AND m.attestation_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM attestations AS a
        JOIN chat_sessions AS s ON s.id = m.session_id
        WHERE a.agent_id = s.agent_id
          AND a.output = m.content
          AND datetime(a.timestamp) <= datetime(m.timestamp)
      )
  `);
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
    await ensureChatAttestationSchema(client);
    await backfillChatAttestationLinks(client);
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
    attestationId: nullableStr(row, "attestationId"),
  };
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
  m.timestamp,
  m.attestation_id AS attestationId
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

export class LibsqlStorageAdapter implements StorageAdapter, SessionKeyBackend {
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

  async getSessionKey(agentId: AgentId, ownerUserId: string): Promise<SessionKeyRow | null> {
    // pair-scoped read: a wrong owner is a miss, never a fallthrough to
    // another owner's row (adversarial review: cross-owner access).
    const result = await this.client.execute({
      sql: `SELECT agent_id AS agentId, owner_user_id AS ownerUserId, encrypted_private_key AS encryptedPrivateKey,
                   iv, algorithm, created_at AS createdAt, expires_at_epoch_ms AS expiresAtEpochMs
            FROM session_keys WHERE agent_id = ? AND owner_user_id = ?`,
      args: [agentId, ownerUserId],
    });
    return result.rows.length > 0 ? sessionKeyFromRow(result.rows[0]) : null;
  }

  async setSessionKey(row: SessionKeyRow): Promise<void> {
    // upsert: one row per (agent, owner) pair. the agent foreign key refuses
    // a session row for a nonexistent identity at the schema level.
    await this.client.execute({
      sql: `INSERT INTO session_keys (agent_id, owner_user_id, encrypted_private_key, iv, algorithm, created_at, expires_at_epoch_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (agent_id, owner_user_id) DO UPDATE SET
              encrypted_private_key = excluded.encrypted_private_key,
              iv = excluded.iv,
              algorithm = excluded.algorithm,
              created_at = excluded.created_at,
              expires_at_epoch_ms = excluded.expires_at_epoch_ms`,
      args: [
        row.agentId,
        row.ownerUserId,
        row.encryptedPrivateKey,
        row.iv,
        row.algorithm,
        row.createdAt,
        row.expiresAtEpochMs,
      ],
    });
  }

  async touchSessionKey(agentId: AgentId, ownerUserId: string, expiresAtEpochMs: number): Promise<void> {
    // idempotent expiry slide; zero rows changed is fine (see sqlite.ts).
    await this.client.execute({
      sql: "UPDATE session_keys SET expires_at_epoch_ms = ? WHERE agent_id = ? AND owner_user_id = ?",
      args: [expiresAtEpochMs, agentId, ownerUserId],
    });
  }

  async deleteSessionKey(agentId: AgentId, ownerUserId: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM session_keys WHERE agent_id = ? AND owner_user_id = ?",
      args: [agentId, ownerUserId],
    });
  }

  async sweepExpiredSessionKeys(beforeEpochMs: number): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM session_keys WHERE expires_at_epoch_ms <= ?",
      args: [beforeEpochMs],
    });
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

  async createChatSession(agentId: AgentId, ownerUserId: string, createdAt: string): Promise<ChatSession> {
    // optimistic read first: the schema unique constraint on the pair is the
    // source of truth, this lookup only avoids throwing away work. the
    // session id is storage generated (randomUUID), never caller supplied,
    // so no caller can collide or guess another owner's session id.
    const existing = await this.client.execute({
      sql: `SELECT ${CHAT_SESSION_COLUMNS} FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`,
      args: [agentId, ownerUserId],
    });
    if (existing.rows.length > 0) return chatSessionFromRow(existing.rows[0]);
    try {
      // ON CONFLICT DO NOTHING (no target) suppresses unique conflicts on
      // both the id primary key and the (agent_id, owner_user_id) pair, so a
      // concurrent create for the same pair is a no-op, never an error.
      // foreign key violations are NOT suppressed by ON CONFLICT, so an
      // unknown agent still surfaces as AGENT_NOT_FOUND below.
      await this.client.execute({
        sql: `INSERT INTO chat_sessions (id, agent_id, owner_user_id, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT DO NOTHING`,
        args: [randomUUID(), agentId, ownerUserId, createdAt],
      });
    } catch (err) {
      // the session foreign key is the schema level guarantee that a
      // conversation never names a nonexistent identity.
      if (isForeignKeyViolation(err)) {
        throw codedError("AGENT_NOT_FOUND", `cannot create chat session for unknown agent: ${agentId}`, err);
      }
      throw err;
    }
    // whichever concurrent insert won, the pair now has exactly one session;
    // the second read is authoritative and cannot miss.
    const row = await this.client.execute({
      sql: `SELECT ${CHAT_SESSION_COLUMNS} FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`,
      args: [agentId, ownerUserId],
    });
    if (row.rows.length === 0) {
      throw new Error("chat session insert reported success but no row is readable");
    }
    return chatSessionFromRow(row.rows[0]);
  }

  async getChatSession(agentId: AgentId, ownerUserId: string): Promise<ChatSession | null> {
    // pair-scoped read: a wrong owner is a miss, never a fallthrough to
    // another owner's session (adversarial review: cross-owner access).
    const result = await this.client.execute({
      sql: `SELECT ${CHAT_SESSION_COLUMNS} FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`,
      args: [agentId, ownerUserId],
    });
    return result.rows.length > 0 ? chatSessionFromRow(result.rows[0]) : null;
  }

  async appendChatMessage(message: ChatMessageRecord): Promise<void> {
    // the insert resolves the stored session id FROM the ownership pair in
    // the same statement, so there is no check-then-write window and no
    // session id ever crosses this boundary: a message physically cannot
    // land in a session the caller cannot see, even under a race
    // (adversarial review: state injection / cross-owner access).
    const result = await this.client.execute({
      sql: `INSERT INTO chat_messages (session_id, role, content, tools_used, timestamp, attestation_id)
            SELECT id, ?, ?, ?, ?, ? FROM chat_sessions WHERE agent_id = ? AND owner_user_id = ?`,
      args: [
        message.role,
        message.content,
        JSON.stringify(message.toolsUsed),
        message.timestamp,
        message.attestationId ?? null,
        message.agentId,
        message.ownerUserId,
      ],
    });
    // zero affected rows means the pair has no session: fail closed, never a
    // silent drop (the web layer creates the session first, so this path is
    // a real race or a caller bug, both of which must be loud). rowsAffected
    // is a number in libsql.
    if (result.rowsAffected === 0) {
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
    const result = await this.client.execute({
      sql: `SELECT ${CHAT_MESSAGE_COLUMNS}
            FROM chat_messages m
            JOIN chat_sessions s ON s.id = m.session_id
            WHERE s.agent_id = ? AND s.owner_user_id = ?
            ORDER BY m.row_id ASC`,
      args: [agentId, ownerUserId],
    });
    return result.rows.map(chatMessageFromRow);
  }

  async listOwnedAgents(ownerUserId: string): Promise<AgentRecord[]> {
    // ownership is resolved from the session key ledger at query level:
    // listing an owner's agents is exactly "agents that owner holds a
    // session key row for". there is no global list call and no owner
    // parameter that could be substituted for another user's (adversarial
    // review: idor / tenant scoping).
    const result = await this.client.execute({
      sql: `SELECT ${OWNED_AGENT_COLUMNS}
            FROM session_keys sk
            JOIN agents a ON a.public_key = sk.agent_id
            WHERE sk.owner_user_id = ?
            ORDER BY sk.row_id ASC`,
      args: [ownerUserId],
    });
    return result.rows.map(recordFromRow);
  }

  async createUser(user: UserRecord): Promise<void> {
    try {
      // the users.email unique constraint is the authoritative duplicate
      // guard: two concurrent sign-ins for the same email cannot both land,
      // whichever insert loses surfaces DUPLICATE_EMAIL for the web layer to
      // resolve (refetch the winner). the constraint index string is
      // produced by the engine from the schema, never from caller data, so
      // the message-based classifier cannot be spoofed.
      await this.client.execute({
        sql: `INSERT INTO users (id, email, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [user.id, user.email, user.passwordHash, user.name, user.createdAt],
      });
    } catch (err) {
      if (isUniqueViolation(err, "users.email")) {
        throw codedError("DUPLICATE_EMAIL", `user email already exists: ${user.email}`, err);
      }
      throw err;
    }
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT ${USER_COLUMNS} FROM users WHERE email = ?`,
      args: [email],
    });
    return result.rows.length > 0 ? userFromRow(result.rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const result = await this.client.execute({
      sql: `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
      args: [id],
    });
    return result.rows.length > 0 ? userFromRow(result.rows[0]) : null;
  }

  async createAccountLink(link: AccountLink): Promise<void> {
    try {
      // the (provider, provider_account_id) unique pair is the authoritative
      // guard: one external identity can never own two openrep accounts, and
      // the user_id foreign key means a link can never name a missing user.
      await this.client.execute({
        sql: `INSERT INTO accounts (id, user_id, provider, provider_account_id, created_at) VALUES (?, ?, ?, ?, ?)`,
        args: [link.id, link.userId, link.provider, link.providerAccountId, link.createdAt],
      });
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
    const result = await this.client.execute({
      sql: `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE provider = ? AND provider_account_id = ?`,
      args: [provider, providerAccountId],
    });
    return result.rows.length > 0 ? accountLinkFromRow(result.rows[0]) : null;
  }

  async mergeOwner(fromUserId: string, toUserId: string): Promise<void> {
    // merging an owner into itself is a guarded no-op, never an error: the
    // auth layer's merge path can re-run idempotently after a partial
    // failure (adversarial review: out-of-order retry after network drop).
    if (fromUserId === toUserId) return;
    if (fromUserId === "" || toUserId === "") {
      throw codedError("INVALID_INPUT", "mergeOwner requires two non-empty owner ids", new Error("empty owner id"));
    }
    // one "write" batch IS one transaction on both engines (verified by the
    // rotateAgent path): both owner-scoped tables move in a single commit or
    // not at all, so a guest->account merge can never be observed half done
    // (adversarial review: partial ownership split). the WHERE clause keeps
    // the move scoped to exactly the source owner, so a caller can never
    // rewrite another owner's rows.
    await this.client.batch(
      [
        { sql: `UPDATE session_keys SET owner_user_id = ? WHERE owner_user_id = ?`, args: [toUserId, fromUserId] },
        { sql: `UPDATE chat_sessions SET owner_user_id = ? WHERE owner_user_id = ?`, args: [toUserId, fromUserId] },
      ],
      "write",
    );
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