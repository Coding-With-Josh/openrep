// config loading tests. loadEnvConfig takes the env as a parameter so each
// test controls the whole surface without touching process.env. the secret
// marker values below are deliberately distinctive: every failure case
// asserts the marker never appears in the message, because a value inside
// an error string is a secret leak (the message must name the variable,
// never its value).
import { describe, expect, it } from "vitest";
import { loadEnvConfig } from "../src/index.js";

const MASTER_KEY = "test-master-key-leak-guard";
const TURSO_TOKEN = "test-turso-token-leak-guard";
const TURSO_URL = "libsql://openrep-josh-scriptz.aws-us-east-2.turso.io";

// the base of every valid local-mode env. tests override or delete keys
// from here rather than rebuilding the whole shape each time.
function localEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {
    OPENREP_MASTER_ENCRYPTION_KEY: MASTER_KEY,
    OPENREP_DB_PATH: "/tmp/openrep-config-test.db",
    OPENREP_RATE_LIMIT_WINDOW_MS: "60000",
    OPENREP_RATE_LIMIT_MAX_REQUESTS: "120",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

// the base of every valid hosted-mode env. dropping OPENREP_DB_PATH from
// localEnv models a real hosted deployment where no local db exists.
function tursoEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return localEnv({
    OPENREP_DB_PATH: undefined,
    TURSO_DATABASE_URL: TURSO_URL,
    TURSO_AUTH_TOKEN: TURSO_TOKEN,
    ...overrides,
  });
}

describe("loadEnvConfig: backend selection", () => {
  it("selects turso when TURSO_DATABASE_URL is set", () => {
    const result = loadEnvConfig(tursoEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.storageBackend).toBe("turso");
    expect(result.value.tursoDatabaseUrl).toBe(TURSO_URL);
    expect(result.value.tursoAuthToken).toBe(TURSO_TOKEN);
    expect(result.value.databasePath).toBeUndefined();
  });

  it("selects local when TURSO_DATABASE_URL is absent", () => {
    const result = loadEnvConfig(localEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.storageBackend).toBe("local");
    expect(result.value.databasePath).toBe("/tmp/openrep-config-test.db");
    expect(result.value.tursoDatabaseUrl).toBeUndefined();
    expect(result.value.tursoAuthToken).toBeUndefined();
  });

  it("honors :memory: as a valid local database path", () => {
    const result = loadEnvConfig(localEnv({ OPENREP_DB_PATH: ":memory:" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.storageBackend).toBe("local");
    expect(result.value.databasePath).toBe(":memory:");
  });

  it("passes optional api keys through and leaves them absent when unset", () => {
    const withKeys = loadEnvConfig(localEnv({ OPENREP_ANTHROPIC_API_KEY: "sk-ant", OPENREP_OPENAI_API_KEY: "sk-oai" }));
    expect(withKeys.ok).toBe(true);
    if (!withKeys.ok) return;
    expect(withKeys.value.anthropicApiKey).toBe("sk-ant");
    expect(withKeys.value.openaiApiKey).toBe("sk-oai");

    const withoutKeys = loadEnvConfig(localEnv());
    expect(withoutKeys.ok).toBe(true);
    if (!withoutKeys.ok) return;
    expect(withoutKeys.value.anthropicApiKey).toBeUndefined();
    expect(withoutKeys.value.openaiApiKey).toBeUndefined();
  });

  it("parses positive integer rate limits", () => {
    const result = loadEnvConfig(localEnv({ OPENREP_RATE_LIMIT_WINDOW_MS: "45000", OPENREP_RATE_LIMIT_MAX_REQUESTS: "7" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.rateLimitWindowMs).toBe(45000);
    expect(result.value.rateLimitMaxRequests).toBe(7);
  });
});

describe("loadEnvConfig: fail-closed hosted configuration", () => {
  it("fails with MISSING_TURSO_AUTH_TOKEN when the url is set but the token is missing", () => {
    const result = loadEnvConfig(tursoEnv({ TURSO_AUTH_TOKEN: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_TURSO_AUTH_TOKEN");
    expect(result.error.message).not.toContain(TURSO_TOKEN);
    expect(result.error.message).not.toContain(TURSO_URL);
  });

  it("fails with MISSING_TURSO_DATABASE_URL when a token is set with no url (stray secret never silently ignored)", () => {
    const result = loadEnvConfig(localEnv({ TURSO_AUTH_TOKEN: TURSO_TOKEN }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_TURSO_DATABASE_URL");
    expect(result.error.message).not.toContain(TURSO_TOKEN);
  });

  it("treats a whitespace-only token as missing", () => {
    const result = loadEnvConfig(tursoEnv({ TURSO_AUTH_TOKEN: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_TURSO_AUTH_TOKEN");
  });

  it("treats a whitespace-only url as absent, landing in local mode", () => {
    const result = loadEnvConfig(localEnv({ TURSO_DATABASE_URL: "   " }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.storageBackend).toBe("local");
  });
});

describe("loadEnvConfig: required local values", () => {
  it("fails with MISSING_MASTER_KEY when the master key is absent, in local mode", () => {
    const result = loadEnvConfig(localEnv({ OPENREP_MASTER_ENCRYPTION_KEY: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MASTER_KEY");
    expect(result.error.message).not.toContain(MASTER_KEY);
  });

  it("fails with MISSING_MASTER_KEY when the master key is absent, in turso mode", () => {
    const result = loadEnvConfig(tursoEnv({ OPENREP_MASTER_ENCRYPTION_KEY: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_MASTER_KEY");
  });

  it("fails with MISSING_DATABASE_PATH when local mode has no OPENREP_DB_PATH", () => {
    const result = loadEnvConfig(localEnv({ OPENREP_DB_PATH: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("MISSING_DATABASE_PATH");
  });

  it("fails with INVALID_ENV on missing rate limit variables", () => {
    const result = loadEnvConfig(localEnv({ OPENREP_RATE_LIMIT_WINDOW_MS: undefined }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_ENV");
  });

  it("fails with INVALID_ENV on non-numeric, zero, and negative rate limit values", () => {
    for (const bad of ["abc", "0", "-5", "1.5", " 12x "]) {
      const result = loadEnvConfig(localEnv({ OPENREP_RATE_LIMIT_MAX_REQUESTS: bad }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_ENV");
    }
  });
});

describe("loadEnvConfig: secret hygiene", () => {
  it("never echoes any secret value in any failure message", () => {
    const failingEnvs = [
      localEnv({ OPENREP_MASTER_ENCRYPTION_KEY: undefined }),
      localEnv({ OPENREP_DB_PATH: undefined }),
      localEnv({ TURSO_AUTH_TOKEN: TURSO_TOKEN }),
      tursoEnv({ TURSO_AUTH_TOKEN: undefined }),
      tursoEnv({ OPENREP_MASTER_ENCRYPTION_KEY: undefined }),
      localEnv({ OPENREP_RATE_LIMIT_WINDOW_MS: "nope" }),
    ];
    for (const env of failingEnvs) {
      const result = loadEnvConfig(env);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).not.toContain(MASTER_KEY);
      expect(result.error.message).not.toContain(TURSO_TOKEN);
      expect(result.error.message).not.toContain(TURSO_URL);
      expect(result.error.message).not.toContain("sk-ant");
    }
  });

  it("exposes exactly the typed config fields, never a raw env dump", () => {
    const result = loadEnvConfig(tursoEnv());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the config is a fixed closed shape: no passthrough field that would
    // carry arbitrary env values (including secrets) out of the loader by
    // accident.
    const keys = Object.keys(result.value).sort();
    expect(keys).toEqual([
      "anthropicApiKey",
      "masterEncryptionKey",
      "openaiApiKey",
      "rateLimitMaxRequests",
      "rateLimitWindowMs",
      "storageBackend",
      "tursoAuthToken",
      "tursoDatabaseUrl",
    ]);
  });
});