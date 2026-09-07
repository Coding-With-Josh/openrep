import { describe, expect, it } from "vitest";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  MANIFEST_VERSION,
  NAME_GENERATION_MAX_ATTEMPTS,
  canonicalize,
  createAgent,
  generateName,
  verifyManifest,
} from "../src/index.js";
import type { AgentRecord, KeyRotationRecord, Paginated, PaginationParams, RegisteredSource, StorageAdapter } from "../src/index.js";
import type { AgentId, AgentManifest, AgentPermission } from "../src/index.js";
import type { AttestationRecord } from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

// in-memory storage that mirrors the contract a real backend must honor:
// - getAgentByName is the optimistic read only
// - saveAgent enforces name uniqueness like a unique index, throwing an
//   error whose code is exactly "DUPLICATE_NAME" on violation
// - revokeAgent sets revokedAt on the stored row only, mirroring the dumb
//   UPDATE a real backend performs after the sdk's authorization has passed
// - failure injection lets tests deterministically simulate the race where
//   the optimistic read says "free" but the constraint still fires. the two
//   paths (constraint fires once for the first save, fires for every save)
//   exercise the retry loop and the exhaustion cap without needing to
//   control the random name generator.
class FakeStorage implements StorageAdapter {
  readonly byName = new Map<string, AgentRecord>();
  readonly byId = new Map<string, AgentRecord>();
  saveCount = 0;
  getByNameCount = 0;
  failFirstNSavesWithDuplicate = 0;
  failSavesWithGeneric = false;
  failGetAgent = false; // simulates a flaky storage read for the revocation gate
  revokeCount = 0;

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
    if (this.failGetAgent) throw new Error("read failed on purpose");
    return this.byId.get(agentId) ?? null;
  }

  async getAgentByName(name: string): Promise<AgentRecord | null> {
    this.getByNameCount++;
    return this.byName.get(name) ?? null;
  }

  async saveAgent(record: AgentRecord): Promise<void> {
    this.saveCount++;
    if (this.failSavesWithGeneric) throw new Error("disk is on fire");
    if (this.failFirstNSavesWithDuplicate > 0) {
      this.failFirstNSavesWithDuplicate--;
      throw duplicateNameError();
    }
    if (this.byName.has(record.name)) throw duplicateNameError();
    this.byName.set(record.name, record);
    this.byId.set(record.publicKey, record);
  }

  async revokeAgent(agentId: AgentId, revokedAt: string): Promise<void> {
    this.revokeCount++;
    const existing = this.byId.get(agentId);
    if (existing === undefined) throw notFoundError();
    this.byId.set(agentId, { ...existing, revokedAt });
  }

  async rotateAgent(_record: AgentRecord, _rotation: KeyRotationRecord): Promise<void> {
    throw new Error("not on the createAgent path");
  }

  async getKeyRotations(_agentId: AgentId): Promise<KeyRotationRecord[]> {
    throw new Error("not on the createAgent path");
  }

  async getAttestations(_agentId: AgentId, _pagination?: PaginationParams): Promise<Paginated<AttestationRecord>> {
    return { items: [], nextCursor: null };
  }

  async getAttestationByIdempotencyKey(_agentId: AgentId, _idempotencyKey: string): Promise<AttestationRecord | null> {
    return null;
  }

  async saveAttestation(_record: AttestationRecord): Promise<void> {
    // no-op for this pass
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    return [];
  }

  async saveRegisteredSource(_source: RegisteredSource): Promise<void> {
    // no-op for this pass
  }
}

function duplicateNameError(): Error & { code: string } {
  const err = new Error("name already exists") as Error & { code: string };
  err.code = "DUPLICATE_NAME";
  return err;
}

function notFoundError(): Error & { code: string } {
  const err = new Error("unknown agent") as Error & { code: string };
  err.code = "AGENT_NOT_FOUND";
  return err;
}

describe("createAgent", () => {
  it("creates an agent, signs the manifest, and persists a record without either private key", async () => {
    const storage = new FakeStorage();
    const result = await createAgent({ storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const identity = result.value;
    expect(identity.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.agent$/);
    expect(identity.publicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.ownerPublicKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(identity.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.ownerPrivateKey).toMatch(/^[0-9a-f]{64}$/);
    // the two keypairs must never coincide: the daily-use identity key being
    // also the kill switch is the exact weakness this design removes.
    expect(identity.ownerPublicKey).not.toBe(identity.publicKey);
    expect(identity.ownerPrivateKey).not.toBe(identity.privateKey);
    expect(identity.permissions).toEqual(["attest:self"]);
    expect(identity.memoryPointer).toBeNull();
    expect(identity.manifestVersion).toBe(MANIFEST_VERSION);
    expect(Number.isNaN(Date.parse(identity.createdAt))).toBe(false);
    expect(storage.saveCount).toBe(1);
    expect(storage.getByNameCount).toBeGreaterThan(0); // optimistic read ran
    const stored = storage.byId.get(identity.publicKey);
    expect(stored).toBeDefined();
    expect(stored!.name).toBe(identity.name);
    expect("privateKey" in stored!).toBe(false); // key custody: the record never carries it
    expect("ownerPrivateKey" in stored!).toBe(false); // nor the higher-value owner key
    expect(stored!.ownerPublicKey).toBe(identity.ownerPublicKey); // but the public owner key is persisted
    expect(stored!.revokedAt).toBeNull(); // freshly created agents are never revoked
  });

  it("honors an explicit name, memoryPointer, and permissions", async () => {
    const storage = new FakeStorage();
    const result = await createAgent({
      storage,
      name: "fixed-logic-owl.agent",
      memoryPointer: "ipfs://QmExample",
      permissions: ["attest:self", "ingest:external"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("fixed-logic-owl.agent");
    expect(result.value.memoryPointer).toBe("ipfs://QmExample");
    expect(result.value.permissions).toEqual(["attest:self", "ingest:external"]);
  });

  it("rejects a duplicate explicit name with DUPLICATE_NAME", async () => {
    const storage = new FakeStorage();
    const first = await createAgent({ storage, name: "fixed-logic-owl.agent" });
    expect(first.ok).toBe(true);
    const second = await createAgent({ storage, name: "fixed-logic-owl.agent" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("DUPLICATE_NAME");
    expect(storage.saveCount).toBe(2); // first persisted, second hit the constraint
  });

  it("retries with a fresh name when the constraint fires even though the optimistic read said free", async () => {
    // this is the check-then-write race from the design review: the fake's
    // getAgentByName always returns null for the first attempt, but the save
    // constraint still rejects the name, forcing a retry.
    const storage = new FakeStorage();
    storage.failFirstNSavesWithDuplicate = 1;
    const result = await createAgent({ storage });
    expect(result.ok).toBe(true);
    expect(storage.saveCount).toBe(2); // attempt 1 hit the constraint, attempt 2 persisted
  });

  it("returns NAME_GENERATION_EXHAUSTED when every attempt hits the constraint", async () => {
    const storage = new FakeStorage();
    storage.failFirstNSavesWithDuplicate = NAME_GENERATION_MAX_ATTEMPTS + 1;
    const result = await createAgent({ storage });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NAME_GENERATION_EXHAUSTED");
    expect(storage.saveCount).toBe(NAME_GENERATION_MAX_ATTEMPTS);
  });

  it("reports a generic storage failure without retrying", async () => {
    const storage = new FakeStorage();
    storage.failSavesWithGeneric = true;
    const result = await createAgent({ storage });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_WRITE_FAILED");
    expect(storage.saveCount).toBe(1); // generic failure is not a name conflict, no retry
  });

  it.each([
    { name: "Bad_Name!" },
    { name: "UPPER-CASE.agent" },
    { name: "-leading-hyphen.agent" },
    { memoryPointer: "ftp://nope" },
    { permissions: ["admin"] as unknown as AgentPermission[] },
    { permissions: ["attest:self", "attest:self"] },
  ])("rejects invalid option %# with INVALID_INPUT before any storage work", async (options) => {
    const storage = new FakeStorage();
    const result = await createAgent({ storage, ...options });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    expect(storage.saveCount).toBe(0); // fail fast: nothing was persisted
    expect(storage.getByNameCount).toBe(0); // and no name was even generated
  });
});

describe("verifyManifest", () => {
  async function createVerified(overrides?: Partial<AgentRecord>) {
    const storage = new FakeStorage();
    const created = await createAgent({ storage });
    if (!created.ok) throw new Error("setup failed");
    const manifest = { ...created.value, ...overrides };
    return { manifest, verification: await verifyManifest(manifest, storage), storage, created: created.value };
  }

  // builds a REAL v1 manifest exactly as the pre-revocation-pass code
  // produced it: the six legacy signed fields, no ownerPublicKey property at
  // all, signed by the identity key. the signature is computed INDEPENDENTLY
  // over the legacy six-field canonicalization with a fixed RFC 8032 test
  // vector key, never taken from any current-code path: the v1 branch of
  // verifyManifest must reproduce byte-identical bytes or this fails loudly
  // (the pinning guarantee). the returned storage holds the matching legacy
  // row, whose owner key is null on record with the requested revocation
  // state, exactly as a real pre-pass database would map.
  async function makeLegacyV1Fixture(revokedAt: string | null = null) {
    const secretKeyBytes = hexToBytes("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    const publicKey = bytesToHex(await getPublicKeyAsync(secretKeyBytes));
    const legacyFields = {
      name: "legacy-owl.agent",
      publicKey,
      memoryPointer: null,
      permissions: ["attest:self"] as AgentPermission[],
      createdAt: "2026-01-01T00:00:00.000Z",
      manifestVersion: 1,
    };
    const signature = bytesToHex(await signAsync(new TextEncoder().encode(canonicalize(legacyFields)), secretKeyBytes));
    // the v1 manifest has NO ownerPublicKey property; the cast expresses a
    // shape that predates the field, which the type now requires for v2.
    const manifest = { ...legacyFields, signature } as unknown as AgentManifest;
    const storage = new FakeStorage();
    storage.byId.set(publicKey, { ...legacyFields, signature, rowId: 1, ownerPublicKey: null, revokedAt });
    return { manifest, storage, publicKey };
  }

  it("verifies a manifest created under the old v1 schema exactly as before (pinning)", async () => {
    // the design review called this test out specifically: green here means
    // legacy manifests still verify byte-for-byte against their original
    // signed fields, not merely that the current suite says so.
    const { manifest, storage } = await makeLegacyV1Fixture();
    const verification = await verifyManifest(manifest, storage);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(true);
    expect(verification.value.reason).toBeNull();
  });

  it("verifies a v1 manifest even when an unsigned ownerPublicKey property is tacked on", async () => {
    // a tacked-on field cannot be in a v1 signature, so it cannot alter the
    // verdict: the signed bytes are the six legacy fields, period. this also
    // cannot be an attack: revocation reads the STORED record's owner key
    // (null for legacy), never anything from the manifest.
    const { manifest, storage } = await makeLegacyV1Fixture();
    const withTackedOnOwner = { ...manifest, ownerPublicKey: "22".repeat(32) } as unknown as AgentManifest;
    const verification = await verifyManifest(withTackedOnOwner, storage);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(true);
  });

  it("verifies a v2 manifest with the current seven-field canonical set", async () => {
    const { verification } = await createVerified();
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(true);
    expect(verification.value.reason).toBeNull();
  });

  it("rejects a tampered manifest with a specific reason", async () => {
    const { verification } = await createVerified({ name: "malicious-red-fox.agent" });
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).not.toBeNull();
  });

  it("rejects a corrupt signature", async () => {
    const { verification } = await createVerified({
      signature: "11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111",
    });
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
  });

  it("rejects a non-hex signature on shape before any crypto", async () => {
    const { verification } = await createVerified({ signature: "z".repeat(128) });
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toContain("signature");
  });

  it("rejects a malformed public key shape", async () => {
    const { verification } = await createVerified({ publicKey: "abcd" });
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toContain("publicKey");
  });

  it("rejects scopes outside the closed permission set", async () => {
    const storage = new FakeStorage();
    const created = await createAgent({ storage });
    if (!created.ok) throw new Error("setup failed");
    const verification = await verifyManifest({ ...created.value, permissions: ["admin"] as unknown as AgentPermission[] }, storage);
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toContain("permissions");
  });

  it("rejects a malformed ownerPublicKey on a v2 manifest", async () => {
    const { verification } = await createVerified({ ownerPublicKey: "abcd" });
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toBe("ownerPublicKey is not a 32-byte lowercase hex ed25519 key");
  });

  it("rejects a v2 manifest whose ownerPublicKey was swapped for another valid hex key", async () => {
    // the swapped key passes shape, so the signature check must catch it:
    // ownerPublicKey is part of the signed v2 canonical set.
    const { verification } = await createVerified({ ownerPublicKey: "22".repeat(32) });
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
  });

  it("fails closed on an unknown schema version", async () => {
    const { verification } = await createVerified({ manifestVersion: 99 });
    if (!verification.ok) throw new Error("unexpected verification failure");
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toBe("manifestVersion is not a supported schema version");
  });

  it("fails closed when the storage holds no record for the manifest (decision D1)", async () => {
    const storage = new FakeStorage();
    const created = await createAgent({ storage });
    if (!created.ok) throw new Error("setup failed");
    const emptyStorage = new FakeStorage(); // deliberately no record
    const verification = await verifyManifest(created.value, emptyStorage);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toBe("agent not found");
  });

  it("fails closed when the revocation status read throws", async () => {
    const { manifest } = await createVerified();
    const failing = new FakeStorage();
    failing.failGetAgent = true;
    const verification = await verifyManifest(manifest, failing);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toBe("agent revocation status could not be checked");
  });

  it("rejects a revoked v2 agent with reason key revoked even though the signature is valid", async () => {
    const { manifest, storage, created } = await createVerified();
    const storedRecord = storage.byId.get(created.publicKey);
    expect(storedRecord).toBeDefined();
    storedRecord!.revokedAt = "2026-02-01T00:00:00.000Z";
    const verification = await verifyManifest(manifest, storage);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toBe("key revoked");
  });

  it("rejects a revoked legacy v1 manifest with reason key revoked", async () => {
    // revocation must win over validity regardless of schema version, and a
    // legacy record with a revokedAt needs no owner key for that verdict.
    const { manifest, storage } = await makeLegacyV1Fixture("2026-02-01T00:00:00.000Z");
    const verification = await verifyManifest(manifest, storage);
    expect(verification.ok).toBe(true);
    if (!verification.ok) return;
    expect(verification.value.valid).toBe(false);
    expect(verification.value.reason).toBe("key revoked");
  });
});

describe("canonicalize", () => {
  it("serializes identical logical objects identically regardless of key order", () => {
    const a = canonicalize({
      name: "quiet-pig-blue.agent",
      permissions: ["attest:self"],
      nested: { b: 1, a: 2 },
      flags: [true, null, "z"],
    });
    const b = canonicalize({
      flags: [true, null, "z"],
      nested: { a: 2, b: 1 },
      permissions: ["attest:self"],
      name: "quiet-pig-blue.agent",
    });
    expect(a).toBe(b);
  });
});

describe("generateName", () => {
  it("generates names matching the word-word-word.agent shape", () => {
    for (let i = 0; i < 20; i++) {
      expect(generateName()).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.agent$/);
    }
  });
});