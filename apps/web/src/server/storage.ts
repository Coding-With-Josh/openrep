import {
  createLibsqlStorage,
  DurableSessionKeyStore,
  getSqliteStorage,
  type SessionKeyBackend,
  type StorageAdapter,
} from "@openrep/sdk";
import { getServerConfig } from "./config";

export interface RequestContext {
  storage: StorageAdapter & SessionKeyBackend;
  sessionKeys: DurableSessionKeyStore;
  close(): Promise<void>;
}

function codedError(code: string, message: string, cause: unknown): Error {
  const err = new Error(message, { cause });
  (err as { code?: string }).code = code;
  return err;
}

export async function createRequestContext(): Promise<RequestContext> {
  const config = getServerConfig();
  if (config.storageBackend === "local") {
    const storage = getSqliteStorage(config.databasePath as string);
    return {
      storage,
      sessionKeys: new DurableSessionKeyStore(storage, { windowMs: config.sessionWindowMs }),
      close: async () => undefined,
    };
  }
  let backend: Awaited<ReturnType<typeof createLibsqlStorage>>;
  try {
    backend = await createLibsqlStorage({
      url: config.tursoDatabaseUrl as string,
      authToken: config.tursoAuthToken,
    });
  } catch (err) {
    throw codedError("STORAGE_UNAVAILABLE", "the reputation ledger is temporarily unavailable", err);
  }
  return {
    storage: backend,
    sessionKeys: new DurableSessionKeyStore(backend, { windowMs: config.sessionWindowMs }),
    close: async () => {
      await backend.close();
    },
  };
}