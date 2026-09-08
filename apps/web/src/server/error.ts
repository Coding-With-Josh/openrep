import { NextResponse } from "next/server";

const SDK_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  INPUT_TOO_LARGE: 400,
  MISSING_SESSION: 403,
  SESSION_EXPIRED: 403,
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
  STORAGE_UNAVAILABLE: 503,
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
  } | null;
  const code = e !== null && typeof e.code === "string" ? e.code : "INTERNAL";
  const status = SDK_STATUS[code] ?? 500;
  const message = e !== null && typeof e.message === "string" && code in SDK_STATUS ? e.message : "internal server error";
  return jsonResponse({ error: { code, message } }, status);
}