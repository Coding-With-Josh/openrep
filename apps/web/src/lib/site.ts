const FALLBACK_SITE_URL = "http://localhost:3177";

export function siteUrl(): string {
  const raw = process.env.OPENREP_SITE_URL;
  if (raw === undefined || raw.trim().length === 0) {
    return FALLBACK_SITE_URL;
  }
  const trimmed = raw.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OPENREP_SITE_URL must be an absolute http(s) url");
  }
  return trimmed;
}

export const metadataBase = new URL(siteUrl());