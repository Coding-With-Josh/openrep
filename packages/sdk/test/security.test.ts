// tests for the sdk-side session key primitives: getMasterKey, the
// aes-256-gcm envelope encrypt/decrypt, and the InMemorySessionKeyStore.
// security tests, so the matrix also asserts the negative space: every
// failure path fails closed with KEY_DECRYPTION_FAILED, nothing throws
// unexpectedly, and no failure message or internal state ever contains the
// master key or a raw private key.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_WINDOW_MS,
  ENCRYPTED_KEY_ALGORITHM,
  InMemorySessionKeyStore,
  MASTER_KEY_ENV_VAR,
  decryptPrivateKey,
  encryptPrivateKey,
  getMasterKey,
  type EncryptedKeyRecord,
} from "../src/index.js";

// realistic private key shapes: a 64-char lowercase hex ed25519 key and a
// non-ascii string proving the envelope is utf8 clean end to end.
const PRIVATE_KEY_HEX = "af".repeat(32);
const PRIVATE_KEY_UTF8 = "snowman \u2603 and coffee \u2615";
const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);
const MASTER_A = "master-key-alpha-0123456789";
const MASTER_B = "master-key-beta-9876543210";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function encryptFor(privateKey: string, masterKey: string, agentId: string): EncryptedKeyRecord {
  const record = encryptPrivateKey(privateKey, masterKey, agentId);
  expect(record.algorithm).toBe(ENCRYPTED_KEY_ALGORITHM);
  expect(record.agentId).toBe(agentId);
  expect(record.encryptedPrivateKey.length).toBeGreaterThan(0);
  expect(record.iv.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
  return record;
}

describe("getMasterKey", () => {
  it("reads the canonical env var through the injected env", () => {
    expect(getMasterKey({ [MASTER_KEY_ENV_VAR]: "  secret-value  " })).toBe("secret-value");
  });

  it("reads process.env by default when present", () => {
    const previous = process.env[MASTER_KEY_ENV_VAR];
    process.env[MASTER_KEY_ENV_VAR] = "default-env-key";
    try {
      expect(getMasterKey()).toBe("default-env-key");
    } finally {
      if (previous === undefined) delete process.env[MASTER_KEY_ENV_VAR];
      else process.env[MASTER_KEY_ENV_VAR] = previous;
    }
  });

  it("fails with MISSING_MASTER_KEY when the env var is absent", () => {
    try {
      getMasterKey({});
      expect.unreachable("getMasterKey must throw on a missing master key");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("MISSING_MASTER_KEY");
    }
  });

  it("fails with MISSING_MASTER_KEY on whitespace-only values", () => {
    try {
      getMasterKey({ [MASTER_KEY_ENV_VAR]: "   " });
      expect.unreachable("getMasterKey must throw on a whitespace master key");
    } catch (err) {
      const error = err as { code?: string; message?: string };
      expect(error.code).toBe("MISSING_MASTER_KEY");
      expect(error.message).toContain(MASTER_KEY_ENV_VAR);
      expect(error.message).not.toContain("   ");
    }
  });

  it("fails loudly with a message naming the variable, never the value", () => {
    const planted = "top-secret-master-value";
    try {
      getMasterKey({});
      expect.unreachable("getMasterKey must throw");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain(MASTER_KEY_ENV_VAR);
      expect(message).not.toContain(planted);
    }
  });
});

describe("envelope encryption", () => {
  it("round trips a 64-char hex private key exactly", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const result = decryptPrivateKey(record, MASTER_A);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(PRIVATE_KEY_HEX);
  });

  it("round trips a non-ascii private key exactly (utf8 clean)", () => {
    const record = encryptFor(PRIVATE_KEY_UTF8, MASTER_A, AGENT_A);
    const result = decryptPrivateKey(record, MASTER_A);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(PRIVATE_KEY_UTF8);
  });

  it("uses a fresh random iv per encryption, never reused", () => {
    const first = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const second = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    expect(first.iv).not.toBe(second.iv);
    // different iv means different ciphertext even for the same key.
    expect(first.encryptedPrivateKey).not.toBe(second.encryptedPrivateKey);
  });

  it("decrypts with the wrong master key as KEY_DECRYPTION_FAILED, never garbage", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const result = decryptPrivateKey(record, MASTER_B);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
  });

  it("catches a single tampered byte in the ciphertext via the gcm auth tag", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const blob = Buffer.from(record.encryptedPrivateKey, "base64");
    // flip a byte deep inside the ciphertext, after the 16-byte tag.
    blob[blob.length - 5] ^= 0xff;
    const tampered: EncryptedKeyRecord = { ...record, encryptedPrivateKey: blob.toString("base64") };
    const result = decryptPrivateKey(tampered, MASTER_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
  });

  it("catches a single tampered byte in the iv via the gcm auth tag", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const iv = Buffer.from(record.iv, "base64");
    iv[0] ^= 0x01;
    const tampered: EncryptedKeyRecord = { ...record, iv: iv.toString("base64") };
    const result = decryptPrivateKey(tampered, MASTER_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
  });

  it("catches a truncated ciphertext blob", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const blob = Buffer.from(record.encryptedPrivateKey, "base64");
    const truncated: EncryptedKeyRecord = { ...record, encryptedPrivateKey: blob.subarray(0, blob.length - 1).toString("base64") };
    const result = decryptPrivateKey(truncated, MASTER_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
  });

  it("rejects a blob too short to carry the tag plus ciphertext", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const short: EncryptedKeyRecord = { ...record, encryptedPrivateKey: Buffer.from("abc").toString("base64") };
    const result = decryptPrivateKey(short, MASTER_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
  });

  it("rejects a garbage base64 blob and a wrong-length iv, fail closed", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    for (const malformed of [
      { ...record, encryptedPrivateKey: "not-base64!!!" },
      { ...record, iv: "!!!" },
      { ...record, iv: Buffer.from("short").toString("base64") },
    ]) {
      const result = decryptPrivateKey(malformed, MASTER_A);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
    }
  });

  it("rejects a record with an unexpected algorithm and a record missing fields", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    for (const malformed of [
      { ...record, algorithm: "aes-256-cbc" },
      { ...record, agentId: undefined },
      { ...record, createdAt: 42 },
    ]) {
      const result = decryptPrivateKey(malformed as unknown as EncryptedKeyRecord, MASTER_A);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("KEY_DECRYPTION_FAILED");
    }
  });

  it("never throws, and its failure messages never contain key material or ciphertext", () => {
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const failures = [
      decryptPrivateKey(record, MASTER_B),
      decryptPrivateKey({ ...record, encryptedPrivateKey: "broken" }, MASTER_A),
      decryptPrivateKey({ ...record, iv: "broken" }, MASTER_A),
    ];
    for (const failure of failures) {
      expect(failure.ok).toBe(false);
      if (!failure.ok) {
        expect(failure.error.message).not.toContain(MASTER_A);
        expect(failure.error.message).not.toContain(MASTER_B);
        expect(failure.error.message).not.toContain(PRIVATE_KEY_HEX);
        expect(failure.error.message).not.toContain(record.encryptedPrivateKey);
        expect(failure.error.message).not.toContain(record.iv);
      }
    }
  });
});

// inspects the store's actual internal representation. private by TS only,
// plain JS properties, so the test can hold the store to its structural
// promise: the internal map values are { record: EncryptedKeyRecord,
// expiresAt } and a raw private string can never appear anywhere inside.
interface InternalEntry {
  record: EncryptedKeyRecord;
  expiresAt: number;
}
function internals(store: InMemorySessionKeyStore): Map<string, InternalEntry> {
  return (store as unknown as { entries: Map<string, InternalEntry> }).entries;
}

describe("InMemorySessionKeyStore", () => {
  it("defaults to a documented 30 minute inactivity window", () => {
    expect(DEFAULT_SESSION_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("stores and returns the encrypted record, decryptable only with the right master key", async () => {
    const store = new InMemorySessionKeyStore();
    const record = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    await store.set(AGENT_A, record);
    const stored = await store.get(AGENT_A);
    expect(stored).toEqual(record);
    expect(decryptPrivateKey(stored!, MASTER_A).ok).toBe(true);
    expect(decryptPrivateKey(stored!, MASTER_B).ok).toBe(false);
  });

  it("returns null for a nonexistent agent", async () => {
    const store = new InMemorySessionKeyStore();
    expect(await store.get(AGENT_A)).toBeNull();
  });

  it("returns null for an expired entry and prunes it", async () => {
    const store = new InMemorySessionKeyStore({ windowMs: 40 });
    await store.set(AGENT_A, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A));
    expect(await store.get(AGENT_A)).not.toBeNull();
    await sleep(60);
    expect(await store.get(AGENT_A)).toBeNull();
    expect(internals(store).has(AGENT_A)).toBe(false);
  });

  it("slides the inactivity window forward on a live get", async () => {
    const store = new InMemorySessionKeyStore({ windowMs: 10_000 });
    await store.set(AGENT_A, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A));
    const before = internals(store).get(AGENT_A)!.expiresAt;
    await sleep(30);
    expect(await store.get(AGENT_A)).not.toBeNull();
    const after = internals(store).get(AGENT_A)!.expiresAt;
    // the refresh moved expiry forward past the original window.
    expect(after).toBeGreaterThan(before);
  });

  it("delete removes the entry outright", async () => {
    const store = new InMemorySessionKeyStore();
    await store.set(AGENT_A, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A));
    await store.delete(AGENT_A);
    expect(await store.get(AGENT_A)).toBeNull();
    expect(internals(store).has(AGENT_A)).toBe(false);
  });

  it("clearExpired prunes only genuinely expired entries and leaves live ones", async () => {
    const store = new InMemorySessionKeyStore({ windowMs: 80 });
    await store.set(AGENT_A, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A)); // expires ~t+80
    await sleep(50);
    await store.set(AGENT_B, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_B)); // expires ~t+130
    await sleep(50); // now ~t+100: A expired, B still live
    await store.clearExpired();
    expect(internals(store).has(AGENT_A)).toBe(false);
    expect(internals(store).has(AGENT_B)).toBe(true);
    expect(await store.get(AGENT_A)).toBeNull();
    expect(await store.get(AGENT_B)).not.toBeNull();
  });

  it("set replaces a previous entry for the same agent", async () => {
    const store = new InMemorySessionKeyStore();
    await store.set(AGENT_A, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A));
    const replacement = encryptFor("f".repeat(64), MASTER_A, AGENT_A);
    await store.set(AGENT_A, replacement);
    expect(internals(store).size).toBe(1);
    const stored = await store.get(AGENT_A);
    expect(stored).toEqual(replacement);
    const decrypted = decryptPrivateKey(stored!, MASTER_A);
    expect(decrypted.ok && decrypted.value).toBe("f".repeat(64));
  });

  it("is structurally incapable of holding a raw private key: internal state is envelopes only", async () => {
    const store = new InMemorySessionKeyStore();
    const recordA = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const recordB = encryptFor(PRIVATE_KEY_UTF8, MASTER_A, AGENT_B);
    await store.set(AGENT_A, recordA);
    await store.set(AGENT_B, recordB);

    const entries = internals(store);
    expect(entries.size).toBe(2);
    for (const [agentId, entry] of entries) {
      // the entry shape is exactly { record, expiresAt }, nothing more.
      expect(Object.keys(entry).sort()).toEqual(["expiresAt", "record"]);
      // the record is the encrypted envelope, carrying only its five fields.
      expect(Object.keys(entry.record).sort()).toEqual([
        "agentId",
        "algorithm",
        "createdAt",
        "encryptedPrivateKey",
        "iv",
      ]);
      expect(entry.record).toEqual(agentId === AGENT_A ? recordA : recordB);
      // no string anywhere in the entry may contain a raw key, and the
      // master key never reaches the store either.
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(PRIVATE_KEY_HEX);
      expect(serialized).not.toContain(PRIVATE_KEY_UTF8);
      expect(serialized).not.toContain(MASTER_A);
    }
  });

  it("keeps one agent's session isolated from another's", async () => {
    const store = new InMemorySessionKeyStore();
    await store.set(AGENT_A, encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A));
    await store.set(AGENT_B, encryptFor("b0".repeat(32), MASTER_A, AGENT_B));
    const a = await store.get(AGENT_A);
    const b = await store.get(AGENT_B);
    expect(a).not.toEqual(b);
    expect(a!.agentId).toBe(AGENT_A);
    expect(b!.agentId).toBe(AGENT_B);
  });
});

describe("two stores, two master keys", () => {
  it("a record encrypted under one master key cannot be decrypted with the other", async () => {
    const storeA = new InMemorySessionKeyStore();
    const storeB = new InMemorySessionKeyStore();
    // the intended calling pattern: each store pair keeps its own master
    // key in the caller, encryption happens before set().
    const recordA = encryptFor(PRIVATE_KEY_HEX, MASTER_A, AGENT_A);
    const recordB = encryptFor(PRIVATE_KEY_HEX, MASTER_B, AGENT_A);
    await storeA.set(AGENT_A, recordA);
    await storeB.set(AGENT_A, recordB);

    const fromA = await storeA.get(AGENT_A);
    const fromB = await storeB.get(AGENT_A);
    expect(fromA).toEqual(recordA);
    expect(fromB).toEqual(recordB);
    expect(fromA).not.toEqual(fromB);

    // the master key is doing real cryptographic work: each record only
    // decrypts under its own key.
    const viaOwnA = decryptPrivateKey(fromA!, MASTER_A);
    const crossA = decryptPrivateKey(fromA!, MASTER_B);
    const viaOwnB = decryptPrivateKey(fromB!, MASTER_B);
    const crossB = decryptPrivateKey(fromB!, MASTER_A);
    expect(viaOwnA.ok && viaOwnA.value).toBe(PRIVATE_KEY_HEX);
    expect(viaOwnB.ok && viaOwnB.value).toBe(PRIVATE_KEY_HEX);
    expect(crossA.ok).toBe(false);
    expect(crossB.ok).toBe(false);
    if (!crossA.ok) expect(crossA.error.code).toBe("KEY_DECRYPTION_FAILED");
    if (!crossB.ok) expect(crossB.error.code).toBe("KEY_DECRYPTION_FAILED");
  });
});

describe("intended web app calling pattern (defined, not wired)", () => {
  it("session start, request signing, and logout flow", async () => {
    const store = new InMemorySessionKeyStore();
    const masterKey = getMasterKey({ [MASTER_KEY_ENV_VAR]: "web-app-master-key" });

    // chat route, new session: get() on an absent id is treated as a new
    // session (returns null, no raw key, no error).
    expect(await store.get(AGENT_A)).toBeNull();

    // after createAgent / explicit unlock the server side caller stores
    // the encrypted envelope.
    const record = encryptFor(PRIVATE_KEY_HEX, masterKey, AGENT_A);
    await store.set(AGENT_A, record);

    // each request: get, decrypt only in memory at the moment of signing.
    const stored = await store.get(AGENT_A);
    expect(stored).not.toBeNull();
    const decrypted = decryptPrivateKey(stored!, masterKey);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) expect(decrypted.value).toBe(PRIVATE_KEY_HEX);

    // logout: delete removes the envelope outright.
    await store.delete(AGENT_A);
    expect(await store.get(AGENT_A)).toBeNull();
  });
});