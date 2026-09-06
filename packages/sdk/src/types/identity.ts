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

// record of a key rotation, kept for audit. defined now so the storage
// schema does not need a breaking change when rotation is implemented.
export interface KeyRotationRecord {
  oldPublicKey: string;
  newPublicKey: string;
  signedBy: string; // public key that authorized the rotation
  timestamp: string; // iso 8601 utc
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