// libsql storage adapter tests against the embedded engine. every test gets
// a fresh :memory: database via createLibsqlStorage, so no state leaks
// between tests, and the async factory (a hosted client bootstraps over the
// network, unlike sqlite's sync file open) is exercised on every case.
//
// the records below are hand built (no createAgent) because storage is
// contract tested in isolation, same as storage.test.ts for sqlite. the
// foreign key tests here are also the enforcement assert: FK violations
// only surface as AGENT_NOT_FOUND when the bootstrap-time PRAGMA
// foreign_keys = ON actually took effect on the client (the B1 spike showed
// the pragma persists across execute calls, and this suite proves the
// adapter wires it in).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { createLibsqlStorage } from "../src/index.js";
import type { AgentRecord, AttestationRecord, KeyRotationRecord, RegisteredSource } from "../src/index.js";

let seq = 0;

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  seq += 1;
  return {
    name: `agent-${seq}.agent`,
    publicKey: `pk-${seq}`,
    ownerPublicKey: "d0".repeat(32),
    memoryPointer: null,
    permissions: ["attest:self"],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 2,
    signature: "sig",
    revokedAt: null,
    ...overrides,
  };
}

function makeAttestation(agentId: string, overrides: Partial<AttestationRecord> = {}): AttestationRecord {
  seq += 1;
  return {
    rowId: 0,
    id: `att-${seq}`,
    agentId,
    task: "build the schema",
    output: "done",
    toolsUsed: [{ tool: "bash", input: "ls" }],
    source: "native",
    contentHash: `hash-${seq}`,
    signature: "sig",
    signedBy: agentId,
    timestamp: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
    ...overrides,
  };
}

async function makeStorage() {
  return createLibsqlStorage({ url: ":memory:" });
}

describe("libsql storage adapter: agents", () => {
  it("persists a full agent record and reads it back by canonical id", async () => {
    const storage = await makeStorage();
    const record = makeAgent({
      name: "beautiful-pig-black.agent",
      publicKey: "pk-roundtrip",
      memoryPointer: "ipfs://QmExample",
      permissions: ["attest:self", "ingest:external"],
    });
    await storage.saveAgent(record);
    const readBack = await storage.getAgent(record.publicKey);
    expect(readBack).not.toBeNull();
    expect(readBack!.name).toBe("beautiful-pig-black.agent");
    expect(readBack!.publicKey).toBe("pk-roundtrip");
    expect(readBack!.memoryPointer).toBe("ipfs://QmExample");
    expect(readBack!.permissions).toEqual(["attest:self", "ingest:external"]);
    expect(readBack!.createdAt).toBe(record.createdAt);
    expect(readBack!.manifestVersion).toBe(record.manifestVersion);
    expect(readBack!.signature).toBe(record.signature);
    expect(readBack!.rowId).toBeGreaterThan(0);
  });

  it("looks a record up by name and returns null for unknown ids and names", async () => {
    const storage = await makeStorage();
    const record = makeAgent({ name: "findable.agent", publicKey: "pk-findable" });
    await storage.saveAgent(record);
    const byName = await storage.getAgentByName("findable.agent");
    expect(byName).not.toBeNull();
    expect(byName!.publicKey).toBe("pk-findable");
    expect(await storage.getAgent("pk-unknown")).toBeNull();
    expect(await storage.getAgentByName("missing.agent")).toBeNull();
  });

  it("round trips a null memory pointer", async () => {
    const storage = await makeStorage();
    await storage.saveAgent(makeAgent({ name: "null-pointer.agent", memoryPointer: null }));
    const readBack = await storage.getAgentByName("null-pointer.agent");
    expect(readBack!.memoryPointer).toBeNull();
  });

  it("rejects a duplicate name with exactly code DUPLICATE_NAME", async () => {
    const storage = await makeStorage();
    await storage.saveAgent(makeAgent({ name: "fixed-logic-owl.agent" }));
    await expect(storage.saveAgent(makeAgent({ name: "fixed-logic-owl.agent" }))).rejects.toMatchObject({
      code: "DUPLICATE_NAME",
    });
    await storage.saveAgent(makeAgent({ name: "other-name.agent" }));
  });

  it("reports a public key collision as DUPLICATE_PUBLIC_KEY, never as a name conflict", async () => {
    const storage = await makeStorage();
    await storage.saveAgent(makeAgent({ name: "one.agent", publicKey: "pk-shared" }));
    await expect(storage.saveAgent(makeAgent({ name: "two.agent", publicKey: "pk-shared" }))).rejects.toMatchObject({
      code: "DUPLICATE_PUBLIC_KEY",
    });
  });

  it("refuses to persist a record carrying a private key even when the type system is bypassed", async () => {
    const storage = await makeStorage();
    const record = makeAgent({ name: "leaky.agent" });
    const smuggled = { ...record, privateKey: "deadbeef" } as unknown as AgentRecord;
    await expect(storage.saveAgent(smuggled)).rejects.toThrow(/private key/);
    expect(await storage.getAgentByName("leaky.agent")).toBeNull();
  });

  it("stores an sql-injection shaped name literally and the table survives it", async () => {
    const storage = await makeStorage();
    const hostile = "x'); DROP TABLE agents;--";
    await storage.saveAgent(makeAgent({ name: hostile, publicKey: "pk-inject" }));
    const readBack = await storage.getAgentByName(hostile);
    expect(readBack).not.toBeNull();
    expect(readBack!.name).toBe(hostile);
    await storage.saveAgent(makeAgent({ name: "after-inject.agent", publicKey: "pk-after" }));
    expect(await storage.getAgentByName("after-inject.agent")).not.toBeNull();
  });
});

describe("libsql storage adapter: attestations", () => {
  it("persists a full attestation and reads it back", async () => {
    const storage = await makeStorage();
    const agent = makeAgent();
    await storage.saveAgent(agent);
    const attestation = makeAttestation(agent.publicKey, {
      toolsUsed: [
        { tool: "bash", input: { cmd: "ls" }, output: "files" },
        { tool: "read", input: "x" },
      ],
    });
    await storage.saveAttestation(attestation);
    const page = await storage.getAttestations(agent.publicKey);
    expect(page.items).toHaveLength(1);
    const readBack = page.items[0];
    expect(readBack.id).toBe(attestation.id);
    expect(readBack.agentId).toBe(agent.publicKey);
    expect(readBack.task).toBe(attestation.task);
    expect(readBack.output).toBe(attestation.output);
    expect(readBack.toolsUsed).toEqual(attestation.toolsUsed);
    expect(readBack.source).toBe(attestation.source);
    expect(readBack.contentHash).toBe(attestation.contentHash);
    expect(readBack.signature).toBe(attestation.signature);
    expect(readBack.signedBy).toBe(attestation.signedBy);
    expect(readBack.timestamp).toBe(attestation.timestamp);
    expect(readBack.schemaVersion).toBe(attestation.schemaVersion);
    expect(readBack.rowId).toBeGreaterThan(0);
  });

  it("lists attestations newest first", async () => {
    const storage = await makeStorage();
    const agent = makeAgent();
    await storage.saveAgent(agent);
    for (const id of ["att-first", "att-second", "att-third"]) {
      await storage.saveAttestation(makeAttestation(agent.publicKey, { id }));
    }
    const page = await storage.getAttestations(agent.publicKey);
    expect(page.items.map((a) => a.id)).toEqual(["att-third", "att-second", "att-first"]);
  });

  it("never returns another agent's attestations", async () => {
    const storage = await makeStorage();
    const agentA = makeAgent();
    const agentB = makeAgent();
    await storage.saveAgent(agentA);
    await storage.saveAgent(agentB);
    await storage.saveAttestation(makeAttestation(agentA.publicKey, { id: "att-a" }));
    await storage.saveAttestation(makeAttestation(agentB.publicKey, { id: "att-b" }));
    const forA = await storage.getAttestations(agentA.publicKey);
    expect(forA.items.map((a) => a.id)).toEqual(["att-a"]);
  });

  it("walks cursor pagination across every page without loss or duplication", async () => {
    const storage = await makeStorage();
    const agent = makeAgent();
    await storage.saveAgent(agent);
    for (let i = 1; i <= 5; i++) await storage.saveAttestation(makeAttestation(agent.publicKey, { id: `att-${i}` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await storage.getAttestations(agent.publicKey, { cursor: cursor ?? undefined, limit: 2 });
      pages += 1;
      seen.push(...page.items.map((a) => a.id));
      cursor = page.nextCursor;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(["att-5", "att-4", "att-3", "att-2", "att-1"]);
  });

  it("keeps already returned pages stable when new attestations land between page loads", async () => {
    const storage = await makeStorage();
    const agent = makeAgent();
    await storage.saveAgent(agent);
    for (let i = 1; i <= 4; i++) await storage.saveAttestation(makeAttestation(agent.publicKey, { id: `att-${i}` }));
    const page1 = await storage.getAttestations(agent.publicKey, { limit: 2 });
    expect(page1.items.map((a) => a.id)).toEqual(["att-4", "att-3"]);
    for (let i = 5; i <= 6; i++) await storage.saveAttestation(makeAttestation(agent.publicKey, { id: `att-${i}` }));
    const page2 = await storage.getAttestations(agent.publicKey, { cursor: page1.nextCursor!, limit: 2 });
    expect(page2.items.map((a) => a.id)).toEqual(["att-2", "att-1"]);
  });

  it("defaults to a 50 item page and continues from the returned cursor", async () => {
    const storage = await makeStorage();
    const agent = makeAgent();
    await storage.saveAgent(agent);
    for (let i = 1; i <= 60; i++) await storage.saveAttestation(makeAttestation(agent.publicKey, { id: `att-${i}` }));
    const page1 = await storage.getAttestations(agent.publicKey);
    expect(page1.items).toHaveLength(50);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await storage.getAttestations(agent.publicKey, { cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(10);
    expect(page2.nextCursor).toBeNull();
  });

  it("rejects invalid pagination params before running any query", async () => {
    const storage = await makeStorage();
    const agent = makeAgent();
    await storage.saveAgent(agent);
    await storage.saveAttestation(makeAttestation(agent.publicKey, { id: "att-1" }));
    const badPagination: Array<{ cursor?: string; limit?: number }> = [
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: 1001 },
      { cursor: "abc" },
      { cursor: "-1" },
      { cursor: "1.5" },
    ];
    for (const bad of badPagination) {
      await expect(storage.getAttestations(agent.publicKey, bad)).rejects.toThrow();
    }
  });

  it("fails via the foreign key when the referenced agent does not exist, with code AGENT_NOT_FOUND", async () => {
    const storage = await makeStorage();
    await expect(storage.saveAttestation(makeAttestation("pk-nonexistent"))).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("libsql storage adapter: revokeAgent", () => {
  it("sets revoked_at on the matching row and round trips it", async () => {
    const storage = await makeStorage();
    const record = makeAgent({ name: "revocable.agent" });
    await storage.saveAgent(record);
    await storage.revokeAgent(record.publicKey, "2026-02-01T00:00:00.000Z");
    const readBack = await storage.getAgent(record.publicKey);
    expect(readBack).not.toBeNull();
    expect(readBack!.revokedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(readBack!.name).toBe(record.name);
    expect(readBack!.ownerPublicKey).toBe(record.ownerPublicKey);
  });

  it("is idempotent: revoking an already revoked agent overwrites, never errors", async () => {
    const storage = await makeStorage();
    const record = makeAgent({ name: "twice-revoked.agent" });
    await storage.saveAgent(record);
    await storage.revokeAgent(record.publicKey, "2026-02-01T00:00:00.000Z");
    await storage.revokeAgent(record.publicKey, "2026-02-02T00:00:00.000Z");
    const readBack = await storage.getAgent(record.publicKey);
    expect(readBack!.revokedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("throws AGENT_NOT_FOUND when zero rows match", async () => {
    const storage = await makeStorage();
    await expect(storage.revokeAgent("pk-nonexistent", "2026-02-01T00:00:00.000Z")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("libsql storage adapter: registered sources", () => {
  it("round trips sources ordered by name", async () => {
    const storage = await makeStorage();
    const sources: RegisteredSource[] = [
      { sourceName: "zeta-platform", registeredAt: "2026-01-01T00:00:00.000Z", trustWeight: 0.5 },
      { sourceName: "alpha-platform", registeredAt: "2026-01-02T00:00:00.000Z", trustWeight: 1 },
    ];
    for (const source of sources) await storage.saveRegisteredSource(source);
    const all = await storage.getRegisteredSources();
    expect(all.map((s) => s.sourceName)).toEqual(["alpha-platform", "zeta-platform"]);
    expect(all.find((s) => s.sourceName === "zeta-platform")).toEqual(sources[0]);
    expect(all.find((s) => s.sourceName === "alpha-platform")).toEqual(sources[1]);
  });

  it("rejects a duplicate source name with code DUPLICATE_SOURCE_NAME", async () => {
    const storage = await makeStorage();
    await storage.saveRegisteredSource({ sourceName: "alpha-platform", registeredAt: "2026-01-01T00:00:00.000Z", trustWeight: 1 });
    await expect(
      storage.saveRegisteredSource({ sourceName: "alpha-platform", registeredAt: "2026-01-02T00:00:00.000Z", trustWeight: 2 }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SOURCE_NAME" });
  });
});

describe("libsql storage adapter: bootstrap and upgrade", () => {
  it("guarded ALTERs upgrade a legacy database file, and reopening stays idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrep-libsql-upgrade-"));
    const dbPath = join(dir, "old.db");
    try {
      // craft a database exactly as the storage pass wrote it before the
      // idempotency, revocation, and external verification columns: no
      // composite index, no owner key, no revoked_at.
      const raw = createClient({ url: `file:${dbPath}` });
      await raw.batch(
        [
          `CREATE TABLE agents (
            row_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            public_key TEXT NOT NULL UNIQUE,
            signature TEXT NOT NULL,
            permissions TEXT NOT NULL,
            memory_pointer TEXT,
            created_at TEXT NOT NULL,
            manifest_version INTEGER NOT NULL
          )`,
          `CREATE TABLE attestations (
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
          )`,
        ],
        "deferred",
      );
      await raw.close();

      // opening through the adapter must add the columns and the composite
      // unique index via the guarded ALTERs, and survive repeated opens.
      await createLibsqlStorage({ url: `file:${dbPath}` });
      const storage = await createLibsqlStorage({ url: `file:${dbPath}` });

      const record = makeAgent({ name: "upgraded.agent" });
      await storage.saveAgent(record);
      await storage.saveAttestation(makeAttestation(record.publicKey, { id: "att-upgraded", idempotencyKey: "upgrade-key" }));
      // the composite index really landed: same (agent, key) now collides
      await expect(
        storage.saveAttestation(makeAttestation(record.publicKey, { id: "att-upgraded-2", idempotencyKey: "upgrade-key" })),
      ).rejects.toMatchObject({ code: "DUPLICATE_IDEMPOTENCY_KEY" });
      // the revocation columns really landed
      await storage.revokeAgent(record.publicKey, "2026-02-01T00:00:00.000Z");
      expect((await storage.getAgent(record.publicKey))!.revokedAt).toBe("2026-02-01T00:00:00.000Z");
      // external_verification really landed
      await storage.saveAttestation(
        makeAttestation(record.publicKey, {
          id: "att-ext",
          externalVerification: { checked: true, valid: true, reason: null },
        }),
      );
      const ext = await storage.getAttestations(record.publicKey);
      const extRow = ext.items.find((a) => a.id === "att-ext");
      expect(extRow!.externalVerification).toEqual({ checked: true, valid: true, reason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close() releases the client and a second close is harmless", async () => {
    const storage = await makeStorage();
    await storage.saveAgent(makeAgent({ name: "closeable.agent" }));
    await storage.close();
    await storage.close();
  });
});

describe("libsql storage adapter: wal hardening", () => {
  it("puts an embedded file database into WAL journal mode, persistent across clients", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrep-libsql-wal-"));
    const dbPath = join(dir, "openrep.db");
    try {
      const storage = await createLibsqlStorage({ url: `file:${dbPath}` });
      await storage.saveAgent(makeAgent({ name: "wal-file.agent" }));
      await storage.close();

      // journal_mode is a persistent file property, so a SEPARATE client
      // (the cli/later-connection analogue) must find the file already in
      // WAL, exactly like the sqlite adapter's guarantee.
      const raw = createClient({ url: `file:${dbPath}` });
      const journal = await raw.execute("PRAGMA journal_mode");
      await raw.close();
      expect(journal.rows[0]?.["journal_mode"]).toBe("wal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves :memory: databases untouched (WAL is impossible, no error)", async () => {
    const storage = await createLibsqlStorage({ url: ":memory:" });
    await storage.saveAgent(makeAgent({ name: "wal-memory.agent" }));
    const raw = createClient({ url: ":memory:" });
    const journal = await raw.execute("PRAGMA journal_mode");
    await raw.close();
    expect(journal.rows[0]?.["journal_mode"]).toBe("memory");
    await storage.close();
  });
});

function makeRotation(oldPublicKey: string, newPublicKey: string): KeyRotationRecord {
  return {
    oldPublicKey,
    newPublicKey,
    signedBy: "d0".repeat(32),
    timestamp: "2026-03-01T00:00:00.000Z",
    signature: "e0".repeat(64),
  };
}

describe("libsql storage adapter: key rotation", () => {
  it("persists the successor agent and its audit record atomically (one write batch), reachable from either end", async () => {
    const storage = await makeStorage();
    const oldId = makeAgent({ name: "libsql-old-lineage.agent" });
    await storage.saveAgent(oldId);
    const successor = makeAgent({ name: "libsql-successor.agent" });
    const rotation = makeRotation(oldId.publicKey, successor.publicKey);

    await storage.rotateAgent(successor, rotation);

    expect((await storage.getAgent(successor.publicKey))!.name).toBe("libsql-successor.agent");
    expect(await storage.getKeyRotations(oldId.publicKey)).toEqual([rotation]);
    expect(await storage.getKeyRotations(successor.publicKey)).toEqual([rotation]);
    await storage.close();
  });

  it("rolls back the whole write batch on a name collision, leaving no successor and no audit row", async () => {
    const storage = await makeStorage();
    const oldId = makeAgent({ name: "libsql-rotating.agent" });
    await storage.saveAgent(oldId);
    const successor = makeAgent({ name: "libsql-rotating.agent", publicKey: "pk-libsql-collider" }); // same name

    await expect(
      storage.rotateAgent(successor, makeRotation(oldId.publicKey, successor.publicKey)),
    ).rejects.toMatchObject({ code: "DUPLICATE_NAME" });

    // same no-partial-state proof as sqlite: no successor row, no dangling
    // audit row, because the batch transaction rolled back as one unit.
    expect(await storage.getAgent("pk-libsql-collider")).toBeNull();
    expect(await storage.getKeyRotations(oldId.publicKey)).toEqual([]);
    await storage.close();
  });
});