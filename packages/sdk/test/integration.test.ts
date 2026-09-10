// integration tests: the real createAgent (fresh keygen, signing, the
// optimistic name read) running against the real sqlite storage adapter, so
// the two passes provably compose. the contracts traveled separately before,
// this is the first place they meet end to end.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { signAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import { attest, canonicalize, createAgent, createSqliteStorage, revokeAgent, setVisibility, verifyAttestation } from "../src/index.js";
import type { AgentRecord, AttestationRecord, RevocationRequest } from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

describe("createAgent + sqlite storage integration", () => {
  it("creates, persists, and reads back an agent end to end", async () => {
    const storage = createSqliteStorage(":memory:");
    const result = await createAgent({ storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const identity = result.value;
    const stored = await storage.getAgent(identity.publicKey);
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe(identity.name);
    expect(stored!.signature).toBe(identity.signature);
    expect("privateKey" in stored!).toBe(false); // key custody survives the real round trip
    const byName = await storage.getAgentByName(identity.name);
    expect(byName?.publicKey).toBe(identity.publicKey);
  });

  it("rejects a duplicate explicit name against the real schema constraint", async () => {
    const storage = createSqliteStorage(":memory:");
    const first = await createAgent({ storage, name: "fixed-logic-owl.agent" });
    expect(first.ok).toBe(true);
    const second = await createAgent({ storage, name: "fixed-logic-owl.agent" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("DUPLICATE_NAME");
    // exactly one row exists: the unique constraint, not a client side
    // pre-check, is what rejected the second attempt
    const stored = await storage.getAgentByName("fixed-logic-owl.agent");
    expect(stored).not.toBeNull();
  });

  it("resolves the check-then-write race with concurrent creates, all names unique", async () => {
    const storage = createSqliteStorage(":memory:");
    // three concurrent creates interleave at the async crypto points, so the
    // optimistic getAgentByName reads can both say "free" before either
    // save lands. the schema unique constraint is what lets exactly one of
    // them win and drives the loser to a fresh name.
    const results = await Promise.all([createAgent({ storage }), createAgent({ storage }), createAgent({ storage })]);
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(3);
    const names = new Set(succeeded.map((r) => (r.ok ? r.value.name : "")));
    expect(names.size).toBe(3);
    // all three are really on disk, addressable through the adapter
    for (const result of succeeded) {
      if (!result.ok) continue;
      expect(await storage.getAgent(result.value.publicKey)).not.toBeNull();
    }
  });
});

// a complete persistence record in the shape the adapter expects, built
// without invoking attest() so constraint behavior can be probed directly.
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

describe("attest + sqlite storage integration", () => {
  it("attests an existing agent end to end and verifies the round trip", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, privateKey } = created.value;
    const result = await attest(
      { agentId: publicKey, task: "scan the network", output: "3 hosts up", toolsUsed: [], source: "native", idempotencyKey: "scan-1" },
      privateKey,
      storage,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = await verifyAttestation(result.value, storage);
    expect(verified.valid).toBe(true);
    // persisted and addressable through the adapter, including by the
    // idempotency key it was submitted with
    const byKey = await storage.getAttestationByIdempotencyKey(publicKey, "scan-1");
    expect(byKey).not.toBeNull();
    expect(byKey!.id).toBe(result.value.id);
    const page = await storage.getAttestations(publicKey, {});
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe(result.value.id);
  });

  it("rejects an attestation for an unknown agent against the real foreign key", async () => {
    const storage = createSqliteStorage(":memory:");
    const result = await attest(
      { agentId: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", task: "t", output: "o", source: "native" },
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      storage,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("surfaces the composite unique index as DUPLICATE_IDEMPOTENCY_KEY (the real race guard)", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const agentId = created.value.publicKey;
    await storage.saveAttestation(record(agentId, "run-1", "000000000001"));
    // the second insert with the same (agent, key) must be rejected by the
    // index itself, not by any client side check
    await expect(storage.saveAttestation(record(agentId, "run-1", "000000000002"))).rejects.toMatchObject({
      code: "DUPLICATE_IDEMPOTENCY_KEY",
    });
    // the same key under a different agent is a different row entirely
    const other = await createAgent({ storage });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    await expect(storage.saveAttestation(record(other.value.publicKey, "run-1", "000000000003"))).resolves.toBeUndefined();
  });

  it("collapses concurrent same-key attest calls into one row", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, privateKey } = created.value;
    const input = { agentId: publicKey, task: "deploy", output: "ok", toolsUsed: [], source: "native", idempotencyKey: "deploy-1" };
    const [a, b] = await Promise.all([attest(input, privateKey, storage), attest(input, privateKey, storage)]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.id).toBe(b.value.id);
    const page = await storage.getAttestations(publicKey, {});
    expect(page.items).toHaveLength(1);
  });

  it("upgrades a pre-existing database file with the guarded ALTER and idempotency index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrep-upgrade-"));
    const dbPath = join(dir, "old.db");
    try {
      // craft a database exactly as the storage pass wrote it: no
      // idempotency_key column, no composite index
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE agents (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL UNIQUE,
          signature TEXT NOT NULL,
          permissions TEXT NOT NULL,
          memory_pointer TEXT,
          created_at TEXT NOT NULL,
          manifest_version INTEGER NOT NULL
        );
        CREATE TABLE attestations (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL,
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
        CREATE TABLE registered_sources (
          source_name TEXT PRIMARY KEY,
          adapter_kind TEXT NOT NULL,
          enabled INTEGER NOT NULL
        );
      `);
      raw.close();

      // opening through the adapter must add the column and the composite
      // unique index, and stay idempotent across repeated opens
      const storage = createSqliteStorage(dbPath);
      createSqliteStorage(dbPath);
      const created = await createAgent({ storage });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { publicKey, privateKey } = created.value;
      const result = await attest(
        { agentId: publicKey, task: "upgrade", output: "ok", toolsUsed: [], source: "native", idempotencyKey: "upgrade-1" },
        privateKey,
        storage,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // the key is really persisted and deduped, proving the ALTER landed
      const byKey = await storage.getAttestationByIdempotencyKey(publicKey, "upgrade-1");
      expect(byKey).not.toBeNull();
      await expect(storage.saveAttestation(record(publicKey, "upgrade-1", "000000000099"))).rejects.toMatchObject({
        code: "DUPLICATE_IDEMPOTENCY_KEY",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// signs a revocation message { agentId, timestamp } with the given owner
// secret key, producing the exact bytes revokeAgent() verifies. mirrors the
// real caller who holds the owner private key from createAgent().
async function ownerRevocationRequest(agentId: string, secretHex: string): Promise<RevocationRequest> {
  const timestamp = new Date().toISOString();
  const signature = bytesToHex(
    await signAsync(new TextEncoder().encode(canonicalize({ agentId, timestamp })), hexToBytes(secretHex)),
  );
  return { agentId, timestamp, signature };
}

describe("revocation + sqlite storage integration", () => {
  it("real flow: create, revoke, then attest rejects with AGENT_REVOKED and verification says key revoked", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, ownerPrivateKey, privateKey } = created.value;

    // a pre-revocation attestation verifies fine
    const before = await attest({ agentId: publicKey, task: "before", output: "ok", source: "native" }, privateKey, storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    // authorized revoke with the OWNER key
    const revoked = await revokeAgent(await ownerRevocationRequest(publicKey, ownerPrivateKey), storage);
    expect(revoked.ok).toBe(true);

    // the stored record is now revoked
    expect((await storage.getAgent(publicKey))!.revokedAt).not.toBeNull();

    // attest() refuses to sign for a revoked agent
    const after = await attest(
      { agentId: publicKey, task: "after", output: "nope", source: "native", idempotencyKey: "after-1" },
      privateKey,
      storage,
    );
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe("AGENT_REVOKED");

    // the pre-revocation attestation now FAILS verification: revocation wins
    // over an otherwise-valid signature
    const revokedVerified = await verifyAttestation(before.value, storage);
    expect(revokedVerified.valid).toBe(false);
    expect(revokedVerified.reason).toBe("key revoked");
  });

  it("rejects an unauthorized revocation (identity key) and leaves the agent un-revoked", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, privateKey, ownerPrivateKey } = created.value;

    // signed with the identity key, NOT the owner key: this must fail.
    const badRequest = await ownerRevocationRequest(publicKey, privateKey);
    const result = await revokeAgent(badRequest, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_REVOCATION");

    // the agent is still live and still revocable by the real owner
    expect((await storage.getAgent(publicKey))!.revokedAt).toBeNull();
    const good = await revokeAgent(await ownerRevocationRequest(publicKey, ownerPrivateKey), storage);
    expect(good.ok).toBe(true);
  });

  it("is idempotent across a real double revoke: success both times, one persisted state", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, ownerPrivateKey } = created.value;
    const first = await revokeAgent(await ownerRevocationRequest(publicKey, ownerPrivateKey), storage);
    const second = await revokeAgent(await ownerRevocationRequest(publicKey, ownerPrivateKey), storage);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((await storage.getAgent(publicKey))!.revokedAt).not.toBeNull();
  });

  it("upgrades a pre-existing database missing both revocation columns and fails closed on a legacy row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrep-revoke-upgrade-"));
    const dbPath = join(dir, "old.db");
    try {
      // craft a database exactly as the pre-revocation-pass storage wrote it:
      // no owner_public_key and no revoked_at, and seed one legacy row that
      // has no owner key on record.
      const raw = new DatabaseSync(dbPath);
      raw.exec(`
        CREATE TABLE agents (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL UNIQUE,
          signature TEXT NOT NULL,
          permissions TEXT NOT NULL,
          memory_pointer TEXT,
          created_at TEXT NOT NULL,
          manifest_version INTEGER NOT NULL
        );
        CREATE TABLE attestations (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL,
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
        CREATE TABLE registered_sources (
          source_name TEXT PRIMARY KEY,
          adapter_kind TEXT NOT NULL,
          enabled INTEGER NOT NULL
        );
      `);
      const legacyId = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
      raw
        .prepare(
          `INSERT INTO agents (name, public_key, signature, permissions, memory_pointer, created_at, manifest_version)
           VALUES ('legacy-pig.agent', ?, 'sig', '["attest:self"]', NULL, '2026-01-01T00:00:00.000Z', 1)`,
        )
        .run(legacyId);
      raw.close();

      // opening through the adapter adds both revocation columns via the
      // guarded ALTER and stays idempotent across repeated opens.
      const storage = createSqliteStorage(dbPath);
      createSqliteStorage(dbPath);

      // the visibility column landed too, and the NOT NULL DEFAULT 'public'
      // promoted the pre-existing row exactly as required for pre-created
      // agents: it reads back public without any manual backfill.
      const legacyRead: AgentRecord | null = await storage.getAgent(legacyId);
      expect(legacyRead).not.toBeNull();
      expect(legacyRead!.visibility).toBe("public");

      // a legacy row has no owner key, so revocation fails closed with
      // OWNER_KEY_MISSING even for a well-formed request.
      const legacy = { agentId: legacyId, timestamp: new Date().toISOString(), signature: "ab".repeat(64) };
      const result = await revokeAgent(legacy, storage);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("OWNER_KEY_MISSING");
      // and it stayed un-revoked
      const stillLegacy: AgentRecord | null = await storage.getAgent(legacyId);
      expect(stillLegacy).not.toBeNull();
      expect(stillLegacy!.ownerPublicKey).toBeNull();
      expect(stillLegacy!.revokedAt).toBeNull();

      // a brand new agent on the upgraded db is fully revocable, proving the
      // new columns are real and writable.
      const created = await createAgent({ storage });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const { publicKey, ownerPrivateKey } = created.value;
      const good = await revokeAgent(await ownerRevocationRequest(publicKey, ownerPrivateKey), storage);
      expect(good.ok).toBe(true);
      expect((await storage.getAgent(publicKey))!.revokedAt).not.toBeNull();
      // and the visibility column is writable on the upgraded db: a fresh
      // agent defaults public, and setVisibility flips it to private.
      const second = await createAgent({ storage });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      const flip = await setVisibility(second.value.publicKey, "private", storage);
      expect(flip.ok).toBe(true);
      expect((await storage.getAgent(second.value.publicKey))!.visibility).toBe("private");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});