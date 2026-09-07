// win32 credential manager store tests, driven through an injected executor
// so no real powershell.exe is spawned and no windows machine is required
// (there is not one in this dev loop). everything here runs on any platform
// by temporarily redefining process.platform to "win32" inside the tests and
// restoring it after each one. real-device verification on actual windows
// hardware remains a manual requirement, stated in the final report.

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCustody } from "../src/custody/index.js";
import { createKeychainStore, KeychainUnavailableError } from "../src/custody/keychain.js";
import { identityAccount, ownerAccount } from "../src/custody/types.js";
import type { CliEnv } from "../src/config.js";

// any structurally valid 32-byte key; custody never signs, only stores.
const PRIV = "ab".repeat(32);
const OWNER = "12".repeat(32);
const PK = "cd".repeat(32);
const OWNER_PK = "34".repeat(32);

// force the win32 dispatch inside createKeychainStore without a windows box.
const REAL_PLATFORM = process.platform;
function platform(platformName: string): void {
  Object.defineProperty(process, "platform", { value: platformName, configurable: true });
}
afterEach(() => {
  platform(REAL_PLATFORM);
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

function decodeScriptArg(args: string[]): string {
  const i = args.indexOf("-EncodedCommand");
  if (i < 0 || i + 1 >= args.length) throw new Error("executor was not called with -EncodedCommand");
  return Buffer.from(args[i + 1], "base64").toString("utf16le");
}

function pwshArgs(args: string[]): string[] {
  // the five fixed flags before the -EncodedCommand payload.
  return args.slice(0, 5);
}

describe("win32 credential manager store (mocked powershell)", () => {
  it("set passes the secret over stdin and never in argv", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await store.set(identityAccount(PK), PRIV);

    expect(executor).toHaveBeenCalledTimes(1);
    const [bin, args, input] = executor.mock.calls[0] as unknown as [string, string[], string | undefined];
    expect(bin).toBe("powershell.exe");
    expect(pwshArgs(args)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    expect(input).toBe(PRIV); // the secret rides stdin, nothing else
    expect(args.join(" ")).not.toContain(PRIV); // never in argv (IV2)
    expect(decodeScriptArg(args)).toContain(`openrep/${identityAccount(PK)}`);
  });

  it("the inline snippet declares CredWrite, CredRead and CredDelete", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await store.set(identityAccount(PK), PRIV);

    const script = decodeScriptArg(executor.mock.calls[0][1] as string[]);
    expect(script).toContain("CredWrite");
    expect(script).toContain("CredRead");
    expect(script).toContain("CredDelete");
  });

  it("get returns the secret printed to stdout", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: `${PRIV}\n`, exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await expect(store.get(identityAccount(PK))).resolves.toBe(PRIV);

    const [bin, args, input] = executor.mock.calls[0] as unknown as [string, string[], string | undefined];
    expect(bin).toBe("powershell.exe");
    expect(input).toBeUndefined(); // reads never send anything on stdin
    expect(args.join(" ")).not.toContain(PRIV);
  });

  it("tolerates a utf-8 bom and crlf from the powershell child", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: `\uFEFF${PRIV}\r\n`, exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await expect(store.get(identityAccount(PK))).resolves.toBe(PRIV);
  });

  it("maps the not-found marker to a normal miss, not an error", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "NOT_FOUND\n", exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await expect(store.get(identityAccount(PK))).resolves.toBeNull();
  });

  it("identity and owner accounts are distinct credential targets", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await store.set(ownerAccount(PK), OWNER);
    await store.set(identityAccount(PK), PRIV);

    const targets = executor.mock.calls.map(([, args]) => decodeScriptArg(args as string[]));
    expect(targets[0]).toContain(`openrep/${ownerAccount(PK)}`);
    expect(targets[1]).toContain(`openrep/${identityAccount(PK)}`);
    expect(new Set(targets).size).toBe(2);
  });

  it("a malformed account name is refused before the child process", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await expect(store.get("openrep/../../boom")).rejects.toBeInstanceOf(KeychainUnavailableError);
    await expect(store.get(`${"CD".repeat(32)}.identity`)).rejects.toBeInstanceOf(KeychainUnavailableError); // upcase hex
    await expect(store.set("deadbeef", PRIV)).rejects.toBeInstanceOf(KeychainUnavailableError);
    expect(executor).not.toHaveBeenCalled(); // fail closed before any spawn (IV1)
  });

  it("a non-zero exit code is unavailable, not a miss", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 1 }));
    const store = createKeychainStore({ executor });

    await expect(store.get(identityAccount(PK))).rejects.toBeInstanceOf(KeychainUnavailableError);
  });

  it("a spawned-process failure (missing powershell) is unavailable", async () => {
    platform("win32");
    const executor = vi.fn(async () => {
      throw Object.assign(new Error("spawn powershell.exe ENOENT"), { exitCode: null });
    });
    const store = createKeychainStore({ executor });

    await expect(store.get(identityAccount(PK))).rejects.toBeInstanceOf(KeychainUnavailableError);
  });

  it("an empty response is a loud failure, never an empty key or a miss", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 0 }));
    const store = createKeychainStore({ executor });

    await expect(store.get(identityAccount(PK))).rejects.toBeInstanceOf(KeychainUnavailableError);
  });
});

describe("win32 store through the custody resolver", () => {
  it("walks the win32 store without a downgrade notice", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: `${PRIV}\n`, exitCode: 0 }));
    const notes: string[] = [];
    const custody = createCustody(env(), {
      stores: [
        createKeychainStore({ executor }),
        { kind: "encrypted-file", get: async () => null, set: async () => {} },
      ],
      getPassphrase: async () => "pass",
      note: (m) => notes.push(m),
    });

    await expect(custody.resolveIdentityKey(PK)).resolves.toEqual({ key: PRIV, source: "keychain" });
    expect(notes).toHaveLength(0);
  });

  it("a broken win32 store falls through loudly to the next store", async () => {
    platform("win32");
    const executor = vi.fn(async () => ({ stdout: "", exitCode: 1 }));
    const notes: string[] = [];
    const fileStore = { kind: "encrypted-file" as const, get: async () => OWNER, set: async () => {} };
    const custody = createCustody(env(), {
      stores: [createKeychainStore({ executor }), fileStore],
      getPassphrase: async () => "pass",
      note: (m) => notes.push(m),
    });

    await expect(custody.resolveOwnerKey(PK)).resolves.toEqual({ key: OWNER, source: "encrypted-file" });
    expect(notes.some((n) => n.includes("windows credential manager"))).toBe(true);
  });
});