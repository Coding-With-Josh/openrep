// custody resolver: turns a request for an agent's signing credentials into
// a concrete key, walking env -> os keychain -> encrypted file in precedence
// order, fail-closed at every step.
//
//   env:            OPENREP_SIGNING_KEY / OPENREP_OWNER_KEY, validated 64-char
//                   lowercase hex before anything touches a signature. used
//                   once per invocation, never persisted.
//   keychain:       the agent's own operating-system keychain, entries named
//                   <publicKey>.identity / <publicKey>.owner (types.ts).
//   encrypted file: ~/.openrep/credentials.enc fallback with a masked
//                   passphrase prompt and 0600 enforcement.
//
// a store that throws (keychain tool missing, file corrupt) is skipped loudly
// with a stderr notice: the resolver is allowed to downgrade to a weaker
// store, but never silently, and never to nothing. keys that fail shape
// validation are a hard error, not a fall-through, because a malformed stored
// key means the store itself is damaged.

import { mkdirSync } from "node:fs";
import type { AgentIdentity } from "@openrepso/sdk";

import { defaultCredentialsFilePath, isProviderApiKey, openrepHomeDir, type CliEnv } from "../config.js";
import { isEd25519PrivateKeyHex } from "../hex.js";
import { createEncryptedFileStore } from "./encrypted-file.js";
import { createKeychainStore } from "./keychain.js";
import { readPassphraseFromTerminal } from "./passphrase.js";
import { apiKeyAccount, CustodyError, identityAccount, ownerAccount, type KeyStore } from "./types.js";

export interface CustodyResolution {
  key: string;
  source: "env" | "keychain" | "encrypted-file";
}

export interface Custody {
  // resolve the identity signing key for an agent, or null when no source
  // holds one. throws CustodyError only on hard failures (malformed key).
  resolveIdentityKey(publicKey: string): Promise<CustodyResolution | null>;
  // resolve the owner key for an agent (used by `openrep revoke`).
  resolveOwnerKey(publicKey: string): Promise<CustodyResolution | null>;
  // resolve the provider api key for a provider by walking the stores in
  // precedence order, or null when no store holds one. the caller owns env
  // precedence (OPENREP_AGENT_API_KEY wins over a stored key), exactly like
  // resolveIdentityKey defers the env check to this resolver's own env walk.
  resolveApiKey(provider: string): Promise<CustodyResolution | null>;
  // persist a provider api key (the chat screen's "save key" path). the key
  // is shape-validated before any store sees it. throws CustodyError when no
  // store accepts it, so a caller can never believe a key was persisted that
  // was not.
  storeApiKey(provider: string, apiKey: string): Promise<void>;
  // persist the freshly generated identity + owner keys for a new agent.
  // both keys land in the same store so a successful create never leaves an
  // agent half-revocable; throws CustodyError when no store accepts them.
  storeAgentKeys(identity: AgentIdentity): Promise<void>;
}

export interface CustodyOptions {
  // store list to walk in precedence order (tests inject a temp keychain
  // and/or temp encrypted file here; default is the real chain).
  stores?: KeyStore[];
  // passphrase provider instead of the default masked tty prompt.
  getPassphrase?: () => Promise<string>;
  // notice sink for loud downgrades; defaults to stderr.
  note?: (message: string) => void;
}

type KeyKind = "identity" | "owner";

function accountFor(kind: KeyKind, publicKey: string): string {
  return kind === "identity" ? identityAccount(publicKey) : ownerAccount(publicKey);
}

function envVarFor(kind: KeyKind): string {
  return kind === "identity" ? "OPENREP_SIGNING_KEY" : "OPENREP_OWNER_KEY";
}

export function createCustody(env: CliEnv, options: CustodyOptions = {}): Custody {
  const filePath = env.credentialsFile ?? defaultCredentialsFilePath();
  // the default prompt fails closed when stdin is not a tty. the encrypted
  // file store itself memoizes the provider, so the user is prompted exactly
  // once per invocation even when a set must decrypt then re-encrypt.
  const getPassphrase = options.getPassphrase ?? makeDefaultPassphraseProvider(filePath);
  const stores = options.stores ?? buildDefaultStores(env, getPassphrase);
  const note = options.note ?? ((message: string) => console.error(`note: ${message}`));

  async function resolveKey(kind: KeyKind, publicKey: string): Promise<CustodyResolution | null> {
    const envValue = kind === "identity" ? env.signingKey : env.ownerKey;
    if (envValue !== undefined) {
      if (!isEd25519PrivateKeyHex(envValue)) {
        throw new CustodyError(
          "INVALID_INPUT",
          `${envVarFor(kind)} must be a 64-char lowercase hex ed25519 private key`,
        );
      }
      note(`using ${envVarFor(kind)} for this invocation (not persisted)`);
      return { key: envValue, source: "env" };
    }

    const account = accountFor(kind, publicKey);
    for (const store of stores) {
      let secret: string | null;
      try {
        secret = await store.get(account);
      } catch (err) {
        // the store itself is broken (tool missing, file corrupt): fall
        // through loudly, never pretend the key was absent.
        note(`${store.kind} unavailable: ${(err as Error).message}`);
        continue;
      }
      if (secret === null) continue;
      if (!isEd25519PrivateKeyHex(secret)) {
        throw new CustodyError(
          "INVALID_INPUT",
          `stored key for ${account} in ${store.kind} is not a valid 64-char lowercase hex ed25519 private key`,
        );
      }
      if (store.kind === "encrypted-file") note("using identity key from encrypted file fallback");
      return { key: secret, source: store.kind };
    }
    return null;
  }

  async function storeBoth(entries: Array<{ account: string; secret: string; label: string }>): Promise<void> {
    for (const store of stores) {
      let allOk = true;
      for (const entry of entries) {
        try {
          await store.set(entry.account, entry.secret);
        } catch (err) {
          note(`could not store the ${entry.label} in ${store.kind}: ${(err as Error).message}`);
          allOk = false;
          break;
        }
      }
      if (allOk) return;
    }
    throw new CustodyError(
      "STORAGE_WRITE_FAILED",
      "no key store accepted the generated keys; they exist only in this process and are NOT recoverable",
    );
  }

  async function resolveApiKey(provider: string): Promise<CustodyResolution | null> {
    const account = apiKeyAccount(provider);
    for (const store of stores) {
      let secret: string | null;
      try {
        secret = await store.get(account);
      } catch (err) {
        note(`${store.kind} unavailable: ${(err as Error).message}`);
        continue;
      }
      if (secret === null) continue;
      if (!isProviderApiKey(secret)) {
        throw new CustodyError(
          "INVALID_INPUT",
          `stored api key for ${account} in ${store.kind} is not a valid provider api key`,
        );
      }
      if (store.kind === "encrypted-file") note("using provider api key from encrypted file fallback");
      return { key: secret, source: store.kind };
    }
    return null;
  }

  async function storeApiKey(provider: string, apiKey: string): Promise<void> {
    // shape validation is the caller's contract with the secret: a key that
    // fails the shape check never reaches a store, so a damaged store can
    // never be created out of a paste-bomb.
    if (!isProviderApiKey(apiKey)) {
      throw new CustodyError("INVALID_INPUT", "provider api key must be non-empty and at most 512 chars");
    }
    const account = apiKeyAccount(provider);
    for (const store of stores) {
      try {
        await store.set(account, apiKey);
        return;
      } catch (err) {
        note(`could not store the provider api key in ${store.kind}: ${(err as Error).message}`);
      }
    }
    throw new CustodyError(
      "STORAGE_WRITE_FAILED",
      "no key store accepted the provider api key; it was NOT saved",
    );
  }

  return {
    resolveIdentityKey: (publicKey) => resolveKey("identity", publicKey),
    resolveOwnerKey: (publicKey) => resolveKey("owner", publicKey),
    resolveApiKey,
    storeApiKey,
    async storeAgentKeys(identity) {
      // ensure the fallback store's parent exists before any store writes;
      // harmless when the keychain wins the race.
      mkdirSync(openrepHomeDir(), { recursive: true });
      await storeBoth([
        { account: identityAccount(identity.publicKey), secret: identity.privateKey, label: "identity key" },
        { account: ownerAccount(identity.publicKey), secret: identity.ownerPrivateKey, label: "owner key" },
      ]);
    },
  };
}

function buildDefaultStores(env: CliEnv, getPassphrase: () => Promise<string>): KeyStore[] {
  return [
    createKeychainStore({ keychainPath: env.keychainPath }),
    createEncryptedFileStore(env.credentialsFile ?? defaultCredentialsFilePath(), getPassphrase),
  ];
}

function makeDefaultPassphraseProvider(filePath: string): () => Promise<string> {
  return async () => {
    if (!process.stdin.isTTY) {
      throw new CustodyError(
        "KEYCHAIN_UNAVAILABLE",
        `no tty to prompt for the encrypted-file passphrase (${filePath}); use OPENREP_SIGNING_KEY / OPENREP_OWNER_KEY instead`,
      );
    }
    return readPassphraseFromTerminal(`passphrase for ${filePath}: `);
  };
}