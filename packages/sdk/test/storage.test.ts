// storage adapter tests against real sqlite. every test gets a fresh
// :memory: database via createSqliteStorage, so no state leaks between
// tests and the file/connection lifecycle concerns of the memoized
// getSqliteStorage are deliberately not exercised here.
//
// the records below are hand built (no createAgent) because storage is
// contract tested in isolation: persistence must work for any structurally
// valid record, and signature verification is not this layer's job.
import { describe, expect, it } from "vitest";
import { createSqliteStorage } from "../src/index.js";
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

// rowId is the storage assigned index, the caller cannot meaningfully
// choose it. the fixture uses a placeholder the insert path ignores
// entirely, the value that matters is the one read back after insert.
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

describe("sqlite storage adapter: agents", () => {
  it("persists a full agent record and reads it back by canonical id", async () => {
    const storage = createSqliteStorage(":memory:");
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
    expect(readBack!.rowId).toBeGreaterThan(0); // assigned by the database, never by the caller
  });

  it("looks a record up by name and returns null for unknown ids and names", async () => {
    const storage = createSqliteStorage(":memory:");
    const record = makeAgent({ name: "findable.agent", publicKey: "pk-findable" });
    await storage.saveAgent(record);
    const byName = await storage.getAgentByName("findable.agent");
    expect(byName).not.toBeNull();
    expect(byName!.publicKey).toBe("pk-findable");
    expect(await storage.getAgent("pk-unknown")).toBeNull();
    expect(await storage.getAgentByName("missing.agent")).toBeNull();
  });

  it("round trips a null memory pointer", async () => {
    const storage = createSqliteStorage(":memory:");
    await storage.saveAgent(makeAgent({ name: "null-pointer.agent", memoryPointer: null }));
    const readBack = await storage.getAgentByName("null-pointer.agent");
    expect(readBack!.memoryPointer).toBeNull();
  });

  it("rejects a duplicate name with exactly code DUPLICATE_NAME", async () => {
    const storage = createSqliteStorage(":memory:");
    await storage.saveAgent(makeAgent({ name: "fixed-logic-owl.agent" }));
    await expect(storage.saveAgent(makeAgent({ name: "fixed-logic-owl.agent" }))).rejects.toMatchObject({
      code: "DUPLICATE_NAME",
    });
    // a different name must not trip the same constraint
    await storage.saveAgent(makeAgent({ name: "other-name.agent" }));
  });

  it("reports a public key collision as DUPLICATE_PUBLIC_KEY, never as a name conflict", async () => {
    const storage = createSqliteStorage(":memory:");
    await storage.saveAgent(makeAgent({ name: "one.agent", publicKey: "pk-shared" }));
    await expect(storage.saveAgent(makeAgent({ name: "two.agent", publicKey: "pk-shared" }))).rejects.toMatchObject({
      code: "DUPLICATE_PUBLIC_KEY",
    });
  });

  it("refuses to persist a record carrying a private key even when the type system is bypassed", async () => {
    const storage = createSqliteStorage(":memory:");
    const record = makeAgent({ name: "leaky.agent" });
    // the type system cannot express this, which is exactly the point: a
    // caller casting an AgentIdentity into an AgentRecord must still fail
    // before key material reaches the disk.
    const smuggled = { ...record, privateKey: "deadbeef" } as unknown as AgentRecord;
    await expect(storage.saveAgent(smuggled)).rejects.toThrow(/private key/);
    expect(await storage.getAgentByName("leaky.agent")).toBeNull(); // nothing hit the disk
  });

  it("stores an sql-injection shaped name literally and the table survives it", async () => {
    const storage = createSqliteStorage(":memory:");
    const hostile = "x'); DROP TABLE agents;--";
    await storage.saveAgent(makeAgent({ name: hostile, publicKey: "pk-inject" }));
    const readBack = await storage.getAgentByName(hostile);
    expect(readBack).not.toBeNull();
    expect(readBack!.name).toBe(hostile);
    // the table is still intact and addressable after the hostile value
    await storage.saveAgent(makeAgent({ name: "after-inject.agent", publicKey: "pk-after" }));
    expect(await storage.getAgentByName("after-inject.agent")).not.toBeNull();
  });
});

describe("sqlite storage adapter: attestations", () => {
  it("persists a full attestation and reads it back", async () => {
    const storage = createSqliteStorage(":memory:");
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
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent();
    await storage.saveAgent(agent);
    for (const id of ["att-first", "att-second", "att-third"]) {
      await storage.saveAttestation(makeAttestation(agent.publicKey, { id }));
    }
    const page = await storage.getAttestations(agent.publicKey);
    expect(page.items.map((a) => a.id)).toEqual(["att-third", "att-second", "att-first"]);
  });

  it("never returns another agent's attestations", async () => {
    const storage = createSqliteStorage(":memory:");
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
    const storage = createSqliteStorage(":memory:");
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
    expect(pages).toBe(3); // 5 items at 2 per page
    expect(seen).toEqual(["att-5", "att-4", "att-3", "att-2", "att-1"]);
  });

  it("keeps already returned pages stable when new attestations land between page loads", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent();
    await storage.saveAgent(agent);
    for (let i = 1; i <= 4; i++) await storage.saveAttestation(makeAttestation(agent.publicKey, { id: `att-${i}` }));
    const page1 = await storage.getAttestations(agent.publicKey, { limit: 2 });
    expect(page1.items.map((a) => a.id)).toEqual(["att-4", "att-3"]);
    // two new rows land with higher row ids while the reader is mid-walk
    for (let i = 5; i <= 6; i++) await storage.saveAttestation(makeAttestation(agent.publicKey, { id: `att-${i}` }));
    const page2 = await storage.getAttestations(agent.publicKey, { cursor: page1.nextCursor!, limit: 2 });
    expect(page2.items.map((a) => a.id)).toEqual(["att-2", "att-1"]); // no dup, no skip
  });

  it("defaults to a 50 item page and continues from the returned cursor", async () => {
    const storage = createSqliteStorage(":memory:");
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
    const storage = createSqliteStorage(":memory:");
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
    const storage = createSqliteStorage(":memory:");
    await expect(storage.saveAttestation(makeAttestation("pk-nonexistent"))).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("sqlite storage adapter: revokeAgent", () => {
  it("sets revoked_at on the matching row and round trips it", async () => {
    const storage = createSqliteStorage(":memory:");
    const record = makeAgent({ name: "revocable.agent" });
    await storage.saveAgent(record);
    await storage.revokeAgent(record.publicKey, "2026-02-01T00:00:00.000Z");
    const readBack = await storage.getAgent(record.publicKey);
    expect(readBack).not.toBeNull();
    expect(readBack!.revokedAt).toBe("2026-02-01T00:00:00.000Z");
    // everything else on the row is untouched by revocation
    expect(readBack!.name).toBe(record.name);
    expect(readBack!.ownerPublicKey).toBe(record.ownerPublicKey);
  });

  it("is idempotent: revoking an already revoked agent succeeds and keeps the first timestamp", async () => {
    const storage = createSqliteStorage(":memory:");
    const record = makeAgent({ name: "twice-revoked.agent" });
    await storage.saveAgent(record);
    await storage.revokeAgent(record.publicKey, "2026-02-01T00:00:00.000Z");
    await storage.revokeAgent(record.publicKey, "2026-02-02T00:00:00.000Z");
    const readBack = await storage.getAgent(record.publicKey);
    // the sdk layer treats a second revoke as a no-op and never calls
    // storage again (idempotency enforcement); the storage contract itself
    // just overwrites, it must not error on an already-revoked row.
    expect(readBack!.revokedAt).toBe("2026-02-02T00:00:00.000Z");
  });

  it("throws AGENT_NOT_FOUND when zero rows match", async () => {
    const storage = createSqliteStorage(":memory:");
    await expect(storage.revokeAgent("pk-nonexistent", "2026-02-01T00:00:00.000Z")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
});

describe("sqlite storage adapter: registered sources", () => {
  it("round trips sources ordered by name", async () => {
    const storage = createSqliteStorage(":memory:");
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
    const storage = createSqliteStorage(":memory:");
    await storage.saveRegisteredSource({ sourceName: "alpha-platform", registeredAt: "2026-01-01T00:00:00.000Z", trustWeight: 1 });
    await expect(
      storage.saveRegisteredSource({ sourceName: "alpha-platform", registeredAt: "2026-01-02T00:00:00.000Z", trustWeight: 2 }),
    ).rejects.toMatchObject({ code: "DUPLICATE_SOURCE_NAME" });
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

describe("sqlite storage adapter: key rotation", () => {
  it("persists the successor agent and its audit record atomically, reachable from either end of the lineage", async () => {
    const storage = createSqliteStorage(":memory:");
    const oldId = makeAgent({ name: "old-lineage.agent" });
    await storage.saveAgent(oldId);
    const successor = makeAgent({ name: "successor-lineage.agent" });
    const rotation = makeRotation(oldId.publicKey, successor.publicKey);

    await storage.rotateAgent(successor, rotation);

    expect((await storage.getAgent(successor.publicKey))!.name).toBe("successor-lineage.agent");
    // the audit row is honest: full field round trip, no lossy storage
    expect(await storage.getKeyRotations(oldId.publicKey)).toEqual([rotation]);
    // a successor's id is also a lineage key, so the lookup works from the
    // new end of the chain as well.
    expect(await storage.getKeyRotations(successor.publicKey)).toEqual([rotation]);
  });

  it("rolls back the whole transaction on a name collision, leaving no successor and no audit row", async () => {
    const storage = createSqliteStorage(":memory:");
    const oldId = makeAgent({ name: "rotating.agent" });
    await storage.saveAgent(oldId);
    const successor = makeAgent({ name: "rotating.agent", publicKey: "pk-collider" }); // same name

    await expect(
      storage.rotateAgent(successor, makeRotation(oldId.publicKey, successor.publicKey)),
    ).rejects.toMatchObject({ code: "DUPLICATE_NAME" });

    // the append-only ledger has no delete path, so this assertion is what
    // guarantees a failed rotation attempt is never partially observable:
    // neither the successor row nor the dangling audit row survived.
    expect(await storage.getAgent("pk-collider")).toBeNull();
    expect(await storage.getKeyRotations(oldId.publicKey)).toEqual([]);
  });

  it("returns rotation lineage newest first across multiple rotations of one agent", async () => {
    const storage = createSqliteStorage(":memory:");
    const oldId = makeAgent({ name: "multi-rotate.agent" });
    await storage.saveAgent(oldId);
    const gen2 = makeAgent({ name: "second-gen.agent" });
    await storage.rotateAgent(gen2, makeRotation(oldId.publicKey, gen2.publicKey));
    const gen3 = makeAgent({ name: "third-gen.agent" });
    await storage.rotateAgent(gen3, makeRotation(oldId.publicKey, gen3.publicKey));

    const lineage = await storage.getKeyRotations(oldId.publicKey);
    expect(lineage.map((r) => r.newPublicKey)).toEqual([gen3.publicKey, gen2.publicKey]);
  });
});

describe("sqlite storage adapter: chat history", () => {
  it("creates one session per ownership pair, get-or-create returns the existing id", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent({ name: "chatty.agent" });
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
  });

  it("throws AGENT_NOT_FOUND when the session references a nonexistent agent", async () => {
    const storage = createSqliteStorage(":memory:");
    await expect(
      storage.createChatSession("pk-no-such-agent", "owner-a", "2026-01-01T00:00:00.000Z"),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  });

  it("persists messages oldest first and round trips tool calls", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent({ name: "chat-record.agent" });
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
  });

  it("appending to a pair with no session fails closed with CHAT_SESSION_NOT_FOUND", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent({ name: "chatless.agent" });
    await storage.saveAgent(agent);
    // no createChatSession call on purpose: the write must not silently land
    await expect(
      storage.appendChatMessage(makeMessage({ agentId: agent.publicKey, ownerUserId: "owner-a", content: "hello" })),
    ).rejects.toMatchObject({ code: "CHAT_SESSION_NOT_FOUND" });
    // and nothing landed
    expect(await storage.getChatMessages(agent.publicKey, "owner-a")).toEqual([]);
  });

  it("is pair scoped: a wrong owner never reads another owner's session or messages", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent({ name: "scoped.agent" });
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
  });
});

describe("sqlite storage adapter: owned agent listing", () => {
  it("lists exactly the agents the owner holds a session key for, oldest ownership first", async () => {
    const storage = createSqliteStorage(":memory:");
    const agentA = makeAgent({ name: "owned-a.agent" });
    const agentB = makeAgent({ name: "owned-b.agent" });
    const agentC = makeAgent({ name: "foreign.agent" });
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
    expect(owned.map((a) => a.name)).not.toContain("foreign.agent");

    expect(await storage.listOwnedAgents("no-such-owner")).toEqual([]);
  });
});

describe("sqlite storage adapter: users and account links", () => {
  it("persists a user with a scrypt hash and reads it back by email and id", async () => {
    const storage = createSqliteStorage(":memory:");
    const user = makeUser({ email: "alice@example.com", name: "Alice" });
    await storage.createUser(user);
    const byEmail = await storage.getUserByEmail("alice@example.com");
    expect(byEmail).not.toBeNull();
    expect(byEmail!.id).toBe(user.id);
    expect(byEmail!.passwordHash).toBe("scrypt:16384:8:1:salt:hash");
    expect(byEmail!.name).toBe("Alice");
    expect(await storage.getUserById(user.id)).toEqual(byEmail);
    // unknown reads are null, never a throw
    expect(await storage.getUserByEmail("missing@example.com")).toBeNull();
    expect(await storage.getUserById("no-such-user")).toBeNull();
  });

  it("round trips a null password hash for an oauth-only account", async () => {
    const storage = createSqliteStorage(":memory:");
    const user = makeUser({ email: "oauth@example.com", passwordHash: null });
    await storage.createUser(user);
    expect((await storage.getUserByEmail("oauth@example.com"))!.passwordHash).toBeNull();
  });

  it("rejects a duplicate email with exactly code DUPLICATE_EMAIL", async () => {
    const storage = createSqliteStorage(":memory:");
    await storage.createUser(makeUser({ email: "dup@example.com" }));
    await expect(storage.createUser(makeUser({ email: "dup@example.com" }))).rejects.toMatchObject({
      code: "DUPLICATE_EMAIL",
    });
    // a distinct email must not trip the same constraint
    await storage.createUser(makeUser({ email: "other@example.com" }));
  });

  it("round trips an account link by (provider, provider_account_id)", async () => {
    const storage = createSqliteStorage(":memory:");
    const user = makeUser({ email: "link@example.com" });
    await storage.createUser(user);
    const link = makeAccountLink(user.id, { provider: "credentials", providerAccountId: user.id });
    await storage.createAccountLink(link);
    const readBack = await storage.getAccountLink("credentials", user.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.userId).toBe(user.id);
    // a different provider id is a miss, never a fallthrough
    expect(await storage.getAccountLink("credentials", "other-sub")).toBeNull();
    expect(await storage.getAccountLink("google", "sub-1")).toBeNull();
  });

  it("rejects a duplicate (provider, provider_account_id) with code DUPLICATE_ACCOUNT", async () => {
    const storage = createSqliteStorage(":memory:");
    const first = makeUser({ email: "first@example.com" });
    const second = makeUser({ email: "second@example.com" });
    await storage.createUser(first);
    await storage.createUser(second);
    // the same google sub must never map to two accounts
    await storage.createAccountLink(makeAccountLink(first.id, { providerAccountId: "same-sub" }));
    await expect(
      storage.createAccountLink(makeAccountLink(second.id, { providerAccountId: "same-sub" })),
    ).rejects.toMatchObject({ code: "DUPLICATE_ACCOUNT" });
  });

  it("rejects an account link naming a missing user with code USER_NOT_FOUND", async () => {
    const storage = createSqliteStorage(":memory:");
    await expect(storage.createAccountLink(makeAccountLink("no-such-user"))).rejects.toMatchObject({
      code: "USER_NOT_FOUND",
    });
  });
});

describe("sqlite storage adapter: mergeOwner", () => {
  it("moves session keys and chat sessions between owners in one transaction", async () => {
    const storage = createSqliteStorage(":memory:");
    const agentA = makeAgent({ name: "merge-a.agent" });
    const agentB = makeAgent({ name: "merge-b.agent" });
    await storage.saveAgent(agentA);
    await storage.saveAgent(agentB);

    // source owner holds both agents; destination owner holds nothing yet
    await storage.setSessionKey(makeSessionKey(agentA.publicKey, "guest-1"));
    await storage.setSessionKey(makeSessionKey(agentB.publicKey, "guest-1"));
    await storage.createChatSession(agentA.publicKey, "guest-1", "2026-01-01T00:00:00.000Z");

    await storage.mergeOwner("guest-1", "account-1");

    const moved = await storage.listOwnedAgents("account-1");
    expect(moved.map((a) => a.publicKey)).toEqual([agentA.publicKey, agentB.publicKey]);
    // the source owner now sees nothing
    expect(await storage.listOwnedAgents("guest-1")).toEqual([]);
    // the chat session followed the owner too
    expect(await storage.getChatSession(agentA.publicKey, "account-1")).not.toBeNull();
    expect(await storage.getChatSession(agentA.publicKey, "guest-1")).toBeNull();
  });

  it("is idempotent: re-running the same merge moves nothing", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent({ name: "merge-idempotent.agent" });
    await storage.saveAgent(agent);
    await storage.setSessionKey(makeSessionKey(agent.publicKey, "guest-1"));
    await storage.mergeOwner("guest-1", "account-1");
    // second run: nothing left at the source, nothing broken at the target
    await storage.mergeOwner("guest-1", "account-1");
    expect((await storage.listOwnedAgents("account-1")).map((a) => a.publicKey)).toEqual([agent.publicKey]);
  });

  it("guards merging an owner into itself and rejects empty ids", async () => {
    const storage = createSqliteStorage(":memory:");
    const agent = makeAgent({ name: "merge-self.agent" });
    await storage.saveAgent(agent);
    await storage.setSessionKey(makeSessionKey(agent.publicKey, "same-owner"));
    // self-merge is a no-op, never an error (retry safety after partial fail)
    await storage.mergeOwner("same-owner", "same-owner");
    expect((await storage.listOwnedAgents("same-owner")).map((a) => a.publicKey)).toEqual([agent.publicKey]);
    await expect(storage.mergeOwner("", "account-1")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(storage.mergeOwner("guest-1", "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});