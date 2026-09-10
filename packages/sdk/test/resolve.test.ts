import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolve } from "../src/index.js";
import { getScore } from "../src/score.js";
import type { AgentId, AgentRecord, AttestationRecord, KeyRotationRecord, Paginated, PaginationParams, RegisteredSource, StorageAdapter } from "../src/index.js";
import type { AgentScore } from "../src/index.js";

// composition proof for resolve: getScore is mocked, so ANY attestation read
// or registered-source read that resolve attempted itself would hit the
// throwing methods below and fail the test. resolve passing these tests
// means it is exactly getAgentByName + getScore and nothing more.
vi.mock("../src/score.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/score.js")>();
  return { ...mod, getScore: vi.fn() };
});

class FakeStorage implements StorageAdapter {
  readonly byId = new Map<string, AgentRecord>();
  getAgentByNameCalls = 0;

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
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

  async revokeAgent(_agentId: AgentId, _revokedAt: string): Promise<void> {
    throw new Error("resolve must not revoke");
  }

  async setAgentVisibility(_agentId: AgentId, _visibility: AgentVisibility): Promise<void> {
    throw new Error("resolve must not mutate");
  }

  async listPublicAgents(): Promise<AgentRecord[]> {
    // resolve must never read a global listing itself; skip visibility
    throw new Error("resolve must not list agents globally");
  }

  async rotateAgent(_record: AgentRecord, _rotation: KeyRotationRecord): Promise<void> {
    throw new Error("not on the resolve path");
  }

  async getKeyRotations(_agentId: AgentId): Promise<KeyRotationRecord[]> {
    throw new Error("not on the resolve path");
  }

  async getAttestations(_agentId: AgentId, _pagination?: PaginationParams): Promise<Paginated<AttestationRecord>> {
    // resolve must NEVER read attestations itself; that is getScore's job
    throw new Error("resolve must not read attestations directly");
  }

  async getAttestationByIdempotencyKey(_agentId: AgentId, _idempotencyKey: string): Promise<AttestationRecord | null> {
    throw new Error("not on the resolve path");
  }

  async saveAttestation(_record: AttestationRecord): Promise<void> {
    throw new Error("not on the resolve path");
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    // resolve must NEVER read registered sources itself; that is getScore's job
    throw new Error("resolve must not read registered sources directly");
  }

  async saveRegisteredSource(_source: RegisteredSource): Promise<void> {
    throw new Error("not on the resolve path");
  }
}

const PUBLIC_KEY = "a".repeat(64);
const SIGNATURE = "c".repeat(128);

function record(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    name: "resolvable.agent",
    publicKey: PUBLIC_KEY,
    ownerPublicKey: "b".repeat(64),
    memoryPointer: null,
    permissions: ["attest:self"],
    createdAt: "2026-01-01T00:00:00.000Z",
    manifestVersion: 1,
    signature: SIGNATURE,
    revokedAt: null,
    rowId: 41, // storage-internal index that must not leak into the response
    ...over,
  };
}

const score: AgentScore = {
  agentId: PUBLIC_KEY,
  composite: 7,
  breakdown: [
    { source: "github", value: 2, count: 2, lastUpdated: "2026-01-04T12:00:00.000Z" },
    { source: "native", value: 3, count: 3, lastUpdated: "2026-01-03T12:00:00.000Z" },
  ],
  computedAt: "2026-01-05T12:00:00.000Z",
};

beforeEach(() => {
  vi.mocked(getScore).mockReset();
});

describe("resolve", () => {
  it("is a thin composition: getAgentByName + getScore, never its own scorer", async () => {
    const storage = new FakeStorage();
    await storage.saveAgent(record({ revokedAt: "2026-02-01T00:00:00.000Z" }));
    vi.mocked(getScore).mockResolvedValue({ ok: true, value: score });

    const result = await resolve("resolvable.agent", storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(storage.getAgentByNameCalls).toBe(1);
    // the scoring delegation happened exactly once, with the canonical id
    expect(vi.mocked(getScore)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getScore)).toHaveBeenCalledWith(PUBLIC_KEY, storage);
    // manifest: storage record minus rowId, revocation state preserved
    expect(result.value.manifest).toEqual({
      name: "resolvable.agent",
      publicKey: PUBLIC_KEY,
      ownerPublicKey: "b".repeat(64),
      memoryPointer: null,
      permissions: ["attest:self"],
      createdAt: "2026-01-01T00:00:00.000Z",
      manifestVersion: 1,
      signature: SIGNATURE,
      revokedAt: "2026-02-01T00:00:00.000Z",
    });
    expect("rowId" in result.value.manifest).toBe(false);
    // the score object from getScore passes through untouched
    expect(result.value.score).toBe(score);
  });

  it("returns AGENT_NOT_FOUND without delegating to getScore", async () => {
    const storage = new FakeStorage(); // empty

    const result = await resolve("nobody.agent", storage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AGENT_NOT_FOUND");
    expect(vi.mocked(getScore)).not.toHaveBeenCalled();
  });

  it("propagates getScore failures unchanged instead of re-wrapping them", async () => {
    const storage = new FakeStorage();
    await storage.saveAgent(record());
    vi.mocked(getScore).mockResolvedValue({
      ok: false,
      error: { code: "SCORE_COMPUTATION_LIMIT_EXCEEDED" as const, message: "history too large" },
    });

    const result = await resolve("resolvable.agent", storage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SCORE_COMPUTATION_LIMIT_EXCEEDED");
    expect(result.error.message).toBe("history too large");
  });
});