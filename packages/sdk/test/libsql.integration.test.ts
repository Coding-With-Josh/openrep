// libsql integration tests against the real hosted turso database,
// libsql://openrep-josh-scriptz.aws-us-east-2.turso.io by default (or the
// TURSO_TEST_DATABASE_URL override if set). skipped cleanly when either the
// url or the auth token is missing, so local runs without hosted creds stay
// green. the suite creates real rows through the real adapter path and
// deletes exactly the rows it creates afterwards (attestations before
// agents, honoring the foreign key); rows from other runs or other code are
// never touched.
//
// two harness lessons from the first hosted run, which failed 5 of 6:
// - the vitest default test timeout (5000ms) is far too short for the cold
//   hosted path, because one createLibsqlStorage does ~9 sequential HTTP
//   round trips (pragma set, pragma readback, schema batch, table_info
//   reads, index/alter tails) at 1-2s each. every test and hook here sets
//   an explicit 120s timeout, and one adapter is shared across the suite
//   (created in beforeAll, closed in afterAll) so bootstrap runs once, the
//   same lifecycle a long-lived server process uses.
// - fixtures must be collision proof. the first version derived agent names
//   from publicKey.slice(0, 8), and two distinct keys sharing the same
//   8-char prefix (libsql-int-key-... vs libsql-int-other-...) collapsed to
//   the same name, so the composite-index test deterministically hit
//   DUPLICATE_NAME on its own second agent. names are now
//   libsql-int-{runId}-{sequence}.agent: the runId scopes a run and the
//   sequence guarantees uniqueness within it, so no two synthetic records
//   can share a name and rows a crashed run leaves behind can never collide
//   with a later run.
//
// these tests are the hosted half of the B1 go/no-go: the FK enforcement
// case here passes only if the bootstrap-time PRAGMA foreign_keys = ON
// actually takes effect against the hosted primary (the spike verified the
// pragma persists per client; this proves the adapter wires it in).
import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgent, createLibsqlStorage, type LibsqlStorageAdapter } from "../src/index.js";
import type { AgentRecord, AttestationRecord } from "../src/index.js";

// TURSO_TEST_DATABASE_URL is the sanctioned escape hatch for a scratch
// database: set it and the suite runs against that instead of the shared
// one. creds absent means the whole suite skips.
const baseUrl = process.env.TURSO_TEST_DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
const hosted = baseUrl !== undefined && authToken !== undefined;

// cold hosted bootstrap plus per-test statements run well over the vitest
// default of 5000ms; 120s fails closed on a true hang while leaving plenty
// of headroom for the wire. apply to every test and every hook.
const TEST_TIMEOUT = 120_000;

const runId = Date.now();
// monotonic sequence keeps every synthetic agent name unique within this
// run regardless of how similar the synthetic public keys are. old runs use
// a different runId, so their leftover rows can never collide with this one.
let nameSequence = 0;
const createdKeys: string[] = [];

// one adapter for the whole suite (bootstraps once), plus one raw client
// for best-effort cleanup. both closed in afterAll.
let storage: LibsqlStorageAdapter | null = null;
let cleanupClient: ReturnType<typeof createClient> | null = null;

function record(agentId: string, idempotencyKey: string | undefined, idSuffix: string): AttestationRecord {
  return {
    rowId: 0,
    id: `00000000-0000-4000-8000-${idSuffix}`,
    agentId,
    task: "t",
    output: "o",
    toolsUsed: [],
    source: "native",
    contentHash: "ab".repeat(32),
    signature: "cd".repeat(64),
    signedBy: agentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    idempotencyKey,
  };
}

// name uniqueness comes from the run-scoped sequence, never from the key
// content, so distinct keys can never collapse onto one name.
function makeAgent(publicKey: string): AgentRecord {
  return {
    rowId: 0,
    name: `libsql-int-${runId}-${nameSequence++}.agent`,
    publicKey,
    ownerPublicKey: "d0".repeat(32),
    memoryPointer: null,
    permissions: ["attest:self"],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 2,
    signature: "sig",
    revokedAt: null,
  };
}

describe.skipIf(!hosted)("libsql integration (hosted turso)", () => {
  beforeAll(async () => {
    if (!hosted) return;
    storage = await createLibsqlStorage({ url: baseUrl!, authToken: authToken! });
    cleanupClient = createClient({ url: baseUrl!, authToken: authToken! });
  }, TEST_TIMEOUT);

  afterEach(async () => {
    if (!hosted || createdKeys.length === 0) return;
    for (const key of createdKeys.splice(0)) {
      // foreign key order: attestations reference agents, so children go
      // first. best-effort: a missing row is not an error.
      await cleanupClient!.execute({ sql: "DELETE FROM attestations WHERE agent_id = ?", args: [key] });
      await cleanupClient!.execute({ sql: "DELETE FROM agents WHERE public_key = ?", args: [key] });
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await storage?.close();
    await cleanupClient?.close();
    storage = null;
    cleanupClient = null;
  }, TEST_TIMEOUT);

  it("creates, persists, and reads back an agent end to end", async () => {
    const result = await createAgent({ storage: storage! });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const identity = result.value;
    createdKeys.push(identity.publicKey);
    const stored = await storage!.getAgent(identity.publicKey);
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe(identity.name);
    expect(stored!.signature).toBe(identity.signature);
    expect("privateKey" in stored!).toBe(false);
    expect(await storage!.getAgentByName(identity.name)).not.toBeNull();
  }, TEST_TIMEOUT);

  it("rejects a duplicate explicit name against the real hosted schema constraint", async () => {
    const name = `libsql-int-${runId}-fixed.agent`;
    const first = await createAgent({ storage: storage!, name });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    createdKeys.push(first.value.publicKey);
    const second = await createAgent({ storage: storage!, name });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("DUPLICATE_NAME");
    expect(await storage!.getAgentByName(name)).not.toBeNull();
  }, TEST_TIMEOUT);

  it("resolves the check-then-write race with concurrent hosted creates, all names unique", async () => {
    const results = await Promise.all([
      createAgent({ storage: storage! }),
      createAgent({ storage: storage! }),
      createAgent({ storage: storage! }),
    ]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(3);
    for (const result of succeeded) {
      if (!result.ok) continue;
      createdKeys.push(result.value.publicKey);
      expect(await storage!.getAgent(result.value.publicKey)).not.toBeNull();
    }
    const names = new Set(succeeded.map((r) => (r.ok ? r.value.name : "")));
    expect(names.size).toBe(3);
  }, TEST_TIMEOUT);

  it("enforces the foreign key on the hosted primary: unknown agent surfaces as AGENT_NOT_FOUND", async () => {
    // a guaranteed-absent key: freshly generated, never inserted here.
    const absent = `${runId}deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef`;
    await expect(storage!.saveAttestation(record(absent, undefined, "0000000000a1"))).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  }, TEST_TIMEOUT);

  it("enforces the composite unique index on the hosted primary", async () => {
    const agent = makeAgent(`libsql-int-key-${runId}`);
    await storage!.saveAgent(agent);
    createdKeys.push(agent.publicKey);
    await storage!.saveAttestation(record(agent.publicKey, "run-1", "0000000000b1"));
    await expect(storage!.saveAttestation(record(agent.publicKey, "run-1", "0000000000b2"))).rejects.toMatchObject({
      code: "DUPLICATE_IDEMPOTENCY_KEY",
    });
    // same key under a different agent is a different row entirely; the
    // run-scoped sequence guarantees this agent's name differs from the
    // first one even though both synthetic keys share an 8-char prefix.
    const other = makeAgent(`libsql-int-other-${runId}`);
    await storage!.saveAgent(other);
    createdKeys.push(other.publicKey);
    await expect(storage!.saveAttestation(record(other.publicKey, "run-1", "0000000000b3"))).resolves.toBeUndefined();
  }, TEST_TIMEOUT);

  it("refuses to persist a private key carrier on the hosted primary", async () => {
    const smuggled = { ...makeAgent(`libsql-int-leak-${runId}`), privateKey: "deadbeef" } as unknown as AgentRecord;
    await expect(storage!.saveAgent(smuggled)).rejects.toThrow(/private key/);
    // nothing may have been persisted under the record's own (sequence
    // assigned) name, even in a partial-write failure.
    expect(await storage!.getAgentByName(smuggled.name)).toBeNull();
  }, TEST_TIMEOUT);
});