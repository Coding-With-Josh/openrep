import { NextRequest } from "next/server";
import { jsonResponse } from "./error";
import { auth } from "./auth";
import { readCookie, SESSION_COOKIE, verifySessionToken } from "./session";

export interface EffectiveSession {
  userId: string;
  kind: "account" | "guest";
}

export async function requireSession(
  request: NextRequest,
): Promise<{ session: EffectiveSession } | { response: Response }> {
  const account = await auth();
  if (account?.user?.id) {
    return { session: { userId: account.user.id, kind: "account" } };
  }
  const header = request.headers.get("cookie");
  const guest = verifySessionToken(readCookie(header, SESSION_COOKIE));
  if (guest === null) {
    return {
      response: jsonResponse({ error: { code: "MISSING_SESSION", message: "a valid session cookie is required" } }, 401),
    };
  }
  return { session: { userId: guest.userId, kind: "guest" } };
}

export async function readJsonBody(
  request: NextRequest,
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        response: jsonResponse(
          { error: { code: "INVALID_INPUT", message: "request body must be a json object" } },
          400,
        ),
      };
    }
    return { body: parsed as Record<string, unknown> };
  } catch {
    return {
      response: jsonResponse({ error: { code: "INVALID_INPUT", message: "request body must be valid json" } }, 400),
    };
  }
}

export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null) {
    const first = forwarded.split(",")[0]?.trim();
    if (typeof first === "string" && first.length > 0) return first;
  }
  return "unknown";
}

export function codedError(code: string, message: string): Error {
  const err = new Error(message);
  (err as { code?: string }).code = code;
  return err;
}