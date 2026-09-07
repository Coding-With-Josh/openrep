// durable, owner-scoped SessionKeyStore implementation for the web/server
// layer, backed by the SessionKeyBackend interface that both storage
// adapters implement (session_keys table). it replaces InMemorySessionKeyStore
// wherever sessions must survive process restarts and serverless cold starts:
// expiry is persisted in the row, not held in process memory, so a restart
// cannot silently forget a live session (the in-memory store's documented
// trade-off) and a cold start cannot manufacture a session that never existed.
//
// design decisions (locked in the web phase):
// - set() takes the already-encrypted EncryptedKeyRecord, exactly like the
//   in-memory store: encryption is the caller's job (encryptPrivateKey in
//   src/security.ts, master key held by the caller). the persisted row type
//   SessionKeyRow cannot express a raw private key, structurally.
// - ownership is explicit on every operation: get/set/delete take an
//   ownerUserId and the backend scopes every row by the exact
//   (agent_id, owner_user_id) pair. a wrong owner is a miss (null), never a
//   fallthrough to another owner's row, so one browser cannot recover
//   another browser's keys (adversarial review: cross-owner access).
// - the session window is 30 minutes of inactivity by default, same policy
//   as the in-memory store. get() on a live row slides expiry forward by
//   writing the new expiry back, so an active session never expires under
//   its own activity and an idle one does. expiry survives restarts because
//   it is stored in the row.
// - expiry is pruned lazily on access (get() deletes its own expired row)
//   plus the exported clearExpired() sweep, which application code may call
//   on its own interval. no background timer anywhere: an unmanaged interval
//   inside a frozen serverless process is a bug.
// - set() rejects a record whose agentId does not match the key it is
//   stored under: the mismatch is a caller bug that would otherwise persist
//   an envelope under the wrong identity and fail confusingly at decrypt
//   time. fail fast, with a message naming the two ids (public values, never
//   secrets).
import type { AgentId } from "./types/identity.js";
import type { EncryptedKeyRecord, OwnedSessionKeyStore, SessionKeyBackend } from "./types/security.js";
import { DEFAULT_SESSION_WINDOW_MS } from "./session-store.js";

export class DurableSessionKeyStore implements OwnedSessionKeyStore {
  private readonly backend: SessionKeyBackend;
  private readonly windowMs: number;

  constructor(backend: SessionKeyBackend, options: { windowMs?: number } = {}) {
    this.backend = backend;
    this.windowMs = options.windowMs ?? DEFAULT_SESSION_WINDOW_MS;
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs <= 0) {
      throw new RangeError(`session window must be a positive integer, got ${options.windowMs}`);
    }
  }

  // returns the encrypted record for a live (agent, owner) session, null for
  // absent or expired. an expired row is deleted on the way out (lazy prune).
  // a live hit slides the expiry forward and persists the slide, so the
  // window survives the next process restart. the raw private key never
  // appears here, the caller decrypts the returned record in memory at the
  // moment of signing.
  async get(agentId: AgentId, ownerUserId: string): Promise<EncryptedKeyRecord | null> {
    const row = await this.backend.getSessionKey(agentId, ownerUserId);
    if (row === null) return null;
    if (row.expiresAtEpochMs <= Date.now()) {
      // lazy prune: the expired row is gone, not soft-deleted.
      await this.backend.deleteSessionKey(agentId, ownerUserId);
      return null;
    }
    // slide forward. if a concurrent sweep deletes the row between the read
    // and this write, the touch is a no-op and the envelope already returned
    // stays valid to its caller; the window simply is not extended.
    const nextExpiry = Date.now() + this.windowMs;
    await this.backend.touchSessionKey(agentId, ownerUserId, nextExpiry);
    return {
      agentId: row.agentId,
      encryptedPrivateKey: row.encryptedPrivateKey,
      iv: row.iv,
      algorithm: row.algorithm,
      createdAt: row.createdAt,
    };
  }

  // stores an encrypted envelope under an explicit owner, replacing any
  // previous entry for the same (agent, owner) pair. a raw key cannot be
  // passed here: the parameter type is EncryptedKeyRecord and encryption
  // happens before this call.
  async set(agentId: AgentId, ownerUserId: string, record: EncryptedKeyRecord): Promise<void> {
    if (record.agentId !== agentId) {
      throw new Error(`refusing to store a session key for ${record.agentId} under the key ${agentId}`);
    }
    await this.backend.setSessionKey({
      agentId,
      ownerUserId,
      encryptedPrivateKey: record.encryptedPrivateKey,
      iv: record.iv,
      algorithm: record.algorithm,
      createdAt: record.createdAt,
      expiresAtEpochMs: Date.now() + this.windowMs,
    });
  }

  // removes the (agent, owner) entry outright, no soft-delete.
  async delete(agentId: AgentId, ownerUserId: string): Promise<void> {
    await this.backend.deleteSessionKey(agentId, ownerUserId);
  }

  // sweeps every expired row. application code on a long lived server
  // schedules this on its own interval; the store never uses a timer.
  async clearExpired(): Promise<void> {
    await this.backend.sweepExpiredSessionKeys(Date.now());
  }
}