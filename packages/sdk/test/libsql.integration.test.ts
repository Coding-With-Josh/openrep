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
import { signAsync, verifyAsync } from "@noble/ed25519";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalize, createAgent, createLibsqlStorage, rotateAgent, type LibsqlStorageAdapter } from "../src/index.js";
import type { AgentRecord, AttestationRecord } from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

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
      // foreign key order: key_rotations and attestations both reference
      // agents, so children go first. best-effort: a missing row is not an
      // error. the rotation tests delete by either end of the lineage
      // because a partial write (if the hosted batch were ever non-atomic)
      // could leave the audit row referenced from either side.
      await cleanupClient!.execute({ sql: "DELETE FROM key_rotations WHERE old_public_key = ? OR new_public_key = ?", args: [key, key] });
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

  it("rotates an agent end to end on the hosted primary: successor, audit row, either-end lookup, old id live", async () => {
    const created = await createAgent({ storage: storage! });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldId = created.value;
    createdKeys.push(oldId.publicKey);

    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: oldId.publicKey, timestamp }, oldId.ownerPrivateKey);
    const rotated = await rotateAgent({ agentId: oldId.publicKey, timestamp, signature }, storage!);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    const successor = rotated.value;
    createdKeys.push(successor.publicKey);

    expect(successor.publicKey).not.toBe(oldId.publicKey);
    expect(successor.ownerPublicKey).toBe(oldId.ownerPublicKey);

    // rotation is successor issuance, never a silent re-key: the old id is
    // still live on the hosted primary and the successor persists.
    expect((await storage!.getAgent(oldId.publicKey))!.revokedAt).toBeNull();
    expect(await storage!.getAgent(successor.publicKey)).not.toBeNull();

    // the audit row landed exactly once in the real table, and the lineage
    // lookup works from both ends of the chain.
    const fromOld = await storage!.getKeyRotations(oldId.publicKey);
    const fromNew = await storage!.getKeyRotations(successor.publicKey);
    expect(fromOld).toHaveLength(1);
    expect(fromNew).toEqual(fromOld);

    // the audit row is self-verifying offline against the owner key over
    // exactly the request bytes, proving the hosted write stored the
    // signature uncorrupted.
    const rotation = fromOld[0];
    expect(rotation.signedBy).toBe(oldId.ownerPublicKey);
    const valid = await verifyAsync(
      hexToBytes(rotation.signature),
      new TextEncoder().encode(canonicalize({ agentId: oldId.publicKey, timestamp })),
      hexToBytes(oldId.ownerPublicKey),
      { zip215: false },
    );
    expect(valid).toBe(true);
  }, TEST_TIMEOUT);

  it("records a second rotation of the same old id as a new lineage row, newest first, on the hosted primary", async () => {
    const created = await createAgent({ storage: storage! });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldId = created.value;
    createdKeys.push(oldId.publicKey);

    const gen1 = await runRotation(oldId);
    createdKeys.push(gen1.publicKey);
    const gen2 = await runRotation(oldId);
    createdKeys.push(gen2.publicKey);

    const lineage = await storage!.getKeyRotations(oldId.publicKey);
    expect(lineage.map((r) => r.newPublicKey)).toEqual([gen2.publicKey, gen1.publicKey]);
  }, TEST_TIMEOUT);

  it("rolls back the hosted write batch on a name collision, leaving no successor and no audit row", async () => {
    const victim = makeAgent(`libsql-int-rotate-victim-${runId}`);
    await storage!.saveAgent(victim);
    createdKeys.push(victim.publicKey);
    // a hand-built successor whose name collides with the victim: the batch
    // insert of the agent row trips the unique name constraint, and the
    // audit insert must roll back with it.
    const successor = { ...makeAgent(`libsql-int-rotate-succ-${runId}`), name: victim.name };

    await expect(
      storage!.rotateAgent(successor, {
        oldPublicKey: victim.publicKey,
        newPublicKey: successor.publicKey,
        signedBy: "d0".repeat(32),
        timestamp: "2026-03-01T00:00:00.000Z",
        signature: "e0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE_NAME" });

    // the hosted primary left no partial state: no successor agent row and
    // no dangling audit row, exactly the embedded-engine guarantee.
    expect(await storage!.getAgent(successor.publicKey)).toBeNull();
    expect(await storage!.getKeyRotations(victim.publicKey)).toEqual([]);
  }, TEST_TIMEOUT);
});

// signs a rotation request with the agent's own owner key, mirroring the
// sdk contract: canonicalize({ agentId, timestamp }) with real ed25519.
async function ownerSign(req: { agentId: string; timestamp: string }, ownerSecretHex: string): Promise<string> {
  const signature = await signAsync(
    new TextEncoder().encode(canonicalize({ agentId: req.agentId, timestamp: req.timestamp })),
    hexToBytes(ownerSecretHex),
  );
  return bytesToHex(signature);
}

// full sdk rotateAgent round trip used by the lineage-ordering test, with
// the shared hosted adapter as the storage argument.
async function runRotation(identity: { publicKey: string; ownerPrivateKey: string }): Promise<{ publicKey: string }> {
  const timestamp = new Date().toISOString();
  const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
  const rotated = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage!);
  if (!rotated.ok) throw new Error(`rotation failed: ${rotated.error.code}`);
  return rotated.value;
}