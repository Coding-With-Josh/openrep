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

// returns the master key from the environment. throws a typed OpenRepError
// with code MISSING_MASTER_KEY when it is missing, never proceeds with an
// empty or default key.
export function getMasterKey(): string {
  // TODO: read env, validate non-empty, throw typed error when missing
  throw new Error("Not implemented yet");
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

// storage for session-scoped encrypted keys. the concrete implementation
// for this pass can be an in-memory store with expiry, but the interface is
// storage agnostic so it can be swapped for a real backing store without
// changing calling code.
export interface SessionKeyStore {
  get(agentId: AgentId): Promise<EncryptedKeyRecord | null>;
  set(agentId: AgentId, record: EncryptedKeyRecord): Promise<void>;
  delete(agentId: AgentId): Promise<void>;
  clearExpired(): Promise<void>; // session keys must have a real expiry, not live forever
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