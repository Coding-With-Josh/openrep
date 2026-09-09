// shared guards for every network-bound stock tool. the posture is fail
// closed for anything that could touch non-public infrastructure:
//
//   - http(s) schemes only; any other scheme is rejected before a request
//   - a hostname is resolved to every IP it answers (via dns) and each IP
//     must be outside private/loopback/link-local/ula/cgnat ranges before
//     the request is attempted; an ip literal is checked directly
//   - redirects are followed manually so every hop is re-checked with the
//     same rules before another request; the hop count is capped
//   - response bodies are read with a hard byte cap so a huge reply cannot
//     balloon memory or the attestation entry
//   - every fetch carries its own timeout so one hung external api cannot
//     starve the run loop's whole-budget timer
//
// dns-rebinding caveat: the ip check happens at request time, and node's
// fetch re-resolves the hostname independently, so a hostile nameserver
// could in principle answer differently for the second resolution. pinning
// is a cloud gateway concern, out of scope for a demo tool registry; the
// guard's guarantee is that no request is *knowingly* sent at a sensitive
// target.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const TOOL_FETCH_TIMEOUT_MS = 10_000;
export const TOOL_MAX_RESPONSE_BYTES = 1_000_000;
export const TOOL_MAX_REDIRECTS = 5;

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export type SafeFetchDeps = {
  fetchImpl?: typeof fetch;
  lookupImpl?: (hostname: string) => Promise<readonly string[]>;
};

export interface SafeFetchResult {
  status: number;
  body: string;
  finalUrl: string;
}

export async function defaultLookup(hostname: string): Promise<readonly string[]> {
  const result = await lookup(hostname, { all: true, verbatim: true });
  return result.map((entry) => entry.address);
}

function parseIpv4(address: string): readonly number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function parseIpv6(address: string): readonly number[] | null {
  const lower = address.toLowerCase();
  // ipv4-mapped addresses (::ffff:a.b.c.d) are refused outright rather than
  // resolved through a second encoding: the mapped ipv4 would have to pass
  // the ipv4 checks too, and it is simpler to be strict than to be clever.
  if (lower.includes(".")) return null;
  if (!lower.includes(":")) return null;

  let head: string;
  let tail: string;
  let headCount: number;
  let tailCount: number;
  if (lower.startsWith("::")) {
    head = "";
    tail = lower.slice(2);
    headCount = 0;
  } else if (lower.endsWith("::")) {
    head = lower.slice(0, -2);
    tail = "";
    tailCount = 0;
  } else {
    const pieces = lower.split("::");
    if (pieces.length !== 2) return null;
    head = pieces[0];
    tail = pieces[1];
  }

  const parseGroup = (group: string): readonly number[] | null => {
    if (group === "") return [];
    const offsets = group.split(":");
    const out: number[] = [];
    for (const raw of offsets) {
      if (!/^[0-9a-f]{1,4}$/.test(raw)) return null;
      out.push(parseInt(raw, 16));
    }
    return out;
  };

  const headGroups = head === "" ? [] : parseGroup(head);
  if (headGroups === null) return null;
  const tailGroups = tail === "" ? [] : parseGroup(tail);
  if (tailGroups === null) return null;
  headCount = headGroups.length;
  tailCount = tailGroups.length;

  // "::" expands to exactly the missing number of zero groups.
  const missing = 8 - headCount - tailCount;
  if (missing < 1) return null;
  const zeros = Array.from({ length: missing }, () => 0);
  const groups = [...headGroups, ...zeros, ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.flatMap((value) => [Math.floor(value / 256), value % 256]);
}

function bytesInCidr(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  if (bytes.length !== prefix.length) return false;
  let remaining = bits;
  for (let i = 0; i < bytes.length; i++) {
    if (remaining <= 0) break;
    const maskBits = Math.min(8, remaining);
    const mask = ((1 << maskBits) - 1) << (8 - maskBits);
    if ((bytes[i] & mask) !== (prefix[i] & mask)) return false;
    remaining -= maskBits;
  }
  return true;
}

const IPV4_PRIVATE_CIDRS: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0], 8], // 0.0.0.0/8 unspecified
  [[10, 0, 0, 0], 8], // 10.0.0.0/8 private
  [[100, 64, 0, 0], 10], // 100.64.0.0/10 cgnat
  [[127, 0, 0, 0], 8], // 127.0.0.0/8 loopback
  [[169, 254, 0, 0], 16], // 169.254.0.0/16 link-local
  [[172, 16, 0, 0], 12], // 172.16.0.0/12 private
  [[192, 0, 2, 0], 24], // 192.0.2.0/24 documentation
  [[192, 168, 0, 0], 16], // 192.168.0.0/16 private
  [[198, 18, 0, 0], 15], // 198.18.0.0/15 benchmarking
  [[198, 51, 100, 0], 24], // 198.51.100.0/24 documentation
  [[203, 0, 113, 0], 24], // 203.0.113.0/24 documentation
  [[224, 0, 0, 0], 4], // 224.0.0.0/4 multicast
  [[240, 0, 0, 0], 4], // 240.0.0.0/4 reserved
  [[255, 255, 255, 255], 32], // limited broadcast
];

const IPV6_PRIVATE_CIDRS: readonly (readonly [readonly number[], number])[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 128], // :: unspecified
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128], // ::1 loopback
  [[0xfc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 7], // fc00::/7 ula
  [[0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 10], // fe80::/10 link-local
  [[0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 8], // ff00::/8 multicast
];

function isSensitiveIpv4(address: string): boolean {
  const ip = parseIpv4(address);
  if (ip === null) return false; // not an ipv4 literal
  for (const [prefix, bits] of IPV4_PRIVATE_CIDRS) {
    if (bytesInCidr(ip, prefix, bits)) return true;
  }
  return false;
}

function isSensitiveIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (bytes === null) return true; // malformed ipv6 is refused, never fetched
  for (const [prefix, bits] of IPV6_PRIVATE_CIDRS) {
    if (bytesInCidr(bytes, prefix, bits)) return true;
  }
  return false;
}

export function isSensitiveIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isSensitiveIpv4(address);
  if (family === 6) return isSensitiveIpv6(address);
  return true; // not a valid ip literal: refuse rather than guess
}

export async function assertPublicUrl(
  url: string,
  deps: SafeFetchDeps = {},
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError("invalid url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ToolError(`unsupported url scheme ${parsed.protocol}`);
  }
  // url.hostname keeps brackets around an ipv6 literal; strip them before
  // the ip check so the literal is tested, never dns-resolved.
  const rawHostname = parsed.hostname;
  const hostname =
    rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const family = isIP(hostname);
  if (family !== 0) {
    if (isSensitiveIp(hostname)) {
      throw new ToolError("url resolves to a sensitive (private/loopback/link-local) address");
    }
    return parsed;
  }
  const lookupImpl = deps.lookupImpl ?? defaultLookup;
  let addresses: readonly string[];
  try {
    addresses = await lookupImpl(hostname);
  } catch {
    throw new ToolError(`dns lookup failed for ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new ToolError(`no addresses for ${hostname}`);
  }
  for (const address of addresses) {
    if (isSensitiveIp(address)) {
      throw new ToolError(
        `url resolves to a sensitive (private/loopback/link-local) address: ${address}`,
      );
    }
  }
  return parsed;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ToolError(`response exceeded ${maxBytes} bytes`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (signal.aborted) {
      throw new ToolError("fetch timed out while reading the response body");
    }
    throw error;
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function safeFetch(
  url: string,
  options: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
  deps: SafeFetchDeps = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? TOOL_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? TOOL_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? TOOL_MAX_REDIRECTS;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let current = await assertPublicUrl(url, deps);
  let redirects = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new ToolError(`fetch timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    try {
      let response: Response;
      try {
        response = await fetchImpl(current.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "openrep-tool/0.1" },
        });
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if (controller.signal.aborted) {
          throw new ToolError(`fetch timed out after ${timeoutMs}ms`);
        }
        throw new ToolError(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          return { status: response.status, body: "", finalUrl: current.toString() };
        }
        redirects += 1;
        if (redirects > maxRedirects) {
          throw new ToolError(`too many redirects (limit ${maxRedirects})`);
        }
        // each hop re-enters the same public-url gate before its request.
        current = await assertPublicUrl(new URL(location, current).toString(), deps);
        continue;
      }

      const body = await readBoundedBody(response, maxBytes, controller.signal);
      return { status: response.status, body, finalUrl: current.toString() };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function readJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new ToolError("response was not valid json");
  }
}