// canonical identity decision: an agent is canonically identified by its
// public key everywhere, in attestations, storage keys, and lookups. the
// human readable name is a mutable, resolvable alias on top of the public
// key, never the canonical id, since names can be renamed later.

// stable agent identifier. equals the public key, used as the canonical
// foreign key everywhere an agent is referenced.
export type AgentId = string;

// raw keypair material. only ever held in memory during generation and
// signing, never persisted or returned to the browser.
export interface Keypair {
  publicKey: string;
  privateKey: string;
}

// the closed set of scopes an agent's identity can carry. widen this union
// by adding literals when new scopes actually exist, never as free form
// strings at the call site.
export type AgentPermission = "attest:self" | "ingest:external";

// portable identity card for an agent. this is what travels with the agent
// and what external verifiers check. never contains the private key.
export interface AgentManifest {
  name: string; // human readable identifier, e.g. beautiful-pig-black.agent, mutable alias
  publicKey: string; // canonical id, per the decision at the top of this file
  ownerPublicKey: string; // separate authorization key for revocation, never the identity key
  memoryPointer: string | null; // a uri (ipfs://, https://) or null when unset
  permissions: AgentPermission[]; // closed union of granted scopes, not a free form array
  createdAt: string; // iso 8601 utc, used consistently everywhere
  manifestVersion: number; // schema version, so the manifest can evolve without breaking old ones
  signature: string; // ed25519 signature over the manifest fields above it
}

// full identity including the private keys. exists only inside the sdk right
// after generation. never the return type of anything exposed to an api
// route or the browser, see types/api.ts. privateKey is the identity key
// used for day-to-day attestation signing. ownerPrivateKey authorizes
// revocation and is meant to be used far less often and stored more
// carefully: whoever holds it can kill the agent.
export interface AgentIdentity extends AgentManifest {
  privateKey: string;
  ownerPrivateKey: string;
}

// record of a key rotation, kept for audit. the record is self-verifying:
// signature is the ed25519 signature from the authorizing RotateRequest,
// made by the key named in signedBy over canonicalize({ agentId:
// oldPublicKey, timestamp }), and timestamp is the request's own timestamp
// (the value bound into signature). the applied time is the successor
// manifest's createdAt, generated fresh at rotation time; the audited
// timestamp here is the authorization time, chosen so the row can be
// re-verified offline exactly as the request was.
export interface KeyRotationRecord {
  oldPublicKey: string;
  newPublicKey: string;
  signedBy: string; // public key that authorized the rotation (the agent's owner key)
  timestamp: string; // iso 8601 utc, the request timestamp bound into signature
  signature: string; // ed25519 over canonicalize({ agentId: oldPublicKey, timestamp })
}

// a revocation request, the only way to revoke an agent. the signature is
// produced with the agent's OWNER private key over the canonicalized
// { agentId, timestamp }, proving the caller possesses the key that the
// manifest's ownerPublicKey names. possession of the identity key alone is
// not enough to revoke, by deliberate design: the daily-use key must not
// also be the kill switch.
export interface RevocationRequest {
  agentId: AgentId;
  timestamp: string; // iso 8601 utc, must fall inside the replay window
  signature: string; // ed25519 over canonicalize({ agentId, timestamp })
}

// a rotation request, the only way to re-key an agent into a successor
// identity. deliberately the same shape and the same authorization model as
// RevocationRequest: the signature is produced with the agent's OWNER
// private key over canonicalize({ agentId, timestamp }), and possession of
// the identity key alone is not enough to rotate (the daily-use key is the
// most exposed key, so it must never be the key that can move an identity).
export interface RotateRequest {
  agentId: AgentId; // the current agent, identified by its public key
  timestamp: string; // iso 8601 utc, must fall inside the replay window
  signature: string; // ed25519 over canonicalize({ agentId, timestamp })
}

// identity returned by rotateAgent: the successor manifest plus the NEW
// identity private key. deliberately not a full AgentIdentity: rotation
// keeps the same owner key (the caller already holds it, they just used it
// to sign the request), so there is no new owner private key to hand back,
// and transmitting the kill switch a second time would only spread it.
export interface RotatedAgentIdentity extends AgentManifest {
  privateKey: string; // the successor's identity key, for day-to-day signing only
}