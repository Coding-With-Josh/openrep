// durable session key store tests against real storage engines. every
// behavioral test runs twice, once against node's built-in sqlite adapter
// and once against the embedded libsql engine, because the store itself is
// engine agnostic but the persisted session_keys table is the whole point:
// a session row must survive whatever backend, a wrong owner must never see
// another owner's envelope, and expiry must be enforced from the stored
// timestamp, not from process memory.
//
// security properties asserted explicitly:
// - the row never carries a raw key or the master key: SessionKeyRow cannot
//   express one structurally, and we assert the serialized row contains
//   neither (the aes-256-gcm ciphertext is base64, which cannot contain the
//   master key's "-" characters, so this is a real invariant, not a flaky
//   substring check).
// - a wrong owner gets a miss (null), never a fallthrough to another
//   owner's row, so one browser cannot recover another browser's keys.
// - expired sessions are misses AND deleted (lazy prune), so expiry is
//   enforced from stored time, and clearExpired removes only expired rows.
// - the envelope round trips through a fresh connection on a real file
//   unchanged: a server restart (or serverless cold start) must forget
//   nothing that was already persisted.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DurableSessionKeyStore,
  createLibsqlStorage,
  createSqliteStorage,
  decryptPrivateKey,
  encryptPrivateKey,
  type AgentRecord,
  type EncryptedKeyRecord,
  type SessionKeyBackend,
} from "../src/index.js";

const MASTER = "durable-store-master-key-0123456789";
const RAW = "af".repeat(32);
const OWNER_A = "owner-browser-a";
const OWNER_B = "owner-browser-b";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;

function makeAgent(): AgentRecord {
  seq += 1;
  return {
    name: `durable-${seq}.agent`,
    publicKey: `pk-durable-${seq}`,
    ownerPublicKey: "d0".repeat(32),
    memoryPointer: null,
    permissions: ["attest:self"],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 2,
    signature: "sig",
    revokedAt: null,
    visibility: "public",
  };
}

async function makeBackend(kind: "sqlite" | "libsql"): Promise<SessionKeyBackend> {
  // both factories now return StorageAdapter & SessionKeyBackend: one handle
  // for the reputation ledger and for session key custody, exactly what the
  // web layer needs. saveAgent exists on both, so the agent foreign key on
  // session_keys is satisfiable from the same object.
  if (kind === "sqlite") return createSqliteStorage(":memory:");
  return createLibsqlStorage({ url: ":memory:" });
}

function encryptedFor(agentId: string): EncryptedKeyRecord {
  const record = encryptPrivateKey(RAW, MASTER, agentId);
  expect(record.agentId).toBe(agentId);
  return record;
}

describe("DurableSessionKeyStore", () => {
  it.each(["sqlite", "libsql"] as const)(
    "round trips a real encrypted envelope through %s without touching the raw key",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend);
      const agent = makeAgent();
      await backend.saveAgent(agent);
      const record = encryptedFor(agent.publicKey);

      await store.set(agent.publicKey, OWNER_A, record);

      const stored = await store.get(agent.publicKey, OWNER_A);
      expect(stored).not.toBeNull();
      if (stored === null) return;
      expect(stored.agentId).toBe(agent.publicKey);
      expect(stored.encryptedPrivateKey).toBe(record.encryptedPrivateKey);
      expect(stored.iv).toBe(record.iv);
      expect(stored.algorithm).toBe(record.algorithm);
      expect(stored.createdAt).toBe(record.createdAt);
      // the envelope decrypts to the original key under the right master...
      const decrypted = decryptPrivateKey(stored, MASTER);
      expect(decrypted.ok).toBe(true);
      if (decrypted.ok) expect(decrypted.value).toBe(RAW);
      // ...and the raw key or master key never made it into any persisted
      // field (base64 ciphertext cannot contain the master key's "-").
      const row = await backend.getSessionKey(agent.publicKey, OWNER_A);
      expect(row).not.toBeNull();
      if (row === null) return;
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(RAW);
      expect(serialized).not.toContain(MASTER);
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "replaces the previous envelope for the same pair on %s (upsert, one row)",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend);
      const agent = makeAgent();
      await backend.saveAgent(agent);

      await store.set(agent.publicKey, OWNER_A, encryptedFor(agent.publicKey));
      const second = encryptedFor(agent.publicKey);
      await store.set(agent.publicKey, OWNER_A, second);

      const stored = await store.get(agent.publicKey, OWNER_A);
      expect(stored?.encryptedPrivateKey).toBe(second.encryptedPrivateKey);
      // one row per pair: the old envelope is gone, not shadowed.
      const row = await backend.getSessionKey(agent.publicKey, OWNER_A);
      expect(row?.encryptedPrivateKey).toBe(second.encryptedPrivateKey);
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "treats an expired session as a miss and prunes the row on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend, { windowMs: 30 });
      const agent = makeAgent();
      await backend.saveAgent(agent);
      await store.set(agent.publicKey, OWNER_A, encryptedFor(agent.publicKey));

      await sleep(60);
      const stored = await store.get(agent.publicKey, OWNER_A);
      expect(stored).toBeNull();
      // lazy prune: the expired row is deleted, not soft-deleted.
      expect(await backend.getSessionKey(agent.publicKey, OWNER_A)).toBeNull();
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "a live get slides the stored expiry forward on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend, { windowMs: 10_000 });
      const agent = makeAgent();
      await backend.saveAgent(agent);
      await store.set(agent.publicKey, OWNER_A, encryptedFor(agent.publicKey));

      const before = await backend.getSessionKey(agent.publicKey, OWNER_A);
      await sleep(15); // guarantee the wall clock advances past ms precision
      await store.get(agent.publicKey, OWNER_A);
      const after = await backend.getSessionKey(agent.publicKey, OWNER_A);
      expect(after!.expiresAtEpochMs).toBeGreaterThan(before!.expiresAtEpochMs);
      // and the record the caller received is the same envelope, unchanged.
      const stored = await store.get(agent.publicKey, OWNER_A);
      expect(decryptPrivateKey(stored!, MASTER).ok).toBe(true);
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "keeps two owners of the same agent fully isolated on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend);
      const agent = makeAgent();
      await backend.saveAgent(agent);

      const recordA = encryptedFor(agent.publicKey);
      const recordB = encryptedFor(agent.publicKey);
      await store.set(agent.publicKey, OWNER_A, recordA);
      await store.set(agent.publicKey, OWNER_B, recordB);

      // each owner sees only its own envelope...
      const viaA = await store.get(agent.publicKey, OWNER_A);
      const viaB = await store.get(agent.publicKey, OWNER_B);
      expect(viaA?.encryptedPrivateKey).toBe(recordA.encryptedPrivateKey);
      expect(viaB?.encryptedPrivateKey).toBe(recordB.encryptedPrivateKey);
      // ...and the backend read is pair scoped: the stored rows differ and
      // a wrong owner is a miss, never a fallthrough.
      const wrong = await backend.getSessionKey(agent.publicKey, "owner-who-does-not-exist");
      expect(wrong).toBeNull();
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "returns a miss for an agent or owner that was never written on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend);
      // no agent row at all: reads are pair-scoped selects, they must miss
      // cleanly instead of throwing over a nonexistent identity (the
      // foreign key only governs writes).
      expect(await store.get("pk-never-saved", OWNER_A)).toBeNull();
      // delete on a never-written pair is a no-op, not an error.
      await expect(store.delete("pk-never-saved", OWNER_A)).resolves.toBeUndefined();
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "delete removes the row outright on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend);
      const agent = makeAgent();
      await backend.saveAgent(agent);
      await store.set(agent.publicKey, OWNER_A, encryptedFor(agent.publicKey));

      await store.delete(agent.publicKey, OWNER_A);

      expect(await store.get(agent.publicKey, OWNER_A)).toBeNull();
      expect(await backend.getSessionKey(agent.publicKey, OWNER_A)).toBeNull();
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "clearExpired sweeps only expired rows on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend, { windowMs: 60_000 });
      const agent = makeAgent();
      await backend.saveAgent(agent);
      await store.set(agent.publicKey, OWNER_A, encryptedFor(agent.publicKey));

      // plant an already-expired row for the same agent under another owner
      // (past expiry, so any sweep must take it).
      await backend.setSessionKey({
        agentId: agent.publicKey,
        ownerUserId: OWNER_B,
        encryptedPrivateKey: "planted",
        iv: "planted",
        algorithm: "planted",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAtEpochMs: Date.now() - 1_000,
      });

      await store.clearExpired();

      expect(await store.get(agent.publicKey, OWNER_B)).toBeNull();
      const live = await store.get(agent.publicKey, OWNER_A);
      expect(live).not.toBeNull();
      expect(await backend.getSessionKey(agent.publicKey, OWNER_A)).not.toBeNull();
    },
  );

  it.each(["sqlite", "libsql"] as const)(
    "refuses to store an envelope under a mismatched agent key on %s",
    async (kind) => {
      const backend = await makeBackend(kind);
      const store = new DurableSessionKeyStore(backend);
      const agent = makeAgent();
      await backend.saveAgent(agent);
      const record = encryptedFor("some-other-agent-id");

      await expect(store.set(agent.publicKey, OWNER_A, record)).rejects.toThrow(/refusing to store/);
      // nothing was written by the rejected call.
      expect(await backend.getSessionKey(agent.publicKey, OWNER_A)).toBeNull();
    },
  );

  it("window option is validated up front, like the in-memory store", () => {
    expect(() => new DurableSessionKeyStore(null as unknown as SessionKeyBackend, { windowMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => new DurableSessionKeyStore(null as unknown as SessionKeyBackend, { windowMs: 1.5 })).toThrow(
      RangeError,
    );
  });

  it("a session set before a restart is still live after a fresh connection", async () => {
    // file-backed sqlite only: reopen the same path with a brand new
    // adapter, which is what a server restart (or serverless cold start)
    // does, and prove the envelope survived with no memory carried over.
    const dir = mkdtempSync(join(tmpdir(), "openrep-durable-"));
    const dbPath = join(dir, "session.db");
    try {
      const first = createSqliteStorage(dbPath);
      const agent = makeAgent();
      await first.saveAgent(agent);
      await new DurableSessionKeyStore(first).set(agent.publicKey, OWNER_A, encryptedFor(agent.publicKey));

      const second = createSqliteStorage(dbPath);
      const store = new DurableSessionKeyStore(second);
      const stored = await store.get(agent.publicKey, OWNER_A);
      expect(stored).not.toBeNull();
      const decrypted = decryptPrivateKey(stored!, MASTER);
      expect(decrypted.ok).toBe(true);
      if (decrypted.ok) expect(decrypted.value).toBe(RAW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});