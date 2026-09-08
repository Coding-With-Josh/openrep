import { NextRequest } from "next/server";
import { jsonResponse, errorResponse } from "@/server/error";
import { clientIp, codedError } from "@/server/http";
import { getRateLimiter } from "@/server/rate-limit";
import { mintSessionToken, readCookie, SESSION_COOKIE, sessionCookieAttributes, verifySessionToken } from "@/server/session";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const header = request.headers.get("cookie");
    const existing = verifySessionToken(readCookie(header, SESSION_COOKIE));

    const limiter = getRateLimiter();
    const limitKey = existing !== null ? `session:${existing.userId}` : `ip:${clientIp(request)}`;
    if (!limiter.allow(limitKey)) {
      return jsonResponse({ error: { code: "RATE_LIMITED", message: "too many requests, try again shortly" } }, 429);
    }

    if (existing !== null) {
      return jsonResponse({ userId: existing.userId, createdAt: existing.createdAt }, 200);
    }

    const { session, token } = mintSessionToken();
    const response = jsonResponse({ userId: session.userId, createdAt: session.createdAt }, 200);
    response.cookies.set(sessionCookieAttributes(token));
    return response;
  } catch (err) {
    return errorResponse(err);
  }
}