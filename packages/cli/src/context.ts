// wiring context: one storage connection + one custody resolver per cli
// invocation, built from the resolved environment.

import { createSqliteStorage, type StorageAdapter } from "@openrepso/sdk";

import { ensureDbParent, resolveEnv, type CliEnv } from "./config.js";
import { createCustody, type Custody } from "./custody/index.js";

export interface CliContext {
  env: CliEnv;
  storage: StorageAdapter;
  custody: Custody;
}

// overrides let in-process tests inject real-but-isolated stores (a temp
// encrypted file, a temp keychain) without touching the developer's machine.
// when overrides.env is present it REPLACES the resolved environment entirely,
// so a developer's OPENREP_SIGNING_KEY can never leak into a test run.
export function buildContext(env: NodeJS.ProcessEnv, overrides: Partial<CliContext> = {}): CliContext {
  const cliEnv = overrides.env ?? resolveEnv(env);
  ensureDbParent(cliEnv.dbPath);
  let storage = overrides.storage;
  if (storage === undefined) storage = createSqliteStorage(cliEnv.dbPath);
  let custody = overrides.custody;
  if (custody === undefined) custody = createCustody(cliEnv);
  return { env: cliEnv, storage, custody };
}