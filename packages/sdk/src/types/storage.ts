import type { AgentId, AgentManifest, KeyRotationRecord } from "./identity";
import type { Attestation } from "./attestation";
import type { RegisteredSource } from "./sources";

// an agent as persisted. everything in the manifest's portable fields except
// the owner public key is widened to nullable: rows created before the
// revocation pass genuinely have no owner key on record, and must never be
// revocable (the sdk fails closed on null with OWNER_KEY_MISSING). revokedAt
// is null until a valid, authorized revocation request marks the agent.
export interface AgentRecord extends Omit<AgentManifest, "ownerPublicKey"> {
  ownerPublicKey: string | null; // null only on pre-revocation-pass legacy rows
  revokedAt: string | null; // iso 8601 utc when revoked, null until then
  rowId?: number; // internal index assigned by storage at insert time, not part of the portable identity
}

// an attestation as persisted.
export interface AttestationRecord extends Attestation {
  rowId: number; // internal index
  // optional idempotency key used for dedup. storage-internal like rowId,
  // never part of the portable signed Attestation. the composite unique
  // index on (agent_id, idempotency_key) in the concrete backend is the
  // authoritative guard; null or absent means no dedup applies.
  idempotencyKey?: string;
}

// pagination params for any list returning function.
export interface PaginationParams {
  cursor?: string;
  limit?: number;
}

// standard paginated result shape, used by storage, activity, and any list.
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// storage contract. calling code depends only on this interface. the
// concrete implementation for this pass is sqlite, noted here so callers
// never import the backend directly and it can be swapped later.
export interface StorageAdapter {
  getAgent(agentId: AgentId): Promise<AgentRecord | null>;
  // name lookup used only for the optimistic collision check in createAgent.
  // the read is an optimization, never the source of truth for uniqueness.
  // the authoritative guard is a unique constraint on the name column in the
  // concrete backend, which also closes the check-then-write race between
  // two concurrent createAgent calls.
  getAgentByName(name: string): Promise<AgentRecord | null>;
  // persists an agent record. on a name-constraint violation (concurrent
  // create, or a caller supplied name that already exists) implementations
  // must throw an error whose `code` property is exactly "DUPLICATE_NAME",
  // matching the sdk's OpenRepErrorCode vocabulary. any other throw is
  // treated as a generic storage failure by callers. never logs or exposes
  // secrets or stack traces.
  saveAgent(record: AgentRecord): Promise<void>;
  // the actual revocation write, an internal storage method: performs the
  // UPDATE that sets revoked_at. called only from revokeAgent() in the sdk
  // layer, AFTER the caller's owner-key signature and replay-window checks
  // have already passed. storage itself never re-verifies signatures, that
  // is the sdk's job. when no row matches, implementations must throw an
  // error whose code property is exactly "AGENT_NOT_FOUND".
  revokeAgent(agentId: AgentId, revokedAt: string): Promise<void>;
  // the actual rotation write, an internal storage method: persists the
  // successor agent AND its key_rotations audit row in ONE atomic
  // transaction, so a partial rotation (new identity without lineage, or a
  // lineage pointing at nothing) can never be observed or persisted. called
  // only from rotateAgent() in the sdk layer, AFTER the caller's owner-key
  // signature, replay-window, and revocation-state checks have all passed.
  // storage never re-verifies signatures. on a name-constraint violation
  // implementations must throw DUPLICATE_NAME (createAgent-style, which the
  // sdk retry loop branches on) and on a public-key collision
  // DUPLICATE_PUBLIC_KEY; the transaction guarantees neither row persists
  // after such a rejection. any other throw is a generic storage failure.
  rotateAgent(record: AgentRecord, rotation: KeyRotationRecord): Promise<void>;
  // audit read for the rotation lineage: every key_rotation whose
  // old or new public key matches the agent id, newest first. not-found is
  // an empty array, never an error.
  getKeyRotations(agentId: AgentId): Promise<KeyRotationRecord[]>;
  getAttestations(agentId: AgentId, pagination?: PaginationParams): Promise<Paginated<AttestationRecord>>;
  // lookup used only for the optimistic idempotency check in attest(). like
  // getAgentByName, the read is an optimization, never the source of truth:
  // the authoritative dedup guard is a composite unique index on
  // (agent_id, idempotency_key) in the concrete backend, which also closes
  // the check-then-write race between two concurrent attest calls carrying
  // the same idempotency key.
  getAttestationByIdempotencyKey(agentId: AgentId, idempotencyKey: string): Promise<AttestationRecord | null>;
  saveAttestation(record: AttestationRecord): Promise<void>;
  getRegisteredSources(): Promise<RegisteredSource[]>;
  saveRegisteredSource(source: RegisteredSource): Promise<void>;
}