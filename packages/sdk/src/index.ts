// core types, domain split. package consumers import types from this single
// entry point. relative specifiers carry explicit .js extensions so the
// emitted esm output resolves at runtime in node, not just at build time.
export * from "./types/identity.js";
export * from "./types/security.js";
export * from "./types/attestation.js";
export * from "./types/sources.js";
export * from "./types/score.js";
export * from "./types/storage.js";
export * from "./types/errors.js";
export * from "./types/providers.js";
export * from "./types/api.js";
export * from "./types/activity.js";
export * from "./types/config.js";

// operations
export {
  createAgent,
  wrapAgent,
  verifyManifest,
  MANIFEST_VERSION,
  NAME_GENERATION_MAX_ATTEMPTS,
  DEFAULT_PERMISSIONS,
} from "./agent.js";
export type { CreateAgentOptions, ManifestFields } from "./agent.js";
export { canonicalize, MAX_CANONICAL_DEPTH } from "./canonical.js";
export { ADJECTIVES, NOUNS, COLORS, generateName } from "./names.js";
export { attest, verifyAttestation, ATTESTATION_SCHEMA_VERSION, ingest } from "./attestation.js";
export { revokeAgent, REVOCATION_REQUEST_MAX_AGE_MS } from "./revocation.js";
export { createSqliteStorage, getSqliteStorage } from "./storage/sqlite.js";
export { createLibsqlStorage, LibsqlStorageAdapter, type LibsqlStorageConfig } from "./storage/libsql.js";
export { createProviderClient } from "./providers/index.js";
export { AnthropicClient } from "./providers/anthropic.js";
export { OpenAiClient, OpenAiCompatibleClient } from "./providers/openai.js";
export { GeminiClient } from "./providers/gemini.js";
export { ProviderApiError, ProviderConfigError, isAbortError } from "./providers/errors.js";
export { validateAgainstSchema } from "./providers/validate.js";
export { runAgentLoop, MAX_TURNS, MAX_RUN_MS } from "./run-loop.js";
export { ATTESTATION_LIMITS } from "./attestation.js";
export { getScore, SCORE_MAX_ATTESTATIONS, SCORE_PAGE_LIMIT } from "./score.js";
export type { GetScoreOptions } from "./score.js";
export { resolve } from "./resolve.js";