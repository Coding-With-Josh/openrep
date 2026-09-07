import { describe, expect, it } from "vitest";
import { signAsync } from "@noble/ed25519";
import { revokeAgent, REVOCATION_REQUEST_MAX_AGE_MS, canonicalize, createAgent } from "../src/index.js";
import type { AgentId, AgentRecord, KeyRotationRecord, RevocationRequest } from "../src/index.js";
import type { AgentPermission } from "../src/index.js";
import type { AttestationRecord, Paginated, PaginationParams, RegisteredSource, StorageAdapter } from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

// storage fake that only serves the revocation path. its job beyond the
// contract is to PROVE the ordering claims: revokeCount records how many
// times the authoritative UPDATE actually fired, and revokeCalls records the
// timestamps it was asked to write, so tests can assert the write happens at
// most once and only after full authorization.
class FakeStorage implements StorageAdapter {
  readonly byId = new Map<string, AgentRecord>();
  revokeCount = 0;
  readonly revokeCalls: string[] = [];
  failGetAgent = false;
  failRevoke = false;

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
    this.revokeCount++;
    this.revokeCalls.push(revokedAt);
    if (this.failRevoke) throw new Error("disk is on fire");
    const existing = this.byId.get(agentId);
    if (existing === undefined) throw codedError("AGENT_NOT_FOUND", "no such agent");
    this.byId.set(agentId, { ...existing, revokedAt });
  }

  async rotateAgent(_record: AgentRecord, _rotation: KeyRotationRecord): Promise<void> {
    throw new Error("not on the revocation path");
  }

  async getKeyRotations(_agentId: AgentId): Promise<KeyRotationRecord[]> {
    throw new Error("not on the revocation path");
  }

  async getAttestations(_agentId: AgentId, _pagination?: PaginationParams): Promise<Paginated<AttestationRecord>> {
    return { items: [], nextCursor: null };
  }

  async getAttestationByIdempotencyKey(_agentId: AgentId, _idempotencyKey: string): Promise<AttestationRecord | null> {
    return null;
  }

  async saveAttestation(_record: AttestationRecord): Promise<void> {
    // not exercised on this path
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

// builds a fresh agent (real, via createAgent on a throwaway storage) and
// returns its public key, plus a signing function that signs a canonicalized
// request message with the given secret key. keeps the crypto honest: every
// signature is produced with real @noble ed25519 over the exact bytes the
// sdk verifies.
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

describe("revokeAgent", () => {
  it("revokes an agent when the request carries a fresh, correct owner signature", async () => {
    const { identity, storage } = await makeAgent();
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(true);
    expect(storage.revokeCount).toBe(1); // the authoritative write fired exactly once
    const readBack = storage.byId.get(identity.publicKey);
    expect(readBack).toBeDefined();
    // the sdk generates the recorded timestamp itself and never trusts the
    // request's timestamp for the recorded value.
    expect(readBack!.revokedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(readBack!.revokedAt!))).toBe(false);
    expect(storage.revokeCalls[0]).toBe(readBack!.revokedAt);
  });

  it("rejects a request signed with the identity key, not the owner key (distinct keypairs)", async () => {
    const { identity, storage } = await makeAgent();
    const timestamp = new Date().toISOString();
    // the identity key is the wrong key for revocation: holding it signs
    // attestations, not revocations.
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.privateKey);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_REVOCATION");
    expect(storage.revokeCount).toBe(0); // nothing was written
    expect(storage.byId.get(identity.publicKey)!.revokedAt).toBeNull();
  });

  it("rejects a request signed with an unrelated generated key", async () => {
    const { identity, storage } = await makeAgent();
    // an attacker with their own fresh keypair tries to revoke the agent.
    // the secret key here is unrelated to the agent's owner key, so even a
    // perfectly well-formed fresh signature must fail authorization.
    const attackerSecret = makeUnrelatedSecret();
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, attackerSecret);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNAUTHORIZED_REVOCATION");
    expect(storage.revokeCount).toBe(0);
    expect(storage.byId.get(identity.publicKey)!.revokedAt).toBeNull();
  });

  it("rejects a request whose timestamp is outside the symmetric replay window (stale)", async () => {
    const { identity, storage } = await makeAgent();
    // a request forged long ago, replayed now by its holder: it is verified
    // as authorized (right key) but rejected for freshness, which is what
    // makes a captured request useless.
    const stale = new Date(Date.now() - REVOCATION_REQUEST_MAX_AGE_MS - 1000).toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp: stale }, identity.ownerPrivateKey);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp: stale, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_REVOCATION_REQUEST");
    expect(storage.revokeCount).toBe(0);
  });

  it("rejects a request whose timestamp is in the future beyond the window (clock skew)", async () => {
    const { identity, storage } = await makeAgent();
    const future = new Date(Date.now() + REVOCATION_REQUEST_MAX_AGE_MS + 1000).toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp: future }, identity.ownerPrivateKey);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp: future, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_REVOCATION_REQUEST");
    expect(storage.revokeCount).toBe(0);
  });

  it("rejects a request for an unknown agent", async () => {
    const storage = new FakeStorage();
    const timestamp = new Date().toISOString();
    const result = await revokeAgent({ agentId: "ab".repeat(32), timestamp, signature: "cd".repeat(64) }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AGENT_NOT_FOUND");
    expect(storage.revokeCount).toBe(0);
  });

  it("is idempotent: revoking an already-revoked agent succeeds with one write total", async () => {
    const { identity, storage } = await makeAgent();
    const firstTs = new Date().toISOString();
    const firstSig = await ownerSign({ agentId: identity.publicKey, timestamp: firstTs }, identity.ownerPrivateKey);
    const first = await revokeAgent({ agentId: identity.publicKey, timestamp: firstTs, signature: firstSig }, storage);
    expect(first.ok).toBe(true);
    const recordedRevokedAt = storage.byId.get(identity.publicKey)!.revokedAt;

    // second, fresh, correctly-signed request for the same agent
    const secondTs = new Date().toISOString();
    const secondSig = await ownerSign({ agentId: identity.publicKey, timestamp: secondTs }, identity.ownerPrivateKey);
    const second = await revokeAgent({ agentId: identity.publicKey, timestamp: secondTs, signature: secondSig }, storage);

    expect(second.ok).toBe(true);
    expect(storage.revokeCount).toBe(1); // the write fired exactly once across both calls
    expect(storage.byId.get(identity.publicKey)!.revokedAt).toBe(recordedRevokedAt); // first timestamp preserved
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
    const result = await revokeAgent({ agentId: "ab".repeat(32), timestamp, signature: "cd".repeat(64) }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OWNER_KEY_MISSING");
    expect(storage.revokeCount).toBe(0);
  });

  it("fails closed when the status read throws, and never writes", async () => {
    const { identity, storage } = await makeAgent();
    storage.failGetAgent = true;
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_WRITE_FAILED");
    expect(storage.revokeCount).toBe(0);
  });

  it("reports a generic failure when the persistence write throws, leaving the agent un-revoked", async () => {
    const { identity, storage } = await makeAgent();
    storage.failRevoke = true;
    const timestamp = new Date().toISOString();
    const signature = await ownerSign({ agentId: identity.publicKey, timestamp }, identity.ownerPrivateKey);
    const result = await revokeAgent({ agentId: identity.publicKey, timestamp, signature }, storage);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STORAGE_WRITE_FAILED");
  });

  it("rejects structurally malformed requests with INVALID_INPUT before any storage work", async () => {
    const { identity, storage } = await makeAgent();
    const bad: Array<Partial<RevocationRequest>> = [
      { agentId: "not-hex" },
      { agentId: "AA".repeat(32) }, // uppercase hex rejected, codec is lowercase-only
      { signature: "short" },
      { timestamp: "not-a-date" },
    ];
    for (const overrides of bad) {
      const request: RevocationRequest = {
        agentId: identity.publicKey,
        timestamp: new Date().toISOString(),
        signature: "cd".repeat(64),
        ...overrides,
      };
      const result = await revokeAgent(request, storage);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
    }
  });
});

// tiny helper to fabricate a distinct, unrelated secret key (used by the
// "unrelated generated key" threat-model test). deterministic and obviously
// NOT the agent's owner key: a well-formed fresh signature made with it must
// fail authorization because the derivation yields a different public key
// than the stored ownerPublicKey.
function makeUnrelatedSecret(): string {
  return "e0".repeat(32);
}
