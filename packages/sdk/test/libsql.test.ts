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
import type {
  AccountLink,
  AgentRecord,
  AttestationRecord,
  ChatMessageRecord,
  KeyRotationRecord,
  RegisteredSource,
  UserRecord,
} from "../src/index.js";

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

// the account-layer fixtures are hand built like every other storage
// fixture: persistence must work for structurally valid records, and
// password hashing is the web layer's job, not this adapter's.
function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
  seq += 1;
  return {
    id: `user-${seq}`,
    email: `user-${seq}@example.com`,
    passwordHash: "scrypt:16384:8:1:salt:hash",
    name: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeAccountLink(userId: string, overrides: Partial<AccountLink> = {}): AccountLink {
  seq += 1;
  return {
    id: `link-${seq}`,
    userId,
    provider: "google",
    providerAccountId: `sub-${seq}`,
    createdAt: "2026-01-01T00:00:00.000Z",
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

// chat messages are hand built like the agent and attestation fixtures: the
// adapter only persists what it is given, the pair is set per call.
function makeMessage(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
  seq += 1;
  return {
    agentId: "pk-unset",
    ownerUserId: "owner-unset",
    role: "user",
    content: `message ${seq}`,
    toolsUsed: [],
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeSessionKey(agentId: string, ownerUserId: string) {
  return {
    agentId,
    ownerUserId,
    encryptedPrivateKey: "enc",
    iv: "iv",
    algorithm: "aes-256-gcm",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAtEpochMs: 9999999999999,
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

describe("libsql storage adapter: chat history", () => {
  it("creates one session per ownership pair, get-or-create returns the existing id", async () => {
    const storage = await makeStorage();
    const agent = makeAgent({ name: "libsql-chatty.agent" });
    await storage.saveAgent(agent);

    const first = await storage.createChatSession(agent.publicKey, "owner-a", "2026-01-01T00:00:00.000Z");
    expect(first.id.length).toBeGreaterThan(0);
    expect(first.agentId).toBe(agent.publicKey);
    expect(first.ownerUserId).toBe("owner-a");

    // a second create for the same pair is a no-op returning the same row,
    // never a second session; the schema unique pair is the guard.
    const again = await storage.createChatSession(agent.publicKey, "owner-a", "2026-01-02T00:00:00.000Z");
    expect(again.id).toBe(first.id);

    // a different owner gets their own session for the same agent.
    const ownerB = await storage.createChatSession(agent.publicKey, "owner-b", "2026-01-01T00:00:00.000Z");
    expect(ownerB.id).not.toBe(first.id);
    await storage.close();
  });

  it("throws AGENT_NOT_FOUND when the session references a nonexistent agent", async () => {
    const storage = await makeStorage();
    await expect(
      storage.createChatSession("pk-no-such-agent", "owner-a", "2026-01-01T00:00:00.000Z"),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await storage.close();
  });

  it("persists messages oldest first and round trips tool calls", async () => {
    const storage = await makeStorage();
    const agent = makeAgent({ name: "libsql-chat-record.agent" });
    await storage.saveAgent(agent);
    await storage.createChatSession(agent.publicKey, "owner-a", "2026-01-01T00:00:00.000Z");

    await storage.appendChatMessage(
      makeMessage({ agentId: agent.publicKey, ownerUserId: "owner-a", role: "user", content: "build a schema" }),
    );
    await storage.appendChatMessage(
      makeMessage({
        agentId: agent.publicKey,
        ownerUserId: "owner-a",
        role: "assistant",
        content: "done",
        toolsUsed: [{ tool: "bash", input: "ls" }],
        timestamp: "2026-01-01T00:00:01.000Z",
      }),
    );

    const messages = await storage.getChatMessages(agent.publicKey, "owner-a");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages.map((m) => m.content)).toEqual(["build a schema", "done"]);
    expect(messages[1].toolsUsed).toEqual([{ tool: "bash", input: "ls" }]);
    await storage.close();
  });

  it("appending to a pair with no session fails closed with CHAT_SESSION_NOT_FOUND", async () => {
    const storage = await makeStorage();
    const agent = makeAgent({ name: "libsql-chatless.agent" });
    await storage.saveAgent(agent);
    // no createChatSession call on purpose: the write must not silently land
    await expect(
      storage.appendChatMessage(makeMessage({ agentId: agent.publicKey, ownerUserId: "owner-a", content: "hello" })),
    ).rejects.toMatchObject({ code: "CHAT_SESSION_NOT_FOUND" });
    // and nothing landed
    expect(await storage.getChatMessages(agent.publicKey, "owner-a")).toEqual([]);
    await storage.close();
  });

  it("is pair scoped: a wrong owner never reads another owner's session or messages", async () => {
    const storage = await makeStorage();
    const agent = makeAgent({ name: "libsql-scoped.agent" });
    await storage.saveAgent(agent);
    await storage.createChatSession(agent.publicKey, "owner-a", "2026-01-01T00:00:00.000Z");
    await storage.appendChatMessage(
      makeMessage({ agentId: agent.publicKey, ownerUserId: "owner-a", role: "user", content: "secret" }),
    );

    expect(await storage.getChatSession(agent.publicKey, "owner-b")).toBeNull();
    expect(await storage.getChatMessages(agent.publicKey, "owner-b")).toEqual([]);
    await expect(
      storage.appendChatMessage(
        makeMessage({ agentId: agent.publicKey, ownerUserId: "owner-b", role: "user", content: "trespass" }),
      ),
    ).rejects.toMatchObject({ code: "CHAT_SESSION_NOT_FOUND" });
    await storage.close();
  });
});

describe("libsql storage adapter: owned agent listing", () => {
  it("lists exactly the agents the owner holds a session key for, oldest ownership first", async () => {
    const storage = await makeStorage();
    const agentA = makeAgent({ name: "libsql-owned-a.agent" });
    const agentB = makeAgent({ name: "libsql-owned-b.agent" });
    const agentC = makeAgent({ name: "libsql-foreign.agent" });
    await storage.saveAgent(agentA);
    await storage.saveAgent(agentB);
    await storage.saveAgent(agentC);

    // ownership insertion order intentionally differs from agent creation
    // order so the assertion proves the list follows ownership, not ancestry.
    await storage.setSessionKey(makeSessionKey(agentB.publicKey, "owner-a"));
    await storage.setSessionKey(makeSessionKey(agentA.publicKey, "owner-a"));
    // a different owner holds a key for agentC
    await storage.setSessionKey(makeSessionKey(agentC.publicKey, "owner-b"));

    const owned = await storage.listOwnedAgents("owner-a");
    expect(owned.map((a) => a.publicKey)).toEqual([agentB.publicKey, agentA.publicKey]);
    // the foreign owner's agent never appears (query level scoping, not ui)
    expect(owned.map((a) => a.name)).not.toContain("libsql-foreign.agent");

    expect(await storage.listOwnedAgents("no-such-owner")).toEqual([]);
    await storage.close();
  });
});

describe("libsql storage adapter: users and account links", () => {
  it("persists a user with a scrypt hash and reads it back by email and id", async () => {
    const storage = await makeStorage();
    const user = makeUser({ email: "alice@example.com", name: "Alice" });
    await storage.createUser(user);
    const byEmail = await storage.getUserByEmail("alice@example.com");
    expect(byEmail).not.toBeNull();
    expect(byEmail!.id).toBe(user.id);
    expect(byEmail!.passwordHash).toBe("scrypt:16384:8:1:salt:hash");
    expect(byEmail!.name).toBe("Alice");
    expect(await storage.getUserById(user.id)).toEqual(byEmail);
    expect(await storage.getUserByEmail("missing@example.com")).toBeNull();
    expect(await storage.getUserById("no-such-user")).toBeNull();
    await storage.close();
  });

  it("round trips a null password hash for an oauth-only account", async () => {
    const storage = await makeStorage();
    await storage.createUser(makeUser({ email: "oauth@example.com", passwordHash: null }));
    expect((await storage.getUserByEmail("oauth@example.com"))!.passwordHash).toBeNull();
    await storage.close();
  });

  it("rejects a duplicate email with exactly code DUPLICATE_EMAIL", async () => {
    const storage = await makeStorage();
    await storage.createUser(makeUser({ email: "dup@example.com" }));
    await expect(storage.createUser(makeUser({ email: "dup@example.com" }))).rejects.toMatchObject({
      code: "DUPLICATE_EMAIL",
    });
    await storage.createUser(makeUser({ email: "other@example.com" }));
    await storage.close();
  });

  it("round trips an account link by (provider, provider_account_id)", async () => {
    const storage = await makeStorage();
    const user = makeUser({ email: "link@example.com" });
    await storage.createUser(user);
    const link = makeAccountLink(user.id, { provider: "credentials", providerAccountId: user.id });
    await storage.createAccountLink(link);
    const readBack = await storage.getAccountLink("credentials", user.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.userId).toBe(user.id);
    expect(await storage.getAccountLink("credentials", "other-sub")).toBeNull();
    expect(await storage.getAccountLink("google", "sub-1")).toBeNull();
    await storage.close();
  });

  it("rejects a duplicate (provider, provider_account_id) with code DUPLICATE_ACCOUNT", async () => {
    const storage = await makeStorage();
    const first = makeUser({ email: "first@example.com" });
    const second = makeUser({ email: "second@example.com" });
    await storage.createUser(first);
    await storage.createUser(second);
    await storage.createAccountLink(makeAccountLink(first.id, { providerAccountId: "same-sub" }));
    await expect(
      storage.createAccountLink(makeAccountLink(second.id, { providerAccountId: "same-sub" })),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACCOUNT" });
    await storage.close();
  });

  it("rejects an account link naming a missing user with code USER_NOT_FOUND", async () => {
    const storage = await makeStorage();
    await expect(storage.createAccountLink(makeAccountLink("no-such-user"))).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
    await storage.close();
  });
});

describe("libsql storage adapter: mergeOwner", () => {
  it("moves session keys and chat sessions between owners in one transaction", async () => {
    const storage = await makeStorage();
    const agentA = makeAgent({ name: "libsql-merge-a.agent" });
    const agentB = makeAgent({ name: "libsql-merge-b.agent" });
    await storage.saveAgent(agentA);
    await storage.saveAgent(agentB);

    await storage.setSessionKey(makeSessionKey(agentA.publicKey, "guest-1"));
    await storage.setSessionKey(makeSessionKey(agentB.publicKey, "guest-1"));
    await storage.createChatSession(agentA.publicKey, "guest-1", "2026-01-01T00:00:00.000Z");

    await storage.mergeOwner("guest-1", "account-1");

    const moved = await storage.listOwnedAgents("account-1");
    expect(moved.map((a) => a.publicKey)).toEqual([agentA.publicKey, agentB.publicKey]);
    expect(await storage.listOwnedAgents("guest-1")).toEqual([]);
    expect(await storage.getChatSession(agentA.publicKey, "account-1")).not.toBeNull();
    expect(await storage.getChatSession(agentA.publicKey, "guest-1")).toBeNull();
    await storage.close();
  });

  it("is idempotent: re-running the same merge moves nothing", async () => {
    const storage = await makeStorage();
    const agent = makeAgent({ name: "libsql-merge-idempotent.agent" });
    await storage.saveAgent(agent);
    await storage.setSessionKey(makeSessionKey(agent.publicKey, "guest-1"));
    await storage.mergeOwner("guest-1", "account-1");
    await storage.mergeOwner("guest-1", "account-1");
    expect((await storage.listOwnedAgents("account-1")).map((a) => a.publicKey)).toEqual([agent.publicKey]);
    await storage.close();
  });

  it("guards merging an owner into itself and rejects empty ids", async () => {
    const storage = await makeStorage();
    const agent = makeAgent({ name: "libsql-merge-self.agent" });
    await storage.saveAgent(agent);
    await storage.setSessionKey(makeSessionKey(agent.publicKey, "same-owner"));
    await storage.mergeOwner("same-owner", "same-owner");
    expect((await storage.listOwnedAgents("same-owner")).map((a) => a.publicKey)).toEqual([agent.publicKey]);
    await expect(storage.mergeOwner("", "account-1")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(storage.mergeOwner("guest-1", "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await storage.close();
  });
});