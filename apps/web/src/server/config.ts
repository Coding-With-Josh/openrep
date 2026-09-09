import { loadEnvConfig, type EnvConfig } from "@openrepso/sdk";

const DEFAULT_SESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ServerConfig extends EnvConfig {
  sessionWindowMs: number;
  groqApiKey: string | null;
  googleClientId: string | null;
  googleClientSecret: string | null;
  isProduction: boolean;
}

let cached: ServerConfig | null = null;

function nullableEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function positiveIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function codedError(code: string, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}

export function getServerConfig(): ServerConfig {
  if (cached) return cached;
  const envResult = loadEnvConfig();
  if (!envResult.ok) {
    throw codedError(envResult.error.code, envResult.error.message);
  }
  const base = envResult.value;
  const rawWindow = process.env.OPENREP_SESSION_WINDOW_MS;
  let sessionWindowMs = DEFAULT_SESSION_WINDOW_MS;
  if (rawWindow !== undefined && rawWindow.trim().length > 0) {
    const parsed = positiveIntOrNull(rawWindow);
    if (parsed === null) {
      throw codedError("INVALID_ENV", "OPENREP_SESSION_WINDOW_MS must be a positive integer");
    }
    sessionWindowMs = parsed;
  }
  const groqKey = process.env.OPENREP_GROQ_API_KEY;
  const groqApiKey = groqKey === undefined ? null : groqKey.trim().length > 0 ? groqKey.trim() : null;
  const googleClientId = nullableEnv("GOOGLE_CLIENT_ID");
  const googleClientSecret = nullableEnv("GOOGLE_CLIENT_SECRET");
  if (googleClientId === null !== (googleClientSecret === null)) {
    throw codedError(
      "INVALID_ENV",
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together (or both omitted)",
    );
  }
  cached = {
    ...base,
    sessionWindowMs,
    groqApiKey,
    googleClientId,
    googleClientSecret,
    isProduction: process.env.NODE_ENV === "production",
  };
  return cached;
}