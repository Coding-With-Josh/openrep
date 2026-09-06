import type { Result } from "./errors";

// typed shape of every required environment variable. loaded once at boot
// and read server side only, never sent to the browser.
export interface EnvConfig {
  anthropicApiKey?: string; // required only when using the anthropic provider
  openaiApiKey?: string; // required only when using the openai provider
  masterEncryptionKey: string; // required, from env, see security.ts
  databasePath: string; // sqlite file location, from env
  rateLimitWindowMs: number; // abuse prevention, see security.ts
  rateLimitMaxRequests: number;
}

// loads and validates env config. fails loudly with a typed result if any
// required variable is missing, never proceeds with undefined values.
export function loadEnvConfig(): Result<EnvConfig> {
  // TODO: read env, validate required fields, return typed result
  throw new Error("Not implemented yet");
}