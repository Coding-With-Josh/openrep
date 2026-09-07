import { keygenAsync, verifyAsync } from "@noble/ed25519";
import type { KeyRotationRecord, RotateRequest, RotatedAgentIdentity } from "./types/identity.js";
import type { AgentRecord, StorageAdapter } from "./types/storage.js";
import type { Result } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import { canonicalize } from "./canonical.js";
import { bytesToHex, hexToBytes, isLowercaseHexOfLength } from "./hex.js";
import { generateName } from "./names.js";
import {
  MANIFEST_VERSION,
  NAME_GENERATION_MAX_ATTEMPTS,
  isDuplicateNameError,
  signManifestFields,
  toAgentRecord,
} from "./agent.js";
import { REVOCATION_REQUEST_MAX_AGE_MS } from "./revocation.js";

// rotation uses the exact same symmetric replay window as revocation: a
// captured owner-signed rotation request is only usable inside the window,
// and a stale one fails before any storage work. the single shared binding
// below (re-exported under the rotation name) is deliberate: the two
// operations must never drift on what "fresh" means.
export const ROTATION_REQUEST_MAX_AGE_MS = REVOCATION_REQUEST_MAX_AGE_MS;

// shape validation for a RotateRequest, before any signature or storage
// work. identical contract to revocation's: each failure is INVALID_INPUT
// (caller bug / adversarial input) and every branch fails closed.
function shapeInvalid(request: RotateRequest): string | null {
  if (!isLowercaseHexOfLength(request.agentId, 32)) {
    return "agentId must be a 32-byte lowercase hex agent id";
  }
  if (!isLowercaseHexOfLength(request.signature, 64)) {
    return "signature must be a 64-byte lowercase hex ed25519 signature";
  }
  if (typeof request.timestamp !== "string" || Number.isNaN(Date.parse(request.timestamp))) {
    return "timestamp must be a valid iso 8601 utc string";
  }
  return null;
}

/**
 * Issues a successor identity for an agent. rotation is lineage, not an
 * in-place re-key: the ledger keys agents by their public key and is
 * append-only, so a new identity keypair is necessarily a NEW canonical id.
 * rotateAgent creates that successor (new name, same owner key, inherited
 * memory pointer and permissions, fresh manifest signed by the new identity
 * key) and persists a self-verifying KeyRotationRecord linking old id to
 * new id, in one atomic storage transaction. the old agent stays live with
 * its full history: this is the chosen policy, because spelling out "re-key
 * because the old key leaked" is owner(authorize rotate) + owner(authorize
 * revoke old id) as two audited, owner-signed calls, and a pure hygiene
 * rotation keeps old history verifiable. rotation of a revoked agent fails
 * closed (revocation stays permanent), and possession of the identity key
 * alone is never enough to rotate.
 *
 * The authorization model mirrors revokeAgent exactly: the request must
 * carry a fresh ed25519 signature made by the agent's OWNER private key
 * over canonicalize({ agentId, timestamp }). every step fails closed, and
 * the only storage write is the atomic rotateAgent at the very end, after
 * full authorization.
 */
export async function rotateAgent(
  request: RotateRequest,
  storage: StorageAdapter,
): Promise<Result<RotatedAgentIdentity>> {
  // 1. shape: the request must be well formed before anything else runs.
  const shapeIssue = shapeInvalid(request);
  if (shapeIssue !== null) {
    return failure("INVALID_INPUT", shapeIssue);
  }

  // 2. the old agent must exist. this read also supplies the stored owner
  // key for the authorization check below, exactly like revokeAgent.
  let record: AgentRecord | null;
  try {
    record = await storage.getAgent(request.agentId);
  } catch {
    // a failing read is not success and is not "unknown": under a flaky
    // store rotation fails closed as a generic storage failure.
    return failure("STORAGE_WRITE_FAILED", "could not read the agent's rotation status");
  }
  if (record === null) {
    return failure("AGENT_NOT_FOUND", "cannot rotate an unknown agent");
  }

  // 3. fail closed on legacy rows: no owner public key, no rotation
  // authority, no rotation. same rule as revocation (no fallback exists).
  if (record.ownerPublicKey === null) {
    return failure("OWNER_KEY_MISSING", "agent row has no owner key; rotation is not possible");
  }

  // 4. the signature must verify against the STORED owner key over exactly
  // { agentId, timestamp }. the owner key comes from the record, never from
  // the request, so an attacker cannot substitute their own key.
  const canonical = canonicalize({ agentId: request.agentId, timestamp: request.timestamp });
  let valid: boolean;
  try {
    valid = await verifyAsync(
      hexToBytes(request.signature),
      new TextEncoder().encode(canonical),
      hexToBytes(record.ownerPublicKey),
      { zip215: false },
    );
  } catch {
    // a verification that throws is still a denial: possession was not
    // proven, so the request is unauthorized.
    valid = false;
  }
  if (valid !== true) {
    return failure("UNAUTHORIZED_ROTATION", "signature does not prove owner authorization to rotate");
  }

  // 5. freshness, checked only after authorization, same window as
  // revocation so both directions of clock skew stay safe.
  const receivedAt = Date.now();
  const requestedAt = Date.parse(request.timestamp);
  const delta = Math.abs(receivedAt - requestedAt);
  if (delta > ROTATION_REQUEST_MAX_AGE_MS) {
    return failure("STALE_ROTATION_REQUEST", "rotation request timestamp is outside the replay window");
  }

  // 6. resurrection gate: rotation must never bring a revoked agent back to
  // life under a new id. revocation is permanent; the correct response to a
  // revoked agent that must keep working is a fresh createAgent, not a
  // rotation of the corpse.
  if (record.revokedAt !== null) {
    return failure("AGENT_REVOKED", "agent is revoked and cannot be rotated");
  }

  // 7. a fresh IDENTITY keypair only. the owner key is unchanged (same
  // custody, same kill switch), so the successor inherits record.ownerPublicKey
  // and the caller keeps using the owner private key they already hold.
  let identityKeypair: { privateKey: string; publicKey: string };
  try {
    const identity = await keygenAsync();
    identityKeypair = { privateKey: bytesToHex(identity.secretKey), publicKey: bytesToHex(identity.publicKey) };
  } catch {
    // entropy unavailable is an environment failure, reported as a typed
    // error, never thrown (fail-closed default: no successor is minted
    // without real randomness).
    return failure("KEY_GENERATION_FAILED", "failed to generate the successor ed25519 keypair");
  }

  const successorCreatedAt = new Date().toISOString();
  const ownerPublicKey = record.ownerPublicKey;

  // 8. auto-generated name with the same bounded retry loop as createAgent.
  // uniqueness safety comes from the storage backend's unique constraint on
  // name, never from the optimistic getAgentByName read. each attempt saves
  // through storage.rotateAgent's single transaction, so a DUPLICATE_NAME
  // conflict rolls back the whole attempt and leaves no partial successor
  // and no dangling audit row (adversarial review: partial write).
  for (let attempt = 0; attempt < NAME_GENERATION_MAX_ATTEMPTS; attempt++) {
    const name = generateName();
    try {
      const existing = await storage.getAgentByName(name);
      if (existing !== null) continue; // optimistic skip, optimization only
    } catch {
      // degraded mode: treat the name as free and let the authoritative
      // constraint decide on save.
    }

    const manifest = await signManifestFields(
      {
        name,
        publicKey: identityKeypair.publicKey,
        ownerPublicKey,
        memoryPointer: record.memoryPointer,
        permissions: record.permissions,
        createdAt: successorCreatedAt,
        manifestVersion: MANIFEST_VERSION,
      },
      identityKeypair.privateKey,
    );
    const successorRecord = toAgentRecord(manifest);
    const rotation: KeyRotationRecord = {
      oldPublicKey: request.agentId,
      newPublicKey: identityKeypair.publicKey,
      signedBy: ownerPublicKey,
      // the audit row stores the REQUEST's timestamp, the value bound into
      // the signature, so the record is self-verifying offline (the applied
      // time is the successor's createdAt, generated fresh above).
      timestamp: request.timestamp,
      signature: request.signature,
    };
    try {
      await storage.rotateAgent(successorRecord, rotation);
      // the caller receives the successor identity with only the NEW
      // identity private key; the owner key was not regenerated, so there
      // is no new kill switch to hand back.
      return ok({ ...manifest, privateKey: identityKeypair.privateKey });
    } catch (err) {
      if (isDuplicateNameError(err)) continue; // constraint fired, retry with a fresh name
      // fail closed: a generic storage failure is never reported as success
      // or as a name conflict, and the raw error never leaks into the
      // public Result.
      return failure("STORAGE_WRITE_FAILED", "failed to persist the rotated identity");
    }
  }

  // sustained collisions on every attempt would otherwise loop forever; the
  // retry cap converts that into a typed, actionable error.
  return failure(
    "NAME_GENERATION_EXHAUSTED",
    `could not find a free name after ${NAME_GENERATION_MAX_ATTEMPTS} attempts`,
  );
}