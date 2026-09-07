// cli-level configuration, resolved by the cli itself from process.env.
// the cli does not wait on loadEnvConfig() in the sdk; it
// owns its environment contract.
//
// documented environment variables:
//   OPENREP_DB_PATH          path to the sqlite database file. default
//                            ~/.openrep/openrep.db (directory created if
//                            needed). ":memory:" is honored for tests and
//                            throwaway use.
//   OPENREP_SIGNING_KEY      64-char lowercase hex ed25519 identity private
//                            key, injected for a single invocation (headless/
//                            ci path).
//   OPENREP_OWNER_KEY        64-char lowercase hex ed25519 owner private key,
//                            injected for a single invocation (revoke in ci).
//   OPENREP_KEYCHAIN_PATH    alternate keychain database (macos). tests point
//                            this at a throwaway keychain so they never touch
//                            the developer's login keychain; power users can
//                            use a dedicated openrep keychain the same way.
//   OPENREP_CREDENTIALS_FILE path of the encrypted-file fallback store when
//                            OPENREP_ENCRYPTED_FILE_STORE is left to its
//                            default. tests point this at a temp file so the
//                            developer's real ~/.openrep/credentials.enc is
//                            never created or read.

import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CliEnv {
  dbPath: string;
  signingKey: string | undefined; // OPENREP_SIGNING_KEY
  ownerKey: string | undefined; // OPENREP_OWNER_KEY
  keychainPath: string | undefined; // OPENREP_KEYCHAIN_PATH
  credentialsFile: string | undefined; // OPENREP_CREDENTIALS_FILE
}

const DEFAULT_DB_DIR = ".openrep";
const DEFAULT_DB_FILE = "openrep.db";
const DEFAULT_CREDENTIALS_FILE = "credentials.enc";

export function openrepHomeDir(): string {
  return `${homedir()}/${DEFAULT_DB_DIR}`;
}

export function defaultDbPath(): string {
  return `${openrepHomeDir()}/${DEFAULT_DB_FILE}`;
}

export function defaultCredentialsFilePath(): string {
  return `${openrepHomeDir()}/${DEFAULT_CREDENTIALS_FILE}`;
}

export function resolveDbPath(env: NodeJS.ProcessEnv): string {
  const raw = env["OPENREP_DB_PATH"];
  return raw !== undefined && raw.length > 0 ? raw : defaultDbPath();
}

// ensure the parent directory of a file-backed database exists before the
// sqlite adapter tries to open it. ":memory:" has no parent to create.
export function ensureDbParent(dbPath: string): void {
  if (dbPath === ":memory:") return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

export function resolveEnv(env: NodeJS.ProcessEnv): CliEnv {
  return {
    dbPath: resolveDbPath(env),
    signingKey: env["OPENREP_SIGNING_KEY"],
    ownerKey: env["OPENREP_OWNER_KEY"],
    keychainPath: env["OPENREP_KEYCHAIN_PATH"],
    credentialsFile: env["OPENREP_CREDENTIALS_FILE"],
  };
}