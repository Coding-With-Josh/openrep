// unit tests for ingest(): the shared signing core (attest()'s guarantees
// applied to external evidence), the injected SourceAdapter contract, and
// the externalVerification provenance invariant.
//
// the source fixture below is a minimal, generic, unbranded task-marketplace
// shape (no chain, no named platform, matching the chain-agnostic
// positioning). it lives IN this test file only, inline, to exercise
// ingest()'s normalize->sign->persist path in unit tests. it is NOT the
// demo's data source: the marketplace is a planned real app (apps/marketplace)
// that will emit this record shape over real http, so no sample data or
// standalone adapter ships in packages/sdk.
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { getPublicKeyAsync } from "@noble/ed25519";
import {
  ATTESTATION_SCHEMA_VERSION,
  canonicalize,
  ingest,
  verifyAttestation,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";
import type {
  AgentId,
  AgentRecord,
  AttestationRecord,
  ExternalAttestation,
  KeyRotationRecord,
  NormalizedExternalAttestation,
  Paginated,
  PaginationParams,
  RegisteredSource,
  SourceAdapter,
  StorageAdapter,
} from "../src/index.js";
import type { OpenRepError } from "../src/types/errors.js";

// fixed ed25519 seeds (32 bytes each, lowercase hex) so tests are
// deterministic. public keys are derived once below and cached.
const SECRET_1 = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const SECRET_2 = "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb";

let PK1: string;
let PK2: string;

const MARKETPLACE_TIMESTAMP = "2026-03-04T09:30:00.000Z";

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

function failCode(result: { ok: false; error: OpenRepError }, expected: string): void {
  expect(result.error.code).toBe(expected);
}

// in-memory storage mirroring the storage-level contracts the shared
// signing core depends on, the same emulation attestation.test.ts uses:
// agents are a pre-populated set, the composite (agent_id, idempotency_key)
// unique index is a map keyed on the pair, and raceMisses forces the
// miss-then-duplicate path the core must resolve by re-fetching.
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

  async setAgentVisibility(_agentId: AgentId, _visibility: AgentVisibility): Promise<void> {
    throw new Error("not on the ingest path");
  }

  async listPublicAgents(): Promise<AgentRecord[]> {
    return []; // this fake has no agent records to list
  }

  async rotateAgent(_record: AgentRecord, _rotation: KeyRotationRecord): Promise<void> {
    throw new Error("not on the ingest path");
  }

  async getKeyRotations(_agentId: AgentId): Promise<KeyRotationRecord[]> {
    throw new Error("not on the ingest path");
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

// the inline, unbranded task-marketplace adapter. no validate(): the future
// marketplace app does no cryptographic signing, so anything ingested from
// it is honestly unverified (externalVerification.checked = false).
function marketplaceAdapter(overrides: Partial<SourceAdapter> = {}): SourceAdapter {
  const base: SourceAdapter = {
    sourceName: "marketplace",
    normalize(raw) {
      const record = raw as ExternalAttestation & {
        agentId?: unknown;
        taskCompleted?: {
          id?: unknown;
          title?: unknown;
          completedAt?: unknown;
          rating?: unknown;
          payoutCents?: unknown;
          currency?: unknown;
        };
      };
      return {
        agentId: record.agentId as string,
        task: `completed task ${record.taskCompleted?.id}: ${record.taskCompleted?.title}`,
        output: `rating ${record.taskCompleted?.rating}/5, payout ${record.taskCompleted?.payoutCents} ${record.taskCompleted?.currency}`,
        toolsUsed: [],
        timestamp: record.taskCompleted?.completedAt as string,
      };
    },
  };
  return { ...base, ...overrides };
}

// the raw record shape the future marketplace endpoint
// (GET /api/agents/:agentId/completed-tasks) will emit: a generic completed
// and rated task, no chain, no named platform.
function marketplaceRaw(overrides: Record<string, unknown> = {}): ExternalAttestation {
  return {
    sourceName: "marketplace",
    agentId: PK1,
    taskCompleted: {
      id: "task_01234",
      title: "refactor auth middleware",
      status: "completed",
      completedAt: MARKETPLACE_TIMESTAMP,
      rating: 4.8,
      payoutCents: 2500,
      currency: "usd",
      review: "clean, tested, on time",
    },
    ...overrides,
  };
}

// the exact three content fields the adapter maps, used to recompute the
// expected canonical content hash independently of ingest().
function expectedCanonicalContent(): string {
  return canonicalize({
    task: "completed task task_01234: refactor auth middleware",
    output: "rating 4.8/5, payout 2500 usd",
    toolsUsed: [],
  });
}

describe("ingest", () => {
  beforeAll(async () => {
    PK1 = bytesToHex(await getPublicKeyAsync(hexToBytes(SECRET_1)));
    PK2 = bytesToHex(await getPublicKeyAsync(hexToBytes(SECRET_2)));
  });

  it("normalizes, signs, and persists an external record with honest unverified provenance", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);

    const result = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    expect(value.agentId).toBe(PK1);
    expect(value.signedBy).toBe(PK1);
    expect(value.source).toBe("marketplace");
    expect(value.timestamp).toBe(MARKETPLACE_TIMESTAMP); // external time honored as-is
    expect(value.schemaVersion).toBe(ATTESTATION_SCHEMA_VERSION);
    expect(value.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(value.signature).toMatch(/^[0-9a-f]{128}$/);
    // no validate() on the adapter: the record is honestly recorded as
    // unverified, never as "checked and valid".
    expect(value.externalVerification).toEqual({ checked: false, valid: null, reason: null });
    // the content hash covers exactly the three mapped content fields.
    const expectedHash = createHash("sha256").update(expectedCanonicalContent(), "utf8").digest("hex");
    expect(value.contentHash).toBe(expectedHash);
    // the shared signing core runs the same revocation pre-check then save.
    expect(storage.calls).toEqual(["getAgent", "saveAttestation"]);
    expect(storage.saves).toHaveLength(1);
    // storage internals stay off the portable result.
    expect("rowId" in value).toBe(false);
    expect("idempotencyKey" in value).toBe(false);

    // the ingested record is a real signed attestation, verifiable end to end.
    const verified = await verifyAttestation(value, storage);
    expect(verified.valid).toBe(true);
  });

  // locked invariant: externalVerification is provenance metadata, never part
  // of the signed bytes. two records with identical content but different
  // check histories must produce identical content hashes.
  it("keeps externalVerification out of the signed bytes (content hash invariance)", async () => {
    const unverifiedStorage = new FakeStorage();
    unverifiedStorage.agents.add(PK1);
    const unverified = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, unverifiedStorage);
    expect(unverified.ok).toBe(true);
    if (!unverified.ok) return;

    const verifiedAdapter = marketplaceAdapter({
      validate: () => ({ valid: true, reason: null }),
    });
    const verifiedStorage = new FakeStorage();
    verifiedStorage.agents.add(PK1);
    const verified = await ingest(marketplaceRaw(), verifiedAdapter, SECRET_1, verifiedStorage);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;

    // the two records carry different verification metadata...
    expect(verified.value.externalVerification).toEqual({ checked: true, valid: true, reason: null });
    expect(unverified.value.externalVerification).toEqual({ checked: false, valid: null, reason: null });
    // ...but byte-identical signed content: no verification value can be
    // retrofitted into the signature or the hash. ed25519 signing is
    // deterministic, so an identical contentHash and key also yield an
    // identical signature — if externalVerification were part of the signed
    // bytes, the signatures would differ here. the ids differ because they
    // are random per record, uncorrelated with content.
    expect(verified.value.contentHash).toBe(unverified.value.contentHash);
    expect(verified.value.signature).toBe(unverified.value.signature);
    expect(verified.value.id).not.toBe(unverified.value.id);
  });

  // adversarial review: smuggled fields. an adapter casting extra keys onto
  // its normalized output must not reach the signed bytes or the persisted
  // metadata: the core recomputes contentHash/signature/signedBy from the
  // validated content fields and the signing key, never from adapter output.
  it("cannot smuggle contentHash, source, or signedBy through normalize", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);

    const smuggler: SourceAdapter = {
      sourceName: "marketplace",
      normalize(raw) {
        const inner = marketplaceAdapter().normalize(raw);
        return {
          ...inner,
          contentHash: "f".repeat(64),
          source: "github",
          signedBy: PK2,
          claim: { forged: true },
        } as unknown as NormalizedExternalAttestation;
      },
    };

    const result = await ingest(marketplaceRaw(), smuggler, SECRET_1, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.contentHash).toBe(createHash("sha256").update(expectedCanonicalContent(), "utf8").digest("hex"));
    expect(result.value.source).toBe("marketplace");
    expect(result.value.signedBy).toBe(PK1);
  });

  it("rejects a native-source adapter with INVALID_SOURCE, keeping the boundary firm on ingress", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await ingest(marketplaceRaw(), marketplaceAdapter({ sourceName: "native" }), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    failCode(result, "INVALID_SOURCE");
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects a malformed adapter (bad source name, missing normalize) as INVALID_SOURCE", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const cases: Array<Partial<SourceAdapter>> = [
      { sourceName: "" },
      { sourceName: "a".repeat(65) },
      { sourceName: 42 as unknown as string },
      { normalize: undefined as unknown as SourceAdapter["normalize"] },
    ];
    for (const overrides of cases) {
      const result = await ingest(marketplaceRaw(), marketplaceAdapter(overrides), SECRET_1, storage);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      failCode(result, "INVALID_SOURCE");
    }
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects a structurally bad signing key as INVALID_INPUT, the attest() vocabulary", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const result = await ingest(marketplaceRaw(), marketplaceAdapter(), "not-a-key", storage);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    failCode(result, "INVALID_INPUT");
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects raw records that do not declare the adapter's source", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const mismatch = await ingest(marketplaceRaw({ sourceName: "stripe" }), marketplaceAdapter(), SECRET_1, storage);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) failCode(mismatch, "MALFORMED_EXTERNAL_ATTESTATION");
    const missing = await ingest(marketplaceRaw({ sourceName: undefined }), marketplaceAdapter(), SECRET_1, storage);
    expect(missing.ok).toBe(false);
    if (!missing.ok) failCode(missing, "MALFORMED_EXTERNAL_ATTESTATION");
    expect(storage.saves).toHaveLength(0);
  });

  it("runs the optional validate() first and records a passing verdict as checked provenance", async () => {
    const order: string[] = [];
    const adapter = marketplaceAdapter({
      validate: (raw) => {
        order.push("validate");
        expect(raw.sourceName).toBe("marketplace");
        return { valid: true, reason: null };
      },
      normalize: (raw) => {
        order.push("normalize");
        return marketplaceAdapter().normalize(raw);
      },
    });
    const storage = new FakeStorage();
    storage.agents.add(PK1);

    const result = await ingest(marketplaceRaw(), adapter, SECRET_1, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the cheapest known-invalid reject runs first: validate before normalize.
    expect(order).toEqual(["validate", "normalize"]);
    expect(result.value.externalVerification).toEqual({ checked: true, valid: true, reason: null });
  });

  it("fails closed with EXTERNAL_ATTESTATION_INVALID when validate() rejects the record", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const adapter = marketplaceAdapter({ validate: () => ({ valid: false, reason: "signature mismatch" }) });
    const result = await ingest(marketplaceRaw(), adapter, SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    failCode(result, "EXTERNAL_ATTESTATION_INVALID");
    expect(storage.saves).toHaveLength(0);
  });

  it("fails closed when validate() throws or returns a malformed verdict", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const throwing = marketplaceAdapter({
      validate: () => {
        throw new Error("verifier is down");
      },
    });
    const threw = await ingest(marketplaceRaw(), throwing, SECRET_1, storage);
    expect(threw.ok).toBe(false);
    if (!threw.ok) failCode(threw, "EXTERNAL_ATTESTATION_INVALID");

    const malformed = marketplaceAdapter({ validate: () => ({ valid: "yes" }) as never });
    const malformedResult = await ingest(marketplaceRaw(), malformed, SECRET_1, storage);
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) failCode(malformedResult, "EXTERNAL_ATTESTATION_INVALID");
    expect(storage.saves).toHaveLength(0);
  });

  it("maps a throwing or non-object normalize to MALFORMED_EXTERNAL_ATTESTATION", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const throwing = marketplaceAdapter({
      normalize: () => {
        throw new Error("platform api exploded");
      },
    });
    const threw = await ingest(marketplaceRaw(), throwing, SECRET_1, storage);
    expect(threw.ok).toBe(false);
    if (!threw.ok) failCode(threw, "MALFORMED_EXTERNAL_ATTESTATION");

    const nullish = marketplaceAdapter({ normalize: () => null as unknown as NormalizedExternalAttestation });
    const nullResult = await ingest(marketplaceRaw(), nullish, SECRET_1, storage);
    expect(nullResult.ok).toBe(false);
    if (!nullResult.ok) failCode(nullResult, "MALFORMED_EXTERNAL_ATTESTATION");
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects normalized content that fails the ledger's own validation", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const cases: Array<Partial<NormalizedExternalAttestation>> = [
      { agentId: "not-hex" },
      { agentId: "ab".repeat(31) },
      { task: "a".repeat(4001) },
      { task: undefined as unknown as string },
      { output: "a".repeat(8001) },
      { output: 42 as unknown as string },
      { toolsUsed: "oops" as unknown as NormalizedExternalAttestation["toolsUsed"] },
      { toolsUsed: [null as unknown as NormalizedExternalAttestation["toolsUsed"][number]] },
    ];
    for (const overrides of cases) {
      const adapter = marketplaceAdapter({
        normalize: (raw) => ({ ...marketplaceAdapter().normalize(raw), ...overrides }),
      });
      const result = await ingest(marketplaceRaw(), adapter, SECRET_1, storage);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      failCode(result, "MALFORMED_EXTERNAL_ATTESTATION");
    }
    expect(storage.saves).toHaveLength(0);
  });

  it("rejects an unparseable external timestamp so getScore never sees garbage", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const cases = [undefined, "", "not-a-date", { day: 4 }, 42];
    for (const timestamp of cases) {
      const adapter = marketplaceAdapter({
        normalize: (raw) => ({ ...marketplaceAdapter().normalize(raw), timestamp } as unknown as NormalizedExternalAttestation),
      });
      const result = await ingest(marketplaceRaw(), adapter, SECRET_1, storage);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      failCode(result, "MALFORMED_EXTERNAL_ATTESTATION");
    }
    expect(storage.saves).toHaveLength(0);
  });

  it("enforces key correspondence: the signing key must derive to the claimed agent", async () => {
    const storage = new FakeStorage();
    // both agents exist and are unrevoked so the mismatch is isolated.
    storage.agents.add(PK1);
    storage.agents.add(PK2);
    // raw evidence claims PK2, but the signing key derives to PK1.
    const result = await ingest(marketplaceRaw({ agentId: PK2 }), marketplaceAdapter(), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    failCode(result, "KEY_MISMATCH");
    expect(storage.saves).toHaveLength(0);
  });

  it("fails closed through the same revocation gate as attest()", async () => {
    const storage = new FakeStorage(); // empty: unknown agent
    const unknown = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) failCode(unknown, "AGENT_NOT_FOUND");
    expect(unknown.ok === false && storage.calls).toEqual(["getAgent"]);

    const revokedStorage = new FakeStorage();
    revokedStorage.agents.add(PK1);
    revokedStorage.revokedAgentIds.add(PK1);
    const revoked = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, revokedStorage);
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) failCode(revoked, "AGENT_REVOKED");

    const failing = new FakeStorage();
    failing.agents.add(PK1);
    failing.failGetAgent = true;
    const readFailed = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, failing);
    expect(readFailed.ok).toBe(false);
    if (!readFailed.ok) failCode(readFailed, "STORAGE_WRITE_FAILED");

    expect(revokedStorage.saves).toHaveLength(0);
    expect(failing.saves).toHaveLength(0);
  });

  it("deduplicates retries with the same idempotency key, writing once", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const first = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage, { idempotencyKey: "import-1" });
    const second = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage, { idempotencyKey: "import-1" });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(storage.saves).toHaveLength(1);
    expect(storage.calls).toEqual(["getAgent", "getAttestationByIdempotencyKey", "saveAttestation", "getAgent", "getAttestationByIdempotencyKey"]);
  });

  it("resolves the optimistic-read race: a miss followed by a duplicate insert returns the winner", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const winner: AttestationRecord = {
      rowId: 7,
      id: "11111111-1111-4111-8111-111111111111",
      agentId: PK1,
      task: "completed task task_01234: refactor auth middleware",
      output: "rating 4.8/5, payout 2500 usd",
      toolsUsed: [],
      source: "marketplace",
      contentHash: createHash("sha256").update(expectedCanonicalContent(), "utf8").digest("hex"),
      signature: "cd".repeat(64),
      signedBy: PK1,
      timestamp: MARKETPLACE_TIMESTAMP,
      schemaVersion: 1,
      idempotencyKey: "import-1",
      externalVerification: { checked: false, valid: null, reason: null },
    };
    storage.byIdempotency.set(`${PK1}:import-1`, winner);
    storage.raceMisses = 1;
    const result = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage, { idempotencyKey: "import-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(winner.id);
    expect(storage.saves).toHaveLength(0); // the winner was reused, nothing double written
  });

  it("rejects empty or non-string idempotency keys", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    const empty = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage, { idempotencyKey: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) failCode(empty, "INVALID_INPUT");
    const numeric = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage, {
      idempotencyKey: 42 as unknown as string,
    });
    expect(numeric.ok).toBe(false);
    if (!numeric.ok) failCode(numeric, "INVALID_INPUT");
    expect(storage.saves).toHaveLength(0);
  });

  it("surfaces an unexpected storage failure as STORAGE_WRITE_FAILED", async () => {
    const storage = new FakeStorage();
    storage.agents.add(PK1);
    storage.failSavesWithGeneric = true;
    const result = await ingest(marketplaceRaw(), marketplaceAdapter(), SECRET_1, storage);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    failCode(result, "STORAGE_WRITE_FAILED");
  });
});