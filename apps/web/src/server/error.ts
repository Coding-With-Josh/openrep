import { NextResponse } from "next/server";

const SDK_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  INPUT_TOO_LARGE: 400,
  INVALID_SIGNATURE: 400,
  KEY_MISMATCH: 400,
  INVALID_SOURCE: 400,
  UNKNOWN_SOURCE: 400,
  MALFORMED_EXTERNAL_ATTESTATION: 400,
  EXTERNAL_ATTESTATION_INVALID: 400,
  STALE_REVOCATION_REQUEST: 400,
  STALE_ROTATION_REQUEST: 400,
  MISSING_SESSION: 403,
  SESSION_EXPIRED: 403,
  UNAUTHORIZED_REVOCATION: 403,
  UNAUTHORIZED_ROTATION: 403,
  AGENT_REVOKED: 403,
  OWNER_KEY_MISSING: 403,
  RATE_LIMITED: 429,
  AGENT_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  DUPLICATE_NAME: 409,
  DUPLICATE_EMAIL: 409,
  DUPLICATE_ACCOUNT: 409,
  DUPLICATE_PUBLIC_KEY: 409,
  DUPLICATE_SOURCE_NAME: 409,
  DUPLICATE_IDEMPOTENCY_KEY: 409,
  CHAT_SESSION_NOT_FOUND: 409,
  MISSING_MASTER_KEY: 500,
  MISSING_GROQ_API_KEY: 500,
  MISSING_TURSO_DATABASE_URL: 500,
  MISSING_TURSO_AUTH_TOKEN: 500,
  MISSING_DATABASE_PATH: 500,
  INVALID_ENV: 500,
  KEY_DECRYPTION_FAILED: 500,
  KEY_GENERATION_FAILED: 500,
  NAME_GENERATION_EXHAUSTED: 500,
  SCORE_COMPUTATION_LIMIT_EXCEEDED: 500,
  STORAGE_UNAVAILABLE: 503,
  STORAGE_WRITE_FAILED: 503,
  PROVIDER_API_FAILURE: 502,
  UNREGISTERED_TOOL: 502,
  TOOL_ARGUMENT_INVALID: 502,
  TURN_LIMIT_EXCEEDED: 502,
  RUN_TIMED_OUT: 504,
};

export function jsonResponse(body: unknown, status: number): NextResponse {
  const response = NextResponse.json(body, { status });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export function errorResponse(err: unknown): NextResponse {
  const e = (typeof err === "object" && err !== null ? err : null) as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    retryAfterSeconds?: unknown;
  } | null;
  const code = e !== null && typeof e.code === "string" ? e.code : "INTERNAL";
  if (err instanceof Error) {
    console.error(`[openrep] error response ${code}:`, err);
  } else {
    console.error(`[openrep] error response ${code}:`, e);
  }
  const status =
    e !== null &&
    code === "PROVIDER_API_FAILURE" &&
    e.status === 429
      ? 429
      : (SDK_STATUS[code] ?? 500);
  let message = e !== null && typeof e.message === "string" && code in SDK_STATUS ? e.message : "internal server error";
  if (status === 429 && code === "PROVIDER_API_FAILURE") {
    message = "the model provider is rate limiting requests right now; wait a moment and try again";
  }
  const response = jsonResponse({ error: { code, message } }, status);
  if (status === 429) {
    const retryAfter = e !== null && typeof e.retryAfterSeconds === "number" ? e.retryAfterSeconds : 5;
    response.headers.set("Retry-After", String(retryAfter));
  }
  return response;
}