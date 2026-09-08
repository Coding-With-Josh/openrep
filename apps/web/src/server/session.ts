import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { getServerConfig } from "./config";

export const SESSION_COOKIE = "openrep_session";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const MAX_TOKEN_LENGTH = 512;

export interface GuestSession {
  userId: string;
  createdAt: string;
}

function signingKey(masterKey: string): Buffer {
  return createHash("sha256").update(masterKey, "utf8").digest();
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload, "utf8").digest("hex");
}

function hmacEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function mintSessionToken(): { session: GuestSession; token: string } {
  const userId = randomUUID();
  const createdAt = new Date().toISOString();
  const payload = `${userId}.${createdAt}`;
  const key = signingKey(getServerConfig().masterEncryptionKey);
  return {
    session: { userId, createdAt },
    token: `${payload}.${sign(payload, key)}`,
  };
}

export function verifySessionToken(
  token: string | undefined,
): GuestSession | null {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH
  )
    return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === token.length - 1) return null;
  const payload = token.slice(0, lastDot);
  const signature = token.slice(lastDot + 1);
  if (!SIGNATURE_PATTERN.test(signature)) return null;
  const key = signingKey(getServerConfig().masterEncryptionKey);
  if (!hmacEqual(signature, sign(payload, key))) return null;
  const sep = payload.indexOf(".");
  if (sep <= 0 || sep === payload.length - 1) return null;
  const userId = payload.slice(0, sep);
  const createdAt = payload.slice(sep + 1);
  if (!UUID_PATTERN.test(userId)) return null;
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  return { userId, createdAt };
}

export function readCookie(
  header: string | null,
  name: string,
): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function sessionCookieAttributes(token: string): {
  name: string;
  value: string;
  httpOnly: boolean;
  sameSite: "lax";
  secure: boolean;
  path: string;
  maxAge: number;
} {
  const config = getServerConfig();
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction,
    path: "/",
    maxAge: Math.ceil(config.sessionWindowMs / 1000),
  };
}
