// in-memory SessionKeyStore implementation behind the storage-agnostic
// SessionKeyStore interface. sessions end when the process restarts, which
// is the correct, documented trade-off for this scale: the locked policy
// says a session key store is not a persistent cross-restart store.
//
// design decisions (locked in the session-key persistence pass):
// - set() takes the already-encrypted EncryptedKeyRecord. encryption is the
//   caller's job (encryptPrivateKey in src/security.ts, with the master key
//   held by the caller, never here), so the store's parameter and internal
//   types are EncryptedKeyRecord and a raw private string cannot enter this
//   store by any code path, structurally, not just by convention.
// - the session window is 30 minutes of inactivity by default: get() on a
//   live entry slides the expiry forward, so an active session never
//   expires under it, and an idle one does. a fixed per-entry window can be
//   injected through the constructor for tests.
// - expiry is pruned lazily on access (get() drops its own expired entry)
//   plus the exported clearExpired() sweep, which application code may call
//   on its own interval if it wants bounded memory. the store never starts
//   a background timer: an unmanaged interval inside a frozen serverless
//   process is a bug, and a long lived server can schedule clearExpired()
//   itself.
import type { AgentId } from "./types/identity.js";
import type { EncryptedKeyRecord, SessionKeyStore } from "./types/security.js";

// default inactivity window: 30 minutes. application code can pick a
// different window via the constructor without touching the interface.
export const DEFAULT_SESSION_WINDOW_MS = 30 * 60 * 1000;

interface SessionEntry {
  // the encrypted envelope. never the raw key, ever.
  record: EncryptedKeyRecord;
  // epoch ms at which the entry expires; get() slides it forward on a
  // live hit so an active session stays alive.
  expiresAt: number;
}

export class InMemorySessionKeyStore implements SessionKeyStore {
  private readonly entries: Map<AgentId, SessionEntry>;
  private readonly windowMs: number;

  constructor(options: { windowMs?: number } = {}) {
    this.entries = new Map();
    this.windowMs = options.windowMs ?? DEFAULT_SESSION_WINDOW_MS;
    if (!Number.isSafeInteger(this.windowMs) || this.windowMs <= 0) {
      throw new RangeError(`session window must be a positive integer, got ${options.windowMs}`);
    }
  }

  // returns the encrypted record for a live session, null for absent or
  // expired. a live hit slides the expiry forward (inactivity-based
  // window). the raw private key never appears here, the caller decrypts
  // the returned record in memory at the moment of signing.
  async get(agentId: AgentId): Promise<EncryptedKeyRecord | null> {
    const entry = this.entries.get(agentId);
    if (entry === undefined) return null;
    if (entry.expiresAt <= Date.now()) {
      // lazy prune: the expired entry is gone, not soft-deleted.
      this.entries.delete(agentId);
      return null;
    }
    entry.expiresAt = Date.now() + this.windowMs;
    return entry.record;
  }

  // stores an encrypted envelope, replacing any previous entry for the
  // same agent. a raw key cannot be passed here: the parameter type is
  // EncryptedKeyRecord and encryption happens before this call.
  async set(agentId: AgentId, record: EncryptedKeyRecord): Promise<void> {
    this.entries.set(agentId, { record, expiresAt: Date.now() + this.windowMs });
  }

  // removes an entry outright, no soft-delete.
  async delete(agentId: AgentId): Promise<void> {
    this.entries.delete(agentId);
  }

  // sweeps every expired entry. application code on a long lived server
  // schedules this on its own interval; the store never uses a timer.
  async clearExpired(): Promise<void> {
    const now = Date.now();
    for (const [agentId, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(agentId);
    }
  }
}