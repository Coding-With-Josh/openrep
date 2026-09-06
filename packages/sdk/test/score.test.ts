import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getScore, resolve } from "../src/index.js";
import type {
  AgentId,
  AgentRecord,
  AttestationRecord,
  Paginated,
  PaginationParams,
  RegisteredSource,
  StorageAdapter,
} from "../src/index.js";

// storage fake that serves the scoring path and PROVES its contract claims:
// the counters below let tests assert that getScore pages until exhaustion
// (getAttestationsCalls), that a native-only history never consults the
// registered-sources table (getRegisteredSourcesCalls), and that resolve is
// a composition of getAgentByName + getScore rather than its own scorer
// (resolve+real getScore never re-reads anything it does not need).
//
// getAttestations mimics the sqlite backend exactly: newest-first by rowId
// descending, and a nextCursor whenever a page filled the limit (even on the
// last full page, which the caller must re-fetch once and get an empty page
// from), so the pagination behavior under test is the real contract.
class FakeStorage implements StorageAdapter {
  readonly byId = new Map<string, AgentRecord>();
  attestations: AttestationRecord[] = [];
  registeredSources: RegisteredSource[] = [];
  getAttestationsCalls = 0;
  getRegisteredSourcesCalls = 0;
  getAgentCalls = 0;
  getAgentByNameCalls = 0;

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
    this.getAgentCalls += 1;
    return this.byId.get(agentId) ?? null;
  }

  async getAgentByName(name: string): Promise<AgentRecord | null> {
    this.getAgentByNameCalls += 1;
    for (const record of this.byId.values()) {
      if (record.name === name) return record;
    }
    return null;
  }

  async saveAgent(record: AgentRecord): Promise<void> {
    this.byId.set(record.publicKey, record);
  }

  async revokeAgent(agentId: AgentId, revokedAt: string): Promise<void> {
    const existing = this.byId.get(agentId);
    if (existing === undefined) throw codedError("AGENT_NOT_FOUND", "no such agent");
    this.byId.set(agentId, { ...existing, revokedAt });
  }

  async getAttestations(agentId: AgentId, pagination?: PaginationParams): Promise<Paginated<AttestationRecord>> {
    this.getAttestationsCalls += 1;
    const limit = pagination?.limit ?? 1000;
    let rows = this.attestations
      .filter((a) => a.agentId === agentId)
      .sort((a, b) => b.rowId - a.rowId);
    if (pagination?.cursor !== undefined) {
      rows = rows.filter((a) => a.rowId < Number(pagination.cursor));
    }
    const items = rows.slice(0, limit);
    const nextCursor = items.length === limit && items.length > 0 ? String(items[items.length - 1].rowId) : null;
    return { items, nextCursor };
  }

  async getAttestationByIdempotencyKey(_agentId: AgentId, _idempotencyKey: string): Promise<AttestationRecord | null> {
    return null;
  }

  async saveAttestation(record: AttestationRecord): Promise<void> {
    this.attestations.push({ ...record, rowId: this.attestations.length + 1 });
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    this.getRegisteredSourcesCalls += 1;
    return [...this.registeredSources];
  }

  async saveRegisteredSource(source: RegisteredSource): Promise<void> {
    this.registeredSources.push(source);
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

const PUBLIC_KEY = "a".repeat(64);
const OWNER_KEY = "b".repeat(64);
const SIGNATURE = "c".repeat(128);
const CONTENT_HASH = "d".repeat(64);

function agentRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: "unit-tester.agent",
    publicKey: PUBLIC_KEY,
    ownerPublicKey: OWNER_KEY,
    memoryPointer: null,
    permissions: ["attest:self"],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 1,
    signature: SIGNATURE,
    revokedAt: null,
    ...over,
  };
}

// deterministic timestamps per attestation: the "day of january" drives the
// day of the month, so tests can assert lastUpdated picks the true max.
function isoTime(day: number): string {
  return `2026-01-${String(day).padStart(2, "0")}T12:00:00.000Z`;
}

function attestation(over: Partial<AttestationRecord>): AttestationRecord {
  return {
    id: randomUUID(),
    agentId: PUBLIC_KEY,
    task: "produce a byte of proof",
    output: "proof",
    toolsUsed: [],
    source: "native",
    contentHash: CONTENT_HASH,
    signature: SIGNATURE,
    signedBy: PUBLIC_KEY,
    timestamp: isoTime(1),
    schemaVersion: 1,
    rowId: 0, // overwritten by saveAttestation
    ...over,
  };
}

async function makeStorage(over: Partial<AgentRecord> = {}) {
  const storage = new FakeStorage();
  await storage.saveAgent(agentRecord(over));
  return storage;
}

describe("getScore", () => {
  it("returns a valid zero score for an existing agent with no attestations", async () => {
    const storage = await makeStorage();

    const result = await getScore(PUBLIC_KEY, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.agentId).toBe(PUBLIC_KEY);
    expect(result.value.composite).toBe(0);
    expect(result.value.breakdown).toEqual([]);
    expect(result.value.computedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // an empty history must not consult the registered-sources table
    expect(storage.getRegisteredSourcesCalls).toBe(0);
  });

  it("never reads registered sources for a pure-native history and scores native at 1.0", async () => {
    const storage = await makeStorage();
    await storage.saveAttestation(attestation({}));

    const result = await getScore(PUBLIC_KEY, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.composite).toBe(1);
    expect(result.value.breakdown).toEqual([
      { source: "native", value: 1, count: 1, lastUpdated: isoTime(1) },
    ]);
    expect(storage.getRegisteredSourcesCalls).toBe(0);
    expect(storage.getAttestationsCalls).toBe(1);
  });

  it("pins native to 1.0 even when a registered_sources row claims otherwise", async () => {
    const storage = await makeStorage();
    // native ×1, github ×1 with a strong registered weight; a bogus "native"
    // row with a tiny weight must be overridden, not honored.
    await storage.saveAttestation(attestation({ source: "native" }));
    await storage.saveAttestation(attestation({ source: "github", timestamp: isoTime(3) }));
    await storage.saveRegisteredSource({ sourceName: "native", registeredAt: isoTime(1), trustWeight: 0.1 });
    await storage.saveRegisteredSource({ sourceName: "github", registeredAt: isoTime(1), trustWeight: 2.0 });

    const result = await getScore(PUBLIC_KEY, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // native stays 1.0 (not 0.1): 1*1.0 + 1*2.0
    expect(result.value.composite).toBe(3);
    expect(result.value.breakdown).toEqual([
      { source: "github", value: 1, count: 1, lastUpdated: isoTime(3) },
      { source: "native", value: 1, count: 1, lastUpdated: isoTime(1) },
    ]);
  });

  it("computes the exact composite across multiple sources", async () => {
    const storage = await makeStorage();
    // native ×3 across days, github ×2 across days
    for (const day of [1, 2, 3]) {
      await storage.saveAttestation(attestation({ source: "native", timestamp: isoTime(day) }));
    }
    for (const day of [2, 4]) {
      await storage.saveAttestation(attestation({ source: "github", timestamp: isoTime(day) }));
    }
    await storage.saveRegisteredSource({ sourceName: "github", registeredAt: isoTime(1), trustWeight: 2.0 });

    const result = await getScore(PUBLIC_KEY, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // composite = 3*1.0 (native) + 2*2.0 (github) = 7
    expect(result.value.composite).toBe(7);
    expect(result.value.breakdown).toEqual([
      { source: "github", value: 2, count: 2, lastUpdated: isoTime(4) },
      { source: "native", value: 3, count: 3, lastUpdated: isoTime(3) },
    ]);
  });

  it("keeps unregistered sources visible in the breakdown but weight 0", async () => {
    const storage = await makeStorage();
    await storage.saveAttestation(attestation({ source: "native" }));
    await storage.saveAttestation(attestation({ source: "stripe", timestamp: isoTime(2) }));

    const result = await getScore(PUBLIC_KEY, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // stripe has no registered_sources row: count visible, contributes 0
    expect(result.value.composite).toBe(1);
    expect(result.value.breakdown).toEqual([
      { source: "native", value: 1, count: 1, lastUpdated: isoTime(1) },
      { source: "stripe", value: 1, count: 1, lastUpdated: isoTime(2) },
    ]);
    expect(storage.getRegisteredSourcesCalls).toBe(1);
  });

  it("clamps non-finite and negative registered weights to 0", async () => {
    const storage = await makeStorage();
    await storage.saveAttestation(attestation({ source: "github", timestamp: isoTime(1) }));
    await storage.saveRegisteredSource({ sourceName: "github", registeredAt: isoTime(1), trustWeight: -2.0 });

    const result = await getScore(PUBLIC_KEY, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.composite).toBe(0);

    const storageNaN = await makeStorage();
    await storageNaN.saveAttestation(attestation({ source: "github", timestamp: isoTime(1) }));
    await storageNaN.saveRegisteredSource({ sourceName: "github", registeredAt: isoTime(1), trustWeight: Number.NaN });

    const resultNaN = await getScore(PUBLIC_KEY, storageNaN);
    expect(resultNaN.ok).toBe(true);
    if (!resultNaN.ok) return;
    expect(resultNaN.value.composite).toBe(0);
  });

  it("pages through history until exhausted", async () => {
    const storage = await makeStorage();
    for (const day of [1, 2, 3, 4, 5]) {
      await storage.saveAttestation(attestation({ source: "native", timestamp: isoTime(day) }));
    }

    const result = await getScore(PUBLIC_KEY, storage, { pageSize: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 5 rows at pageSize 2: page1 (2 rows, cursor), page2 (2 rows, cursor),
    // page3 (1 row, no cursor) = 3 reads, all 5 counted exactly once
    expect(storage.getAttestationsCalls).toBe(3);
    expect(result.value.composite).toBe(5);
    expect(result.value.breakdown).toEqual([
      { source: "native", value: 5, count: 5, lastUpdated: isoTime(5) },
    ]);
  });

  it("fails closed with SCORE_COMPUTATION_LIMIT_EXCEEDED instead of truncating", async () => {
    const storage = await makeStorage();
    for (const day of [1, 2, 3, 4, 5]) {
      await storage.saveAttestation(attestation({ source: "native", timestamp: isoTime(day) }));
    }

    const result = await getScore(PUBLIC_KEY, storage, { maxAttestations: 3 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SCORE_COMPUTATION_LIMIT_EXCEEDED");
  });

  it("never truncates silently at a page boundary", async () => {
    // the cap check runs per record, so a cap landing mid-page is still an
    // error, not a partial score that happens to stop at a page edge
    const storage = await makeStorage();
    for (const day of [1, 2, 3, 4]) {
      await storage.saveAttestation(attestation({ source: "native", timestamp: isoTime(day) }));
    }

    const result = await getScore(PUBLIC_KEY, storage, { pageSize: 2, maxAttestations: 2 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SCORE_COMPUTATION_LIMIT_EXCEEDED");
  });

  it("returns AGENT_NOT_FOUND for a nonexistent agent", async () => {
    const storage = new FakeStorage();

    const result = await getScore("f".repeat(64), storage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AGENT_NOT_FOUND");
  });
});

describe("resolve", () => {
  it("returns AGENT_NOT_FOUND for an unknown name", async () => {
    const storage = await makeStorage();

    const result = await resolve("nobody.agent", storage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AGENT_NOT_FOUND");
  });

  it("resolves by name to manifest (no rowId, with revokedAt) plus real score", async () => {
    const storage = new FakeStorage();
    await storage.saveAgent(agentRecord({ revokedAt: "2026-02-01T00:00:00.000Z" }));
    await storage.saveAttestation(attestation({}));

    const result = await resolve("unit-tester.agent", storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifest.name).toBe("unit-tester.agent");
    expect(result.value.manifest.publicKey).toBe(PUBLIC_KEY);
    expect("rowId" in result.value.manifest).toBe(false);
    expect(result.value.manifest.revokedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.value.manifest.ownerPublicKey).toBe(OWNER_KEY);
    expect(result.value.score.composite).toBe(1);
    // resolve itself does no scoring reads of its own; the work happens in
    // getScore, which resolve calls by composition
    expect(storage.getAgentByNameCalls).toBe(1);
    expect(storage.getAttestationsCalls).toBe(1);
    expect(storage.getRegisteredSourcesCalls).toBe(0);
  });
});