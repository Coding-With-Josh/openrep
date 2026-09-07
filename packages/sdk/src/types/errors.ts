// error codes across the whole system. string literals so they can be
// matched exhaustively and serialized without a class hierarchy.
export type OpenRepErrorCode =
  | "AGENT_NOT_FOUND"
  | "INVALID_SIGNATURE"
  | "DUPLICATE_NAME"
  // a public key collision at insert is neither a retryable name conflict
  // nor a generic disk failure, so it gets its own distinct code. likewise a
  // registered source name collision. both are schema constraint failures
  // surfaced by the storage layer.
  | "DUPLICATE_PUBLIC_KEY"
  | "DUPLICATE_SOURCE_NAME"
  // idempotency conflict surfacing from the storage layer when the
  // composite (agent_id, idempotency_key) unique index fires during an
  // attest() insert. attest() resolves it by fetching and returning the
  // existing record instead of treating it as a generic storage failure.
  | "DUPLICATE_IDEMPOTENCY_KEY"
  // the signing key supplied to attest() is well formed but does not
  // correspond to the agentId it claims (deriving its public key yields a
  // different id). distinct from generic storage failure so callers can
  // tell a wrong key from a broken store. structurally malformed keys are
  // INVALID_INPUT, not KEY_MISMATCH.
  | "KEY_MISMATCH"
  // a non-native source value handed to attest() directly. external sources
  // belong to ingest(), this is the firm boundary between the two
  // functions, kept distinct from UNKNOWN_SOURCE which is ingest-domain.
  | "INVALID_SOURCE"
  // input exceeded the documented size limits (task, output, toolsUsed)
  // and was rejected before any hashing or signing work, per the limits
  // in the attestation module.
  | "INPUT_TOO_LARGE"
  | "UNKNOWN_SOURCE"
  | "MALFORMED_EXTERNAL_ATTESTATION"
  // ingest() ran the source adapter's optional validate() (or attempted to)
  // and the verdict was invalid, malformed, or the check threw. fail closed:
  // a throwing or garbled check is never treated as an unverified pass, and
  // nothing is persisted on this path.
  | "EXTERNAL_ATTESTATION_INVALID"
  | "MISSING_MASTER_KEY"
  // environment configuration failures from loadEnvConfig(). distinct codes
  // so a missing variable is never conflated with a malformed one, and a
  // stray secret (a token with no url) fails closed instead of silently
  // falling back to local mode and ignoring the token. messages always name
  // the variable involved and never echo its value.
  | "MISSING_TURSO_AUTH_TOKEN"
  | "MISSING_TURSO_DATABASE_URL"
  | "MISSING_DATABASE_PATH"
  | "INVALID_ENV"
  | "KEY_DECRYPTION_FAILED"
  | "SESSION_EXPIRED"
  | "RATE_LIMITED"
  | "INVALID_INPUT"
  | "NAME_GENERATION_EXHAUSTED"
  | "STORAGE_WRITE_FAILED"
  | "KEY_GENERATION_FAILED"
  // the revocation request did not prove possession of the agent's owner
  // key: bad signature shape, wrong signer, or an otherwise unverifiable
  // authorization. this is the code that makes third-party revocation fail.
  | "UNAUTHORIZED_REVOCATION"
  // the revocation request's timestamp falls outside the replay window, so
  // a captured old request can never be replayed later.
  | "STALE_REVOCATION_REQUEST"
  // the rotation request did not prove possession of the agent's owner key.
  // rotation authz mirrors revocation exactly, so a wrong signer (identity
  // key holder, unrelated key holder, attacker) fails here and nothing is
  // written.
  | "UNAUTHORIZED_ROTATION"
  // the rotation request's timestamp falls outside the same symmetric replay
  // window revocation uses, so a captured rotation request can never be
  // replayed later either.
  | "STALE_ROTATION_REQUEST"
  // the agent the caller is trying to act on has been revoked. attest()
  // refuses to sign for it before doing any crypto work.
  | "AGENT_REVOKED"
  // the agent row predates the owner-key model, so it has no owner public
  // key on record, and revocation fails closed: an unauthenticated path for
  // old data is never an option.
  | "OWNER_KEY_MISSING"
  // the wrapped agent run loop did not finish within MAX_TURNS turns.
  // distinct from a timeout because the provider responded fine, it just
  // kept requesting tools instead of producing a final answer.
  | "TURN_LIMIT_EXCEEDED"
  // the entire wrapped run exceeded MAX_RUN_MS of wall-clock time via the
  // AbortController. distinct from TURN_LIMIT_EXCEEDED because the provider
  // may simply be slow, not looping.
  | "RUN_TIMED_OUT"
  // the model named a tool that was not among the offered tool definitions
  // and executable implementations. this is a protocol violation, treated
  // as a hard error, never executed.
  | "UNREGISTERED_TOOL"
  // the model supplied tool-call arguments that did not conform to the
  // tool's declared inputSchema. the real implementation is never called
  // with unvalidated model-generated input.
  | "TOOL_ARGUMENT_INVALID"
  // the model provider call failed (network, rate limit, timeout,
  // malformed response) in a way that prevented the run from producing any
  // final output, so no attestation is produced.
  | "PROVIDER_API_FAILURE"
  // getScore() hit its hard cap on attestations processed in one call and
  // refused to return a truncated score. an explicit "too much history for
  // inline computation, needs a different strategy" error is honest; a wrong
  // number that looks right is the worst failure mode for a reputation
  // system.
  | "SCORE_COMPUTATION_LIMIT_EXCEEDED";

// a typed error value, the error half of Result<T>. plain data so it can
// cross module and package boundaries safely. never includes secrets or
// stack traces.
export interface OpenRepError {
  code: OpenRepErrorCode;
  message: string;
}

// the standard result shape for every function that can meaningfully fail.
// ok true carries a value, ok false carries a typed error. expected failure
// paths use this instead of uncaught thrown exceptions.
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: OpenRepError };

// small constructors so call sites never hand build the union. failure's
// generic defaults to never so `return failure("CODE", "msg")` type checks
// in any Result-returning function.
export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure<T = never>(code: OpenRepErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}

// outcome of a signature or integrity check. reason is populated when valid
// is false, null when the check passed.
export interface VerificationResult {
  valid: boolean;
  reason: string | null;
}