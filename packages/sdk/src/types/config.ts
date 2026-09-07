import type { Result } from "./errors";
import { failure, ok } from "./errors";

// which storage backend boots with. explicit discriminator field so
// downstream code never infers the backend by checking which url field is
// present (that inference drifts when a field is later added or renamed).
export type StorageBackend = "local" | "turso";

// typed shape of every required environment variable. loaded once at boot
// and read server side only, never sent to the browser. the rules:
// - a missing required variable is a typed failure, never an undefined
//   value in the returned config and never a thrown generic error.
// - failure messages may name the variable but must never echo its value:
//   a token or key that ends up inside a log line is a secret leak.
// - hosted mode is chosen by TURSO_DATABASE_URL being set; any partial
//   hosted configuration (url without token, token without url) fails
//   loudly rather than silently picking a backend.
export interface EnvConfig {
  storageBackend: StorageBackend;
  anthropicApiKey?: string; // required only when using the anthropic provider
  openaiApiKey?: string; // required only when using the openai provider
  masterEncryptionKey: string; // required, from env, see security.ts
  // local sqlite file location, required and meaningful only when
  // storageBackend is "local". ":memory:" is honored for tests.
  databasePath?: string;
  // hosted libsql connection, both required when storageBackend is "turso".
  // the auth token is held only in this in-memory config, never logged,
  // never serialized into any error, never sent outside the server.
  tursoDatabaseUrl?: string;
  tursoAuthToken?: string;
  rateLimitWindowMs: number; // abuse prevention, see security.ts
  rateLimitMaxRequests: number;
}

// loads and validates env config. fails loudly with a typed result if any
// required variable is missing or malformed, never proceeds with undefined
// values and never throws.
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): Result<EnvConfig> {
  const tursoDatabaseUrl = trimOrUndefined(env.TURSO_DATABASE_URL);
  const tursoAuthToken = trimOrUndefined(env.TURSO_AUTH_TOKEN);

  // fail closed on a stray token: a token with no url would otherwise be
  // silently ignored while local mode boots. a misplaced secret must not
  // change backend selection by accident, and it must not be dropped on
  // the floor without anyone noticing (see MISSING_TURSO_DATABASE_URL).
  if (tursoAuthToken !== undefined && tursoDatabaseUrl === undefined) {
    return failure("MISSING_TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN is set but TURSO_DATABASE_URL is missing; refusing to guess the storage backend");
  }

  const storageBackend: StorageBackend = tursoDatabaseUrl !== undefined ? "turso" : "local";

  // the master key is required in both modes: session keys are envelope
  // encrypted with it regardless of which store holds the encrypted
  // records. presence check only, the value itself is a separate concern
  // of getMasterKey() and is never part of any failure message.
  const masterEncryptionKey = trimOrUndefined(env.OPENREP_MASTER_ENCRYPTION_KEY);
  if (masterEncryptionKey === undefined) {
    return failure("MISSING_MASTER_KEY", "OPENREP_MASTER_ENCRYPTION_KEY is required");
  }

  // rate limits are parsed here so a typo (non-numeric, zero, negative)
  // surfaces at boot as INVALID_ENV instead of silently disabling or
  // corrupting abuse prevention later.
  const rateLimitWindowMs = parsePositiveInt(env.OPENREP_RATE_LIMIT_WINDOW_MS);
  if (rateLimitWindowMs === null) {
    return failure("INVALID_ENV", "OPENREP_RATE_LIMIT_WINDOW_MS must be a positive integer");
  }
  const rateLimitMaxRequests = parsePositiveInt(env.OPENREP_RATE_LIMIT_MAX_REQUESTS);
  if (rateLimitMaxRequests === null) {
    return failure("INVALID_ENV", "OPENREP_RATE_LIMIT_MAX_REQUESTS must be a positive integer");
  }

  const anthropicApiKey = trimOrUndefined(env.OPENREP_ANTHROPIC_API_KEY);
  const openaiApiKey = trimOrUndefined(env.OPENREP_OPENAI_API_KEY);

  if (storageBackend === "turso") {
    // hosted mode requires the token: a url without a token would construct
    // a client that fails later with a confusing remote error instead of a
    // clear boot-time failure.
    if (tursoAuthToken === undefined) {
      return failure(
        "MISSING_TURSO_AUTH_TOKEN",
        "TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is missing; hosted mode cannot authenticate",
      );
    }
    return ok({
      storageBackend,
      anthropicApiKey,
      openaiApiKey,
      masterEncryptionKey,
      tursoDatabaseUrl,
      tursoAuthToken,
      rateLimitWindowMs,
      rateLimitMaxRequests,
    });
  }

  // local mode requires an explicit path. the sdk does not guess a default:
  // the cli owns the ~/.openrep/openrep.db convention and passes it down.
  const databasePath = trimOrUndefined(env.OPENREP_DB_PATH);
  if (databasePath === undefined) {
    return failure("MISSING_DATABASE_PATH", "OPENREP_DB_PATH is required when TURSO_DATABASE_URL is not set");
  }
  return ok({
    storageBackend,
    anthropicApiKey,
    openaiApiKey,
    masterEncryptionKey,
    databasePath,
    rateLimitWindowMs,
    rateLimitMaxRequests,
  });
}

// empty and whitespace-only values are treated as unset: a token of " "
// would otherwise pass a naive presence check and only fail later, at the
// remote database, with a confusing authentication error.
function trimOrUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// strict positive integer parse for env-provided numbers. NaN, decimals,
// zero, negatives, and missing all return null (caller maps to INVALID_ENV).
function parsePositiveInt(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}