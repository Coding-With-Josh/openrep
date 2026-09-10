// custody resolver unit tests: env precedence, keychain, encrypted-file
// fallback (round trip, wrong passphrase, tamper, perms, memoized provider),
// and fail-closed behavior. no real login keychain is ever touched: the
// darwin keychain cases run against a throwaway keychain created with
// `security create-keychain`.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentIdentity } from "@openrepso/sdk";

import type { CliEnv } from "../src/config.js";
import { createCustody, type Custody } from "../src/custody/index.js";
import { createEncryptedFileStore, EncryptedFileError } from "../src/custody/encrypted-file.js";
import { createKeychainStore } from "../src/custody/keychain.js";
import { identityAccount, type KeyStore } from "../src/custody/types.js";

// any structurally valid 32-byte key; custody never signs, only stores.
const PRIV = "ab".repeat(32);
const OWNER = "12".repeat(32);
const PK = "cd".repeat(32);
const OWNER_PK = "34".repeat(32);

const identity: AgentIdentity = {
  name: "custody-test.agent",
  publicKey: PK,
  ownerPublicKey: OWNER_PK,
  memoryPointer: null,
  permissions: ["attest:self", "ingest:external"],
  createdAt: "2026-01-01T00:00:00.000Z",
  manifestVersion: 1,
  signature: "00".repeat(64),
  privateKey: PRIV,
  ownerPrivateKey: OWNER,
};

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openrep-custody-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env(overrides: Partial<CliEnv> = {}): CliEnv {
  return {
    dbPath: ":memory:",
    signingKey: undefined,
    ownerKey: undefined,
    keychainPath: undefined,
    credentialsFile: undefined,
    ...overrides,
  };
}

function fileStoreCustody(getPassphrase: () => Promise<string>): { custody: Custody; filePath: string } {
  const filePath = join(tmpDir(), "credentials.enc");
  const custody = createCustody(env({ credentialsFile: filePath }), {
    stores: [createEncryptedFileStore(filePath, getPassphrase)],
    note: () => {},
  });
  return { custody, filePath };
}

describe("env keys", () => {
  it("env key wins over every store and is never persisted", async () => {
    const filePath = join(tmpDir(), "credentials.enc");
    const getPassphrase = vi.fn(async () => "pass");
    const custody = createCustody(env({ signingKey: PRIV, credentialsFile: filePath }), {
      stores: [createEncryptedFileStore(filePath, getPassphrase)],
      note: () => {},
    });

    const res = await custody.resolveIdentityKey(PK);
    expect(res).toEqual({ key: PRIV, source: "env" });
    expect(getPassphrase).not.toHaveBeenCalled(); // the file store was never hit
    expect(existsSync(filePath)).toBe(false); // env keys are never written down
  });

  it("malformed env key is INVALID_INPUT", async () => {
    const custody = createCustody(env({ signingKey: "DEADBEEF", credentialsFile: join(tmpDir(), "c.enc") }));
    await expect(custody.resolveIdentityKey(PK)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("malformed owner env key is INVALID_INPUT", async () => {
    const custody = createCustody(env({ ownerKey: "nope", credentialsFile: join(tmpDir(), "c.enc") }));
    await expect(custody.resolveOwnerKey(PK)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("encrypted-file store", () => {
  it("round trips identity and owner keys through an encrypted file", async () => {
    const { custody, filePath } = fileStoreCustody(() => Promise.resolve("pass"));
    await custody.storeAgentKeys(identity);

    await expect(custody.resolveIdentityKey(PK)).resolves.toEqual({ key: PRIV, source: "encrypted-file" });
    await expect(custody.resolveOwnerKey(PK)).resolves.toEqual({ key: OWNER, source: "encrypted-file" });

    // strict owner-only permissions after the write.
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("wrong passphrase fails closed instead of wrong data", async () => {
    const filePath = join(tmpDir(), "credentials.enc");
    const store = createEncryptedFileStore(filePath, () => Promise.resolve("real pass"));
    await store.set(identityAccount(PK), PRIV);

    const badStore = createEncryptedFileStore(filePath, () => Promise.resolve("wrong pass"));
    await expect(badStore.get(identityAccount(PK))).rejects.toBeInstanceOf(EncryptedFileError);
  });

  it("tampered ciphertext fails closed", async () => {
    const filePath = join(tmpDir(), "credentials.enc");
    const store = createEncryptedFileStore(filePath, () => Promise.resolve("pass"));
    await store.set(identityAccount(PK), PRIV);

    // corrupt the base64 data payload inside the envelope.
    const raw = readFileSync(filePath, "utf8");
    const flipped = raw.replace(/"data":"([A-Za-z0-9+/=]+)"/, (_m, data: string) => {
      const head = data.length > 4 ? data.slice(0, data.length - 4) : data;
      return `"data":"${head}AAAA"`;
    });
    writeFileSync(filePath, flipped);

    await expect(store.get(identityAccount(PK))).rejects.toBeInstanceOf(EncryptedFileError);
  });

  it("loose permissions are a hard read failure (posix)", async (ctx) => {
    if (process.platform === "win32") ctx.skip(); // no posix modes on windows
    const filePath = join(tmpDir(), "credentials.enc");
    const store = createEncryptedFileStore(filePath, () => Promise.resolve("pass"));
    await store.set(identityAccount(PK), PRIV);
    chmodSync(filePath, 0o644);

    await expect(store.get(identityAccount(PK))).rejects.toBeInstanceOf(EncryptedFileError);
  });

  it("a missing file is a normal miss, not an error", async () => {
    const { custody } = fileStoreCustody(() => Promise.resolve("pass"));
    await expect(custody.resolveIdentityKey(PK)).resolves.toBeNull();
  });
});

describe("passphrase provider memoization", () => {
  it("prompts once per store even when set must decrypt then re-encrypt", async () => {
    const getPassphrase = vi.fn(async () => "pass");
    const { custody } = fileStoreCustody(getPassphrase);

    await custody.storeAgentKeys(identity); // fresh file: two entries, one prompt
    await custody.storeAgentKeys({ ...identity, publicKey: "11".repeat(32), privateKey: "22".repeat(32) }); // existing file: decrypt + encrypt per entry, still cached

    expect(getPassphrase).toHaveBeenCalledTimes(1); // the second store never re-prompts mid-set
  });
});

describe("fail-closed behavior", () => {
  it("a store that rejects writes produces STORAGE_WRITE_FAILED", async () => {
    const broken: KeyStore = {
      kind: "encrypted-file",
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
    };
    const custody = createCustody(env({ credentialsFile: join(tmpDir(), "c.enc") }), {
      stores: [broken],
      note: () => {},
    });
    await expect(custody.storeAgentKeys(identity)).rejects.toMatchObject({ code: "STORAGE_WRITE_FAILED" });
  });

  it("a store that throws on read is skipped loudly, not fatal", async () => {
    const broken: KeyStore = {
      kind: "encrypted-file",
      get: async () => {
        throw new EncryptedFileError("corrupt store");
      },
      set: async () => {},
    };
    const notes: string[] = [];
    const custody = createCustody(env({ credentialsFile: join(tmpDir(), "c.enc") }), {
      stores: [broken],
      note: (m) => notes.push(m),
    });
    await expect(custody.resolveIdentityKey(PK)).resolves.toBeNull();
    expect(notes.some((n) => n.includes("corrupt store"))).toBe(true);
  });

  it("both keys land in the same store, so an agent is never half-revocable", async () => {
    // first store accepts the identity key only; the pair must be retried in
    // the second store rather than split across stores.
    const splitBrain: KeyStore = {
      kind: "keychain",
      get: async () => null,
      set: async (account: string) => {
        if (account === identityAccount(PK)) return;
        throw new Error("reject owner key");
      },
    };
    const filePath = join(tmpDir(), "credentials.enc");
    const custody = createCustody(env({ credentialsFile: filePath }), {
      stores: [splitBrain, createEncryptedFileStore(filePath, () => Promise.resolve("pass"))],
      note: () => {},
    });
    await custody.storeAgentKeys(identity);
    await expect(custody.resolveIdentityKey(PK)).resolves.toEqual({ key: PRIV, source: "encrypted-file" });
    await expect(custody.resolveOwnerKey(PK)).resolves.toEqual({ key: OWNER, source: "encrypted-file" });
  });
});

describe("os keychain (darwin)", () => {
  it("get/set round trips against a throwaway keychain and the resolver walks it", async (ctx) => {
    if (process.platform !== "darwin") ctx.skip(); // `security` is a macos tool
    const dir = mkdtempSync(join(tmpdir(), "openrep-kc-"));
    tmpDirs.push(dir);
    const keychainPath = join(dir, "test.keychain-db");
    const { execFileSync } = await import("node:child_process");
    execFileSync("security", ["create-keychain", "-p", "testpass", keychainPath], { stdio: "ignore" });
    execFileSync("security", ["unlock-keychain", "-p", "testpass", keychainPath], { stdio: "ignore" });

    const kcStore = createKeychainStore({ keychainPath });
    await kcStore.set(identityAccount(PK), PRIV);
    await expect(kcStore.get(identityAccount(PK))).resolves.toBe(PRIV);
    await expect(kcStore.get(identityAccount(OWNER_PK))).resolves.toBeNull(); // normal miss, not an error

    // resolver prefers the keychain without emitting a downgrade notice.
    const notes: string[] = [];
    const filePath = join(dir, "credentials.enc");
    const custody = createCustody(env({ credentialsFile: filePath }), {
      stores: [kcStore, createEncryptedFileStore(filePath, () => Promise.resolve("pass"))],
      note: (m) => notes.push(m),
    });
    await expect(custody.resolveIdentityKey(PK)).resolves.toEqual({ key: PRIV, source: "keychain" });
    expect(notes).toHaveLength(0);
  });
});