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
//
// interactive session only (openrep with no subcommand):
//   OPENREP_AGENT_API_KEY    provider api key for the chat screen. when
//                            absent the tui still works (dashboard, score,
//                            verify, revoke) and chat fails closed with a
//                            clear message instead of guessing a key source.
//   OPENREP_AGENT_BASE_URL   openai-compatible chat-completions endpoint.
//                            default https://api.groq.com/openai/v1 (groq
//                            hosts openai/gpt-oss-20b). the sdk never guesses
//                            this: a custom endpoint must be named here.
//   OPENREP_AGENT_MODEL      model id sent as the model field. default
//                            openai/gpt-oss-20b.
//   OPENREP_AGENT_LABEL      display label for the model row on the splash
//                            screen. default "groq". cosmetic only.

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { bytesToHex } from "./hex.js";

export interface CliEnv {
  dbPath: string;
  signingKey: string | undefined; // OPENREP_SIGNING_KEY
  ownerKey: string | undefined; // OPENREP_OWNER_KEY
  keychainPath: string | undefined; // OPENREP_KEYCHAIN_PATH
  credentialsFile: string | undefined; // OPENREP_CREDENTIALS_FILE
}

// provider contract for the interactive chat screen. derived from env with
// explicit defaults that match the documented groq endpoint: the openai-
// compatible client needs a real base url to point an api key at, so the
// default names groq out loud and a custom endpoint must be configured.
export interface AgentProviderConfig {
  apiKey: string | undefined; // OPENREP_AGENT_API_KEY
  baseUrl: string; // OPENREP_AGENT_BASE_URL, default groq endpoint
  model: string; // OPENREP_AGENT_MODEL, default openai/gpt-oss-20b
  label: string; // OPENREP_AGENT_LABEL, default groq
}

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const DEFAULT_LABEL = "groq";

export function resolveAgentProvider(env: NodeJS.ProcessEnv): AgentProviderConfig {
  const rawUrl = env["OPENREP_AGENT_BASE_URL"];
  const rawModel = env["OPENREP_AGENT_MODEL"];
  const rawLabel = env["OPENREP_AGENT_LABEL"];
  return {
    apiKey: env["OPENREP_AGENT_API_KEY"],
    baseUrl: rawUrl !== undefined && rawUrl.trim().length > 0 ? rawUrl.trim() : DEFAULT_BASE_URL,
    model: rawModel !== undefined && rawModel.trim().length > 0 ? rawModel.trim() : DEFAULT_MODEL,
    label: rawLabel !== undefined && rawLabel.trim().length > 0 ? rawLabel.trim() : DEFAULT_LABEL,
  };
}

// a short, random session id for the interactive invocation, displayed as
// "session a3f...19c (guest)". display identity only: it is never used as an
// ownership handle anywhere (the sdk scopes chat by the (agent, owner) pair).
export function newSessionId(): string {
  const hex = bytesToHex(randomBytes(4));
  return `${hex.slice(0, 3)}...${hex.slice(-3)}`;
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