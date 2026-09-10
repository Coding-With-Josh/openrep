import { describe, expect, it } from "vitest";
import { signAsync, verifyAsync } from "@noble/ed25519";
import {
  ROTATION_REQUEST_MAX_AGE_MS,
  attest,
  canonicalize,
  createAgent,
  rotateAgent,
  verifyAttestation,
} from "../src/index.js";
import type {
  AgentId,
  AgentPermission,
  AgentRecord,
  AttestationRecord,
  KeyRotationRecord,
  Paginated,
  PaginationParams,
  RegisteredSource,
  RotateRequest,
  StorageAdapter,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

// storage fake that serves the rotation path and PROVES the ordering and
// atomicity claims: rotations records what rotateAgent was asked to persist
// (so tests can assert the sdk never reaches the write before full
// authorization, and that a failed attempt writes nothing), and failRotate /
// duplicateEveryName let tests deterministically inject the two storage
// failures the sdk must route around.
class FakeStorage implements StorageAdapter {
  readonly byId = new Map<string, AgentRecord>();
  readonly rotations: KeyRotationRecord[] = [];
  readonly attested: AttestationRecord[] = [];
  failGetAgent = false;
  failRotate = false; // every rotateAgent write throws a generic storage failure
  duplicateEveryName = false; // every rotateAgent write throws DUPLICATE_NAME

  async getAgent(agentId: AgentId): Promise<AgentRecord | null> {
    if (this.failGetAgent) throw new Error("read failed on purpose");
    return this.byId.get(agentId) ?? null;
  }

  async getAgentByName(_name: string): Promise<AgentRecord | null> {
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

  async setAgentVisibility(agentId: AgentId, visibility: AgentVisibility): Promise<void> {
    const existing = this.byId.get(agentId);
    if (existing === undefined) throw codedError("AGENT_NOT_FOUND", "no such agent");
    this.byId.set(agentId, { ...existing, visibility });
  }

  async listPublicAgents(): Promise<AgentRecord[]> {
    return [...this.byId.values()].filter((a) => a.revokedAt === null && a.visibility === "public");
  }

  async rotateAgent(record: AgentRecord, rotation: KeyRotationRecord): Promise<void> {
    if (this.failRotate) throw new Error("disk is on fire");
    if (this.duplicateEveryName) throw codedError("DUPLICATE_NAME", "name already exists");
    this.byId.set(record.publicKey, record);
    this.rotations.push(rotation);
  }

  async getKeyRotations(_agentId: AgentId): Promise<KeyRotationRecord[]> {
    return [...this.rotations];
  }

  async getAttestations(_agentId: AgentId, _pagination?: PaginationParams): Promise<Paginated<AttestationRecord>> {
    return { items: [], nextCursor: null };
  }

  async getAttestationByIdempotencyKey(_agentId: AgentId, _idempotencyKey: string): Promise<AttestationRecord | null> {
    return null;
  }

  async saveAttestation(record: AttestationRecord): Promise<void> {
    this.attested.push(record);
  }

  async getRegisteredSources(): Promise<RegisteredSource[]> {
    return [];
  }

  async saveRegisteredSource(_source: RegisteredSource): Promise<void> {
    // not exercised on this path
  }
}

function codedError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// builds a fresh agent (real, via createAgent) and returns its identity plus
// the storage it lives in. every signature below is produced with real
// @noble ed25519 over the exact bytes the sdk verifies.
async function makeAgent() {
  const storage = new FakeStorage();
  const created = await createAgent({ storage });
  if (!created.ok) throw new Error("setup failed");
  return { identity: created.value, storage };
}

async function ownerSign(req: { agentId: string; timestamp: string }, ownerSecretHex: string): Promise<string> {
  const signature = await signAsync(
    new TextEncoder().encode(canonicalize({ agentId: req.agentId, timestamp: req.timestamp })),
    hexToBytes(ownerSecretHex),
  );
  return bytesToHex(signature);
}

describe("rotateAgent", () => {
  it("issues a successor identity with a new id, same owner key, inherited fields, and a verifiable audit record", async () => {
    const { identity, storage } = await makeAgent();
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const successor = result.value;

    // lineage: a NEW canonical id (the ledger keys agents by public key),
    // never the same id re-keyed in place.
    expect(successor.publicKey).not.toBe(identity.publicKey);
    expect(successor.publicKey).toMatch(/^[0-9a-f]{64}$/);
    // the successor has its own identity private key but no new owner key:
    // rotation keeps the same owner custody by design.
    expect(successor.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(successor.ownerPublicKey).toBe(identity.ownerPublicKey);
    // inherited agent data, fresh name and creation time, current manifest
    // schema, signed by the new identity key.
    expect(successor.memoryPointer).toBe(identity.memoryPointer);
    expect(successor.permissions).toEqual(identity.permissions);
    expect(successor.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.agent$/);
    expect(successor.name).not.toBe(identity.name);
    expect(Number.isNaN(Date.parse(successor.createdAt))).toBe(false);
    expect(successor.manifestVersion).toBe(2);
    expect(successor.signature).toMatch(/^[0-9a-f]{128}$/);

    // the old agent is still live (never revoked, still resolvable).
    const oldReadBack = storage.byId.get(identity.publicKey);
    expect(oldReadBack).toBeDefined();
    expect(oldReadBack!.revokedAt).toBeNull();

    // the audit record is self-verifying: signature made by the owner key
    // over exactly the request's { agentId, timestamp }.
    expect(storage.rotations).toHaveLength(1);
    const rotation = storage.rotations[0];
    expect(rotation.oldPublicKey).toBe(identity.publicKey);
    expect(rotation.newPublicKey).toBe(successor.publicKey);
    expect(rotation.signedBy).toBe(identity.ownerPublicKey);
    expect(rotation.timestamp).toBe(timestamp);
    const auditValid = await verifyAsync(
      hexToBytes(rotation.signature),
      new TextEncoder().encode(canonicalize({ agentId: identity.publicKey, timestamp })),
      hexToBytes(identity.ownerPublicKey),
      { zip215: false },
    );
    expect(auditValid).toBe(true);
  });

  it("carries the old record's visibility onto the successor (private stays private)", async () => {
    const storage = new FakeStorage();
    const created = await createAgent({ storage, visibility: "private" });
    if (!created.ok) throw new Error("setup failed");
    const identity = created.value;
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the successor inherits the visibility policy: rotation re-issues the
    // identity, it must not silently change who can see the agent.
    expect(storage.byId.get(result.value.publicKey)!.visibility).toBe("private");
    expect(storage.byId.get(identity.publicKey)!.visibility).toBe("private");
  });

  it("returns a successor identity key that actually signs (corresponds to its manifest public key)", async () => {
    const { identity, storage } = await makeAgent();
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // sign something with the returned private key and check it against the
    // successor's public key: the private key is genuine, not a filler.
    const message = "successor key correspondence";
    const probe = await signAsync(new TextEncoder().encode(message), hexToBytes(result.value.privateKey));
    const valid = await verifyAsync(probe, new TextEncoder().encode(message), hexToBytes(result.value.publicKey), {
      zip215: false,
    });
    expect(valid).toBe(true);
  });

  it("lets the successor attest under its new id, and the attestation verifies", async () => {
    const { identity, storage } = await makeAgent();
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const rotated = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    const attested = await attest(
      {
        agentId: rotated.value.publicKey,
        task: "name the successor",
        output: "kin",
        toolsUsed: [],
        source: "native",
      },
      rotated.value.privateKey,
      storage,
    );
    expect(attested.ok).toBe(true);
    if (!attested.ok) return;

    const verdict = await verifyAttestation(attested.value, storage);
    expect(verdict.valid).toBe(true);
  });

  it("leaves the old agent live and its old-identity attestations verifiable (rotation is not revocation)", async () => {
    const { identity, storage } = await makeAgent();
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const rotated = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // the old identity key still signs under the old id: the agent was not
    // revoked by rotating. retiring a leaked key is the composite
    // rotate + revoke, both owner-authorized, never rotation alone.
    const oldAttested = await attest(
      {
        agentId: identity.publicKey,
        task: "keep the old ledger",
        output: "history stays",
        toolsUsed: [],
        source: "native",
      },
      identity.privateKey,
      storage,
    );
    expect(oldAttested.ok).toBe(true);
    if (!oldAttested.ok) return;
    const oldVerdict = await verifyAttestation(oldAttested.value, storage);
    expect(oldVerdict.valid).toBe(true);
  });

  it("rejects a request signed with the identity key, not the owner key (distinct keypairs)", async () => {
    const { identity, storage } = await makeAgent();
    // the identity key is the wrong key for rotation: holding it signs
    // attestations, it must never authorize an identity move.
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.privateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_ROTATION");
    expect(storage.rotations).toHaveLength(0); // nothing was written
    expect(storage.byId.size).toBe(1);
  });

  it("rejects a request signed with an unrelated generated key", async () => {
    const { identity, storage } = await makeAgent();
    const attackerSecret = "e0".repeat(32);
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, attackerSecret);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_ROTATION");
    expect(storage.rotations).toHaveLength(0);
    expect(storage.byId.size).toBe(1);
  });

  it("rejects a request whose timestamp is outside the symmetric replay window (stale)", async () => {
    const { identity, storage } = await makeAgent();
    const stale = new Date(Date.now() - ROTATION_REQUEST_MAX_AGE_MS - 1000).toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp: stale }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp: stale, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_ROTATION_REQUEST");
    expect(storage.rotations).toHaveLength(0);
  });

  it("rejects a request whose timestamp is in the future beyond the window (clock skew)", async () => {
    const { identity, storage } = await makeAgent();
    const future = new Date(Date.now() + ROTATION_REQUEST_MAX_AGE_MS + 1000).toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp: future }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp: future, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_ROTATION_REQUEST");
    expect(storage.rotations).toHaveLength(0);
  });

  it("rejects a request for an unknown agent", async () => {
    const storage = new FakeStorage();
    const timestamp = new Date().toISOString();
    const result = await rotateAgent({ agentId: "ab".repeat(32), timestamp, signature: "cd".repeat(64) }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AGENT_NOT_FOUND");
    expect(storage.rotations).toHaveLength(0);
  });

  it("fails closed when the agent row has no owner key (legacy), and never writes", async () => {
    const storage = new FakeStorage();
    // a hand-built legacy row: like a pre-pass database, it has no owner key.
    storage.byId.set("ab".repeat(32), {
      name: "legacy.agent",
      publicKey: "ab".repeat(32),
      ownerPublicKey: null,
      memoryPointer: null,
      permissions: ["attest:self"] as AgentPermission[],
      createdAt: "2026-01-01T00:00:00.000Z",
      manifestVersion: 1,
      signature: "sig",
      revokedAt: null,
    });
    const timestamp = new Date().toISOString();
    const result = await rotateAgent({ agentId: "ab".repeat(32), timestamp, signature: "cd".repeat(64) }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OWNER_KEY_MISSING");
    expect(storage.rotations).toHaveLength(0);
  });

  it("fails closed when the agent is already revoked (resurrection gate)", async () => {
    const { identity, storage } = await makeAgent();
    storage.byId.set(identity.publicKey, { ...storage.byId.get(identity.publicKey)!, revokedAt: "2026-02-01T00:00:00.000Z" });
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AGENT_REVOKED");
    expect(storage.rotations).toHaveLength(0);
    expect(storage.byId.size).toBe(1);
  });

  it("fails closed when the status read throws, and never writes", async () => {
    const { identity, storage } = await makeAgent();
    storage.failGetAgent = true;
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_WRITE_FAILED");
    expect(storage.rotations).toHaveLength(0);
  });

  it("reports a generic failure when the persistence write throws, leaving nothing written", async () => {
    const { identity, storage } = await makeAgent();
    storage.failRotate = true;
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_WRITE_FAILED");
    expect(storage.rotations).toHaveLength(0);
    expect(storage.byId.size).toBe(1); // no successor agent appeared
  });

  it("exhausts the generated-name retries with NAME_GENERATION_EXHAUSTED and writes nothing", async () => {
    const { identity, storage } = await makeAgent();
    storage.duplicateEveryName = true; // the constraint fires on every attempt
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await rotateAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NAME_GENERATION_EXHAUSTED");
    expect(storage.rotations).toHaveLength(0);
    expect(storage.byId.size).toBe(1); // no partial successor, no dangling audit
  });

  it("rejects structurally malformed requests with INVALID_INPUT before any storage work", async () => {
    const { identity, storage } = await makeAgent();
    const bad: Array<Partial<RotateRequest>> = [
      { agentId: "not-hex" },
      { agentId: "AA".repeat(32) }, // uppercase hex rejected, codec is lowercase-only
      { signature: "short" },
      { timestamp: "not-a-date" },
    ];
    for (const overrides of bad) {
      const request: RotateRequest = {
        agentId: identity.publicKey,
        timestamp: new Date().toISOString(),
        signature: "cd".repeat(64),
        ...overrides,
      };
      const result = await rotateAgent(request, storage);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    }
    expect(storage.rotations).toHaveLength(0);
  });
});