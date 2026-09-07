import type { AgentId } from "./identity";

// encrypted form of an agent private key at rest. never the raw key, always
// an envelope encrypted with the server master key.
export interface EncryptedKeyRecord {
  agentId: AgentId;
  encryptedPrivateKey: string; // base64 ciphertext of the private key
  iv: string; // base64 initialization vector, unique per encryption
  algorithm: string; // explicit algorithm name, e.g. "aes-256-gcm"
  createdAt: string; // iso 8601 utc
}

// the server's own symmetric encryption key used for envelope encryption of
// agent private keys. loaded from the environment, never logged, never
// committed, never included in any error message or stack trace. the value
// itself lives only in process memory after getMasterKey loads it.
export interface MasterKeyConfig {
  readonly source: "env"; // the key comes from the environment, never supplied inline
}

// returns the master key from the environment. implementation lives in
// src/security.ts (the package entry exports that one explicitly, which
// shadows any star-exported duplicate); this file defines the contract only.
export interface MasterKeyProvider {
  getMasterKey(): string;
}

// the key custody policy as types plus comments, not just prose. code that
// touches private keys must not contradict these rules.
export interface KeyCustodyPolicy {
  // single request keys: generated and used inside one request, held only
  // in process memory for the duration of that request, never written
  // anywhere.
  ephemeralKeys: "memory-only";
  // session keys that must persist across a request are encrypted with the
  // master key into an EncryptedKeyRecord before going into the store.
  sessionKeys: "encrypted-envelope";
  // the algorithm used for that envelope encryption.
  sessionKeyAlgorithm: "aes-256-gcm";
  // raw, unencrypted private keys are never written to disk, a database,
  // logs, or any persistent store, under any circumstance.
  rawKeyPersistence: "never";
}

// storage for session-scoped encrypted keys. the reference implementation is
// InMemorySessionKeyStore in src/session-store.ts (process scoped, expiry
// enforced, no background timer); the durable, owner-scoped variant meant for
// the web/server layer over a real store is DurableSessionKeyStore in
// src/session-store-durable.ts backed by the SessionKeyBackend interface
// below. the interface stays storage agnostic so either implementation can be
// swapped without changing calling code. the agentId-keyed base interface has
// no owner concept; web-layer deployments that must not let one browser
// recover another browser's keys use the owned variant instead.
export interface SessionKeyStore {
  get(agentId: AgentId): Promise<EncryptedKeyRecord | null>;
  set(agentId: AgentId, record: EncryptedKeyRecord): Promise<void>;
  delete(agentId: AgentId): Promise<void>;
  clearExpired(): Promise<void>; // session keys must have a real expiry, not live forever
}

// persisted row behind DurableSessionKeyStore. carries only the encrypted
// envelope plus the ownership and expiry bookkeeping: a raw private key
// cannot be represented in this shape, structurally, never by convention.
export interface SessionKeyRow {
  agentId: AgentId;
  // the owning browser session id (minted by the web layer, never derived
  // from the agent key). there is deliberately no foreign key to a users
  // table: the ledger has no user concept, single user demo, and ownership
  // is enforced by the (agent_id, owner_user_id) pair scoping below.
  ownerUserId: string;
  encryptedPrivateKey: string; // base64 ciphertext of the private key
  iv: string; // base64 initialization vector, unique per encryption
  algorithm: string; // explicit algorithm name, e.g. "aes-256-gcm"
  createdAt: string; // iso 8601 utc
  // epoch ms at which the session expires; DurableSessionKeyStore slides it
  // forward on a live get so expiry survives process restarts, unlike the
  // in-memory store whose window dies with the process.
  expiresAtEpochMs: number;
}

// dumb persistence contract over the session_keys table. crypto and window
// logic live in DurableSessionKeyStore, never here; the adapters implement
// this alongside StorageAdapter so the web layer holds ONE storage handle
// for both the reputation ledger and session key custody. every read is
// scoped to the exact (agent_id, owner_user_id) pair, so no backend method
// can enumerate another owner's rows (adversarial review: cross-owner
// access).
export interface SessionKeyBackend {
  getSessionKey(agentId: AgentId, ownerUserId: string): Promise<SessionKeyRow | null>;
  setSessionKey(row: SessionKeyRow): Promise<void>; // upsert: one row per pair
  touchSessionKey(agentId: AgentId, ownerUserId: string, expiresAtEpochMs: number): Promise<void>; // idempotent slide
  deleteSessionKey(agentId: AgentId, ownerUserId: string): Promise<void>;
  sweepExpiredSessionKeys(beforeEpochMs: number): Promise<void>;
}

// owner-scoped session key contract for multi-browser deployments. every
// operation names the owner explicitly; a wrong owner is a miss, never a
// fallthrough to another owner's row.
export interface OwnedSessionKeyStore {
  get(agentId: AgentId, ownerUserId: string): Promise<EncryptedKeyRecord | null>;
  set(agentId: AgentId, ownerUserId: string, record: EncryptedKeyRecord): Promise<void>;
  delete(agentId: AgentId, ownerUserId: string): Promise<void>;
  clearExpired(): Promise<void>;
}

// fixed window rate limit configuration. actual enforcement is a separate
// decision, but the type exists now so abuse prevention is not bolted on as
// an afterthought.
export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

// per agent or per session tracking state for rate limiting.
export interface RateLimitState {
  windowStartedAt: string; // iso 8601 utc, start of the current window
  requestCount: number; // requests observed in the current window
}