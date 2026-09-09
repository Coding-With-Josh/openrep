import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { getPublicKeyAsync } from "@noble/ed25519";
import {
  ATTESTATION_SCHEMA_VERSION,
  attest,
  canonicalize,
  verifyAttestation,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";
import type {
  AgentId,
  AgentRecord,
  AttestationInput,
  AttestationRecord,
  KeyRotationRecord,
  Paginated,
  PaginationParams,
  RegisteredSource,
  StorageAdapter,
} from "../src/index.js";
import type { OpenRepError } from "../src/types/errors.js";

// fixed ed25519 seeds (32 bytes each, lowercase hex) so tests are
// deterministic. public keys are derived once below and cached.
const SECRET_1 = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const SECRET_2 = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

let PK1: string;
let PK2: string;

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function failCode(result: { ok: false; error: OpenRepError }, expected: string): void {
  expect(result.error.code).toBe(expected);
}

// in-memory storage that emulates the storage-level contracts attest()
// depends on, mirroring the real sqlite adapter:
// - agents are a pre-populated set; saving an attestation for an agent
//   outside it throws AGENT_NOT_FOUND exactly like the foreign key does
// - the composite (agent_id, idempotency_key) unique index is emulated by a
//   map keyed on the pair, throwing DUPLICATE_IDEMPOTENCY_KEY on collision
// - raceMisses drops the optimistic lookup result N times while the map
//   still holds the winner, deterministically forcing the
//   miss-then-duplicate path attest() must resolve by re-fetching
class FakeStorage implements StorageAdapter {
  readonly agents = new Set<string>();
  readonly byIdempotency = new Map<string, AttestationRecord>();
  readonly saves: AttestationRecord[] = [];
  readonly calls: string[] = [];
  raceMisses = 0;
  failSavesWithGeneric = false;
  readonly revokedAgentIds = new Set<string>();
  failGetAgent = false;

  private pair(agentId: string, idempotencyKey: string): string {
    return `${agentId}:${idempotencyKey}`;
  }

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
    this.calls.push("getAgent");
    if (this.failGetAgent) throw new Error("read failed on purpose");
    if (!this.agents.has(agentId)) return null;
    return {
      name: `agent-${agentId}.agent`,
      publicKey: agentId,
      ownerPublicKey: "aa".repeat(32),
      memoryPointer: null,
      permissions: ["attest:self"],
      createdAt: "2026-01-01T00:00:00.000Z",
      manifestVersion: 2,
      signature: "sig",
      revokedAt: this.revokedAgentIds.has(agentId) ? "2026-02-01T00:00:00.000Z" : null,
    };
  }

  async getAgentByName(_name: string): Promise<AgentRecord | null> {
    this.calls.push("getAgentByName");
    return null;
  }

  async saveAgent(_record: AgentRecord): Promise<void> {
    this.calls.push("saveAgent");
  }

  async revokeAgent(agentId: AgentId, _revokedAt: string): Promise<void> {
    this.calls.push("revokeAgent");
    this.revokedAgentIds.add(agentId);
  }

  async rotateAgent(_record: AgentRecord, _rotation: KeyRotationRecord): Promise<void> {
    throw new Error("not on the attest path");
  }

  async getKeyRotations(_agentId: AgentId): Promise<KeyRotationRecord[]> {
    throw new Error("not on the attest path");
  }

  async getAttestations(_agentId: AgentId, _pagination?: PaginationParams): Promise<Paginated<AttestationRecord>> {
    this.calls.push("getAttestations");
    return { items: [], nextCursor: null };
  }

  async getAttestationByIdempotencyKey(agentId: AgentId, idempotencyKey: string): Promise<AttestationRecord | null> {
    this.calls.push("getAttestationByIdempotencyKey");
    if (this.raceMisses > 0) {
      this.raceMisses--;
      return null;
    }
    return this.byIdempotency.get(this.pair(agentId, idempotencyKey)) ?? null;
  }

  async saveAttestation(record: AttestationRecord): Promise<void> {
    this.calls.push("saveAttestation");
    if (this.failSavesWithGeneric) throw new Error("disk is on fire");
    if (!this.agents.has(record.agentId)) throw codedError("AGENT_NOT_FOUND", `unknown agent: ${record.agentId}`);
    if (record.idempotencyKey !== undefined) {
      const key = this.pair(record.agentId, record.idempotencyKey);
      if (this.byIdempotency.has(key)) throw codedError("DUPLICATE_IDEMPOTENCY_KEY", "same (agent, key) already recorded");
      this.byIdempotency.set(key, record);
    }
    this.saves.push(record);
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    this.calls.push("getRegisteredSources");
    return [];
  }

  async saveRegisteredSource(_source: RegisteredSource): Promise<void> {
    this.calls.push("saveRegisteredSource");
  }
}

function validInput(overrides: Partial<AttestationInput> = {}): AttestationInput {
  return {
    agentId: PK1,
    task: "list the repository files",
    output: "src/, test/, technical.md",
    toolsUsed: [{ tool: "ls", input: { path: "." } }],
    source: "native",
    ...overrides,
  };
}

describe("attest", () => {
  beforeAll(async () => {
    PK1 = bytesToHex(await getPublicKeyAsync(hexToBytes(SECRET_1)));
    PK2 = bytesToHex(await getPublicKeyAsync(hexToBytes(SECRET_2)));
  });

  it("signs a valid run, persists it, and returns a portable attestation", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    expect(value.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(value.agentId).toBe(PK1);
    expect(value.signedBy).toBe(PK1);
    expect(value.source).toBe("native");
    expect(value.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(value.timestamp))).toBe(false);
    expect(value.schemaVersion).toBe(ATTESTATION_SCHEMA_VERSION);
    expect(value.signature).toMatch(/^[0-9a-f]{128}$/);
    const expectedHash = createHash("sha256")
      .update(canonicalize({ task: "list the repository files", output: "src/, test/, technical.md", toolsUsed: [{ tool: "ls", input: { path: "." } }] }), "utf8")
      .digest("hex");
    expect(value.contentHash).toBe(expectedHash);
    // the revocation pre-check runs before the insert (decision D3 from the
    // plan), so the call order is the agent lookup then the save.
    expect(storage.calls).toEqual(["getAgent", "saveAttestation"]);
    expect(storage.saves).toHaveLength(1);
    // the persisted row is the same record minus storage internals.
    expect("rowId" in value).toBe(false);
    expect("idempotencyKey" in value).toBe(false);
  });

  it("rejects a toolsUsed entry that canonicalizes alone but overflows depth inside the whole content", async () => {
    // regression for the live web_search crash: an entry whose output nests
    // an array three levels deep (output -> results -> result -> categories)
    // passes the per-entry toolEntriesValid depth budget, but once wrapped in
    // { task, output, toolsUsed } it sits one level deeper and trips
    // canonicalize's depth-6 cap. attest() must return a typed failure, not
    // throw a raw Error that surfaces as INTERNAL.
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const toolsUsed = [
      {
        tool: "web_search",
        input: { query: "new startups" },
        output: {
          query: "new startups",
          total: 1,
          count: 1,
          results: [{ domain: "example.ai", categories: ["AI"] }],
        },
      },
    ];
    const result = await attest(validInput({ toolsUsed }), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(result.error.message).toMatch(/depth|canonicaliz/i);
    // rejected during phase-1 validation: no storage read, no crypto, nothing
    // persisted, and crucially no throw escaping the call.
    expect(storage.calls).toEqual([]);
  });

  it("performs the optimistic idempotency read before the insert when a key is given", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput({ idempotencyKey: "run-1" }), SECRET_1, storage);
    expect(result.ok).toBe(true);
    expect(storage.calls).toEqual(["getAgent", "getAttestationByIdempotencyKey", "saveAttestation"]);
    expect(storage.byIdempotency.has(`${PK1}:run-1`)).toBe(true);
  });

  it("returns the existing attestation on retry with the same key, writing nothing twice", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const first = await attest(validInput({ idempotencyKey: "run-1" }), SECRET_1, storage);
    const second = await attest(validInput({ idempotencyKey: "run-1" }), SECRET_1, storage);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(storage.saves).toHaveLength(1);
  });

  it("resolves the optimistic-read race: a miss followed by a duplicate insert returns the winner", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    // a concurrent caller already won this key. the local read will miss it
    // (raceMisses), then the insert will collide with the map entry.
    const winner: AttestationRecord = {
      rowId: 7,
      id: "11111111-1111-4111-8111-111111111111",
      agentId: PK1,
      task: "list",
      output: "src",
      toolsUsed: [],
      source: "native",
      contentHash: "ab".repeat(32),
      signature: "cd".repeat(64),
      signedBy: PK1,
      timestamp: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      idempotencyKey: "run-1",
    };
    storage.byIdempotency.set(`${PK1}:run-1`, winner);
    storage.raceMisses = 1;
    const result = await attest(validInput({ idempotencyKey: "run-1" }), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(winner.id);
    expect(storage.saves).toHaveLength(0); // the winner was reused, nothing double written
  });

  it("reports AGENT_NOT_FOUND via the revocation pre-check when the agent is unknown", async () => {
    const storage = new FakeStorage(); // agents set is empty
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    failCode(result, "AGENT_NOT_FOUND");
    // decision D1/D3 vocabulary: attest() now pre-checks the agent record and
    // fails closed here instead of reaching the FK insert path. nothing was
    // hashed, signed, or persisted.
    expect(storage.calls).toEqual(["getAgent"]);
    expect(storage.saves).toHaveLength(0);
  });

  it("refuses to sign for a revoked agent with AGENT_REVOKED, before any crypto", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    storage.revokedAgentIds.add(PK1); // the agent has been revoked (real flow in unit e)
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    failCode(result, "AGENT_REVOKED");
    // the pre-check is ordered before hashing/signing and before any save,
    // so a revoked agent costs nothing to reject.
    expect(storage.calls).toEqual(["getAgent"]);
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects a signing key that does not match the claimed agent", async () => {
    const storage = new FakeStorage();
    // both PK1 and PK2 exist so we reach the key-correspondence check: the
    // claimed agent (PK2) is real and unrevoked, but the signing key
    // (SECRET_1) derives to PK1, which is the mismatch being isolated.
    storage.agents.add(PK1);
    storage.agents.add(PK2);
    const result = await attest(validInput({ agentId: PK2 }), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    failCode(result, "KEY_MISMATCH");
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects structurally malformed ids and keys as INVALID_INPUT", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const badAgentId = await attest(validInput({ agentId: "not-hex" }), SECRET_1, storage);
    expect(badAgentId.ok).toBe(false);
    if (!badAgentId.ok) failCode(badAgentId, "INVALID_INPUT");
    const badKey = await attest(validInput(), "not-a-key", storage);
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) failCode(badKey, "INVALID_INPUT");
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects any non-native source, firmly separating attest() from ingest()", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const external = await attest(validInput({ source: "github" }), SECRET_1, storage);
    expect(external.ok).toBe(false);
    if (!external.ok) failCode(external, "INVALID_SOURCE");
    const missing = await attest(validInput({ source: undefined as unknown as string }), SECRET_1, storage);
    expect(missing.ok).toBe(false);
    if (!missing.ok) failCode(missing, "INVALID_SOURCE");
  });

  it("rejects oversized input with INPUT_TOO_LARGE before any work", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const cases: Array<Partial<AttestationInput>> = [
      { task: "a".repeat(4001) },
      { output: "a".repeat(8001) },
      { toolsUsed: Array.from({ length: 51 }, (_, i) => ({ tool: `t${i}`, input: {} })) },
      { toolsUsed: [{ tool: "a".repeat(101), input: {} }] },
      { toolsUsed: [{ tool: "x", input: { big: "a".repeat(4100) } }] },
    ];
    for (const overrides of cases) {
      const result = await attest(validInput(overrides), SECRET_1, storage);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      failCode(result, "INPUT_TOO_LARGE");
    }
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects malformed or non-canonicalizable toolsUsed entries as INVALID_INPUT", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const cycles: Array<Partial<AttestationInput>> = [
      { toolsUsed: "oops" as unknown as AttestationInput["toolsUsed"] },
      { toolsUsed: [{ tool: 42 } as unknown as AttestationInput["toolsUsed"][number]] },
      { toolsUsed: [null as unknown as AttestationInput["toolsUsed"][number]] },
    ];
    const cyclic: { tool: string; input: unknown } = { tool: "x", input: {} };
    (cyclic.input as Record<string, unknown>).self = cyclic;
    cycles.push({ toolsUsed: [cyclic] });
    cycles.push({ toolsUsed: [{ tool: "x", input: { f: () => 1 } }] });
    for (const overrides of cycles) {
      const result = await attest(validInput(overrides), SECRET_1, storage);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      failCode(result, "INVALID_INPUT");
    }
    expect(storage.saves).toHaveLength(0);
  });

  it("accepts the same object referenced from two tool entries (cycle-accurate)", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const shared = { cache: "hot" };
    const result = await attest(
      validInput({ toolsUsed: [{ tool: "lookup", input: shared }, { tool: "lookup", input: shared }] }),
      SECRET_1,
      storage,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects empty or non-string idempotency keys", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const empty = await attest(validInput({ idempotencyKey: "" }), SECRET_1, storage);
    expect(empty.ok).toBe(false);
    if (!empty.ok) failCode(empty, "INVALID_INPUT");
    const numeric = await attest(validInput({ idempotencyKey: 42 as unknown as string }), SECRET_1, storage);
    expect(numeric.ok).toBe(false);
    if (!numeric.ok) failCode(numeric, "INVALID_INPUT");
  });

  it("surfaces an unexpected storage failure as STORAGE_WRITE_FAILED", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    storage.failSavesWithGeneric = true;
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) failCode(result, "STORAGE_WRITE_FAILED");
  });

  it("fails closed, not as not revoked, when the revocation-status read throws", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    storage.failGetAgent = true;
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) failCode(result, "STORAGE_WRITE_FAILED");
    expect(storage.saves).toHaveLength(0);
  });
});

describe("verifyAttestation", () => {
  beforeAll(async () => {
    PK1 = bytesToHex(await getPublicKeyAsync(hexToBytes(SECRET_1)));
    PK2 = bytesToHex(await getPublicKeyAsync(hexToBytes(SECRET_2)));
  });

  it("accepts an attestation produced by attest()", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verified = await verifyAttestation(result.value, storage);
    expect(verified.valid).toBe(true);
    expect(verified.reason).toBeNull();
  });

  it("reports a content hash mismatch when the payload is tampered", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tampered = { ...result.value, output: result.value.output + "!" };
    const verified = await verifyAttestation(tampered, storage);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("content hash mismatch");
  });

  it("reports signature verification failed when the signature bytes are wrong", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wrongSig = { ...result.value, signature: "0".repeat(128) };
    const verified = await verifyAttestation(wrongSig, storage);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("signature verification failed");
  });

  it("reports signature verification failed when signedBy is not the real signer", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    // PK2 must exist and be unrevoked so verification reaches the signature
    // step: the attestation was signed by SECRET_1 (PK1) but claims PK2, so
    // verifying with PK2's key fails, which is the isolation being tested.
    storage.agents.add(PK2);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wrongSigner = { ...result.value, signedBy: PK2 };
    const verified = await verifyAttestation(wrongSigner, storage);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("signature verification failed");
  });

  it("rejects malformed cryptographic fields with shape-specific reasons, never throwing", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const badHash = await verifyAttestation({ ...result.value, contentHash: "zz".repeat(32) }, storage);
    expect(badHash.valid).toBe(false);
    expect(badHash.reason).toBe("contentHash is not a 32-byte lowercase hex sha-256");
    const badSig = await verifyAttestation({ ...result.value, signature: "abc" }, storage);
    expect(badSig.valid).toBe(false);
    expect(badSig.reason).toBe("signature is not a 64-byte lowercase hex ed25519 signature");
    const badSigner = await verifyAttestation({ ...result.value, signedBy: "xy".repeat(32) }, storage);
    expect(badSigner.valid).toBe(false);
    expect(badSigner.reason).toBe("signedBy is not a 32-byte lowercase hex public key");
  });

  it("reports a canonicalization failure instead of throwing on unverifiable payload shapes", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const noTools = { ...result.value, toolsUsed: undefined as unknown as typeof result.value.toolsUsed };
    const verified = await verifyAttestation(noTools, storage);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("attestation content could not be canonicalized");
    const cyclic: { tool: string; input: unknown } = { tool: "x", input: {} };
    (cyclic.input as Record<string, unknown>).self = cyclic;
    const cyclicEntry = await verifyAttestation({ ...result.value, toolsUsed: [cyclic] }, storage);
    expect(cyclicEntry.valid).toBe(false);
    expect(cyclicEntry.reason).toBe("attestation content could not be canonicalized");
  });

  it("rejects an attestation whose signing agent is revoked, before any crypto, even if untouched", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the agent is revoked after signing, before verification. the attestation
    // is byte-for-byte untouched and valid, but the revoked state wins.
    storage.revokedAgentIds.add(PK1);
    const verified = await verifyAttestation(result.value, storage);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("key revoked");
  });

  it("fails closed with agent not found when the storage holds no signer record", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const empty = new FakeStorage(); // no agent records at all
    const verified = await verifyAttestation(result.value, empty);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("agent not found");
  });

  it("fails closed when the revocation-status read throws", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await attest(validInput(), SECRET_1, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const failing = new FakeStorage();
    failing.agents.add(PK1);
    failing.failGetAgent = true;
    const verified = await verifyAttestation(result.value, failing);
    expect(verified.valid).toBe(false);
    expect(verified.reason).toBe("revocation status could not be checked");
  });
});