import { verifyAsync } from "@noble/ed25519";
import type { RevocationRequest } from "./types/identity.js";
import type { StorageAdapter } from "./types/storage.js";
import type { Result } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import { canonicalize } from "./canonical.js";
import { hexToBytes, isLowercaseHexOfLength } from "./hex.js";

// the one authority for how old a revocation request may be. the window is
// symmetric: a timestamp outside [now - 5min, now + 5min] is rejected as
// STALE_REVOCATION_REQUEST. the upper bound is what makes a captured request
// useless (a replayer can only ever be inside the window by replaying it
// within five minutes), and the symmetric lower bound keeps clock skew from
// being a revocation vector of its own.
export const REVOCATION_REQUEST_MAX_AGE_MS = 300_000;

// ed25519 verification is strict rfc8032 (zip215:false), the same branch the
// rest of the sdk uses for every signature, see the crypto note in agent.ts.

// shape validation for a RevocationRequest, before any signature or storage
// work. each failure is reported as INVALID_INPUT (caller bug / adversarial
// input), the same perimeter error the rest of the sdk uses for malformed
// arguments, and every branch fails closed.
function shapeInvalid(request: RevocationRequest): string | null {
  if (!isLowercaseHexOfLength(request.agentId, 32)) {
    return "agentId must be a 32-byte lowercase hex agent id";
  }
  if (!isLowercaseHexOfLength(request.signature, 64)) {
    return "signature must be a 64-byte lowercase hex ed25519 signature";
  }
  if (typeof request.timestamp !== "string" || Number.isNaN(Date.parse(request.timestamp))) {
    return "timestamp must be a valid iso 8601 utc string";
  }
  // a structurally impossible timestamp (out of the iso range) must not get
  // to the freshness check with a nonsense date that Date.now() cannot reach.
  return null;
}

/**
 * Revokes an agent. the ONLY entry point that can flip an agent's revoked
 * state; there is deliberately no bare, unauthenticated revoke path anywhere.
 *
 * The authorization model is: the request must carry a fresh ed25519 signature
 * made by the agent's OWNER private key over canonicalize({ agentId,
 * timestamp }). possession of the daily-use identity key is NOT enough, which
 * is the whole point of the two-keypair split in createAgent. every step of
 * the chain below fails closed: nothing is written unless every preceding
 * condition has explicitly passed, and the storage write happens only once,
 * at the very end, after full authorization.
 *
 * revoking an already-revoked agent is a no-op that reports success
 * (idempotent): the second request must STILL pass the full authorization
 * chain, but it triggers no second storage write.
 */
export async function revokeAgent(request: RevocationRequest, storage: StorageAdapter): Promise<Result<void>> {
  // 1. shape: the request must be well formed before anything else runs.
  const shapeIssue = shapeInvalid(request);
  if (shapeIssue !== null) {
    return failure("INVALID_INPUT", shapeIssue);
  }

  // 2. the agent must exist. this read also supplies the stored owner key for
  // the authorization check below, so the same read serves both the
  // existence gate and the key material, with no separate lookup window.
  let record;
  try {
    record = await storage.getAgent(request.agentId);
  } catch {
    // a failing read must not be reported as success and must not be
    // interpreted as "no record, therefore unauthenticated": under a flaky
    // store revocation fails closed as a generic storage failure, leaving
    // the agent in whatever state it was in already.
    return failure("STORAGE_WRITE_FAILED", "could not read the agent's revocation status");
  }
  if (record === null) {
    return failure("AGENT_NOT_FOUND", "cannot revoke an unknown agent");
  }

  // 3. fail closed on legacy rows: a row with no owner public key has no
  // authorization authority, so it can never be revoked via this path.
  // distinct from UNAUTHORIZED_REVOCATION because this is not a bad
  // signature, it is a data-model gap that must not be silently vaulted
  // over by a fallback (there is no fallback: no key, no revocation).
  if (record.ownerPublicKey === null) {
    return failure("OWNER_KEY_MISSING", "agent row has no owner key; revocation is not possible");
  }

  // 4. the signature must verify against the STORED owner key over exactly
  // { agentId, timestamp }. the owner key comes from the record, never from
  // the request, so an attacker cannot substitute their own key. the
  // timestamp used in the message is the unsigned request field, bound to
  // the signature below and re-checked for freshness in step 5.
  const canonical = canonicalize({ agentId: request.agentId, timestamp: request.timestamp });
  let valid;
  try {
    valid = await verifyAsync(
      hexToBytes(request.signature),
      new TextEncoder().encode(canonical),
      hexToBytes(record.ownerPublicKey),
      { zip215: false },
    );
  } catch {
    // a verification that throws (not just returns false) is still a
    // denial: possession was not proven, so the request is unauthorized.
    valid = false;
  }
  if (valid !== true) {
    return failure("UNAUTHORIZED_REVOCATION", "signature does not prove owner authorization to revoke");
  }

  // 5. freshness, checked only after authorization so that a stale request
  // made by the real owner still fails closed, and an unauthorized stale
  // request is rejected earlier as unauthorized. the symmetric window makes
  // both directions of clock skew safe.
  const receivedAt = Date.now();
  const requestedAt = Date.parse(request.timestamp);
  const delta = Math.abs(receivedAt - requestedAt);
  if (delta > REVOCATION_REQUEST_MAX_AGE_MS) {
    return failure("STALE_REVOCATION_REQUEST", "revocation request timestamp is outside the replay window");
  }

  // 6. idempotency: an already-revoked agent is success with no write. the
  // authorization above is still required, so a third party cannot probe the
  // "already revoked" branch to learn state, and replaying a stale owner
  // request never flips anything twice (it cannot reach here).
  if (record.revokedAt !== null) {
    return ok(undefined);
  }

  // 7. the only write in the whole function, at the very end, after every
  // gate has passed. storage.revokeAgent is the dumb UPDATE described in
  // types/storage.ts; it never re-verifies the signature, this layer is the
  // single enforcement point. the timestamp is generated here, fresh, so a
  // request's own timestamp never becomes the recorded revocation time.
  const revokedAt = new Date().toISOString();
  try {
    await storage.revokeAgent(request.agentId, revokedAt);
  } catch (err) {
    // fail closed: a failed persistence leaves the agent un-revoked, never
    // half-flagged, and the raw error (which may carry sql details) never
    // leaks into the public Result.
    if (typeof err === "object" && err !== null && (err as { code?: unknown }).code === "AGENT_NOT_FOUND") {
      return failure("AGENT_NOT_FOUND", "agent disappeared between the status check and the write");
    }
    return failure("STORAGE_WRITE_FAILED", "failed to persist the revocation");
  }

  return ok(undefined);
}
