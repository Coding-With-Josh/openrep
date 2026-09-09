// ssrf guard tests. the guard's contract: a url is refused, before any
// request, if its scheme is not http(s), if any ip it resolves to is in a
// sensitive range, or if the redirect chain exceeds the cap. the injected
// lookup/fetch implementations keep every case deterministic and offline.
import { describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  isSensitiveIp,
  safeFetch,
  ToolError,
} from "../src/tools/guards.js";

const PUBLIC_LOOKUP = async (hostname: string): Promise<readonly string[]> => {
  if (hostname === "example.com") return ["93.184.216.34"];
  if (hostname === "reject.example") return ["127.0.0.1"];
  throw new Error(`no such host ${hostname}`);
};

describe("isSensitiveIp", () => {
  it("rejects loopback, private, link-local, and ula ranges", () => {
    expect(isSensitiveIp("127.0.0.1")).toBe(true);
    expect(isSensitiveIp("10.1.2.3")).toBe(true);
    expect(isSensitiveIp("172.16.0.1")).toBe(true);
    expect(isSensitiveIp("172.31.255.255")).toBe(true);
    expect(isSensitiveIp("192.168.0.1")).toBe(true);
    expect(isSensitiveIp("169.254.169.254")).toBe(true);
    expect(isSensitiveIp("0.0.0.0")).toBe(true);
    expect(isSensitiveIp("::1")).toBe(true);
    expect(isSensitiveIp("fe80::1")).toBe(true);
    expect(isSensitiveIp("fc00::1")).toBe(true);
    expect(isSensitiveIp("fdfd::abcd:1")).toBe(true);
    expect(isSensitiveIp("febf:ffff::1")).toBe(true);
    expect(isSensitiveIp("ff05::1")).toBe(true);
  });

  it("allows public ranges and rejects malformed literals", () => {
    expect(isSensitiveIp("93.184.216.34")).toBe(false);
    expect(isSensitiveIp("8.8.8.8")).toBe(false);
    expect(isSensitiveIp("2606:4700::6810:84e5")).toBe(false);
    expect(isSensitiveIp("2001:4860:4860::8888")).toBe(false);
    expect(isSensitiveIp("2404:6800:4001::1")).toBe(false);
    expect(isSensitiveIp("not-an-ip")).toBe(true);
    expect(isSensitiveIp("::ffff:93.184.216.34")).toBe(true);
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", { lookupImpl: PUBLIC_LOOKUP })).rejects.toThrow(
      ToolError,
    );
    await expect(assertPublicUrl("javascript:alert(1)", { lookupImpl: PUBLIC_LOOKUP })).rejects.toThrow(
      "scheme",
    );
    await expect(assertPublicUrl("ftp://example.com/x", { lookupImpl: PUBLIC_LOOKUP })).rejects.toThrow(
      "scheme",
    );
  });

  it("rejects a hostname that resolves to a sensitive ip", async () => {
    await expect(
      assertPublicUrl("http://reject.example/", { lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow("sensitive");
  });

  it("rejects an ip-literal in a sensitive range without dns", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/", { lookupImpl: PUBLIC_LOOKUP })).rejects.toThrow(
      "sensitive",
    );
    await expect(assertPublicUrl("http://[::1]/", { lookupImpl: PUBLIC_LOOKUP })).rejects.toThrow(
      "sensitive",
    );
    await expect(assertPublicUrl("http://192.168.1.1/", { lookupImpl: PUBLIC_LOOKUP })).rejects.toThrow(
      "sensitive",
    );
  });

  it("allows a public hostname and a public ip literal", async () => {
    await expect(assertPublicUrl("https://example.com/", { lookupImpl: PUBLIC_LOOKUP })).resolves.toBeDefined();
    await expect(assertPublicUrl("http://93.184.216.34/", { lookupImpl: PUBLIC_LOOKUP })).resolves.toBeDefined();
  });
});

describe("safeFetch", () => {
  it("follows a limited redirect chain and re-gates each hop", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const raw = String(input);
      if (raw === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "https://example.com/target" } });
      }
      if (raw === "https://example.com/target") {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch ${raw}`);
    }) as typeof fetch;

    const result = await safeFetch("https://example.com/start", {}, { fetchImpl, lookupImpl: PUBLIC_LOOKUP });
    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
    expect(result.finalUrl).toBe("https://example.com/target");
  });

  it("refuses a redirect that lands on a sensitive address", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input) === "https://example.com/start") {
        return new Response(null, { status: 301, headers: { location: "http://127.0.0.1/admin" } });
      }
      throw new Error(`unexpected fetch ${String(input)}`);
    }) as typeof fetch;

    await expect(
      safeFetch("https://example.com/start", {}, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow("sensitive");
  });

  it("caps redirect hops", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const count = Number(String(input).split("=")[1] ?? "0");
      return new Response(null, { status: 302, headers: { location: `https://example.com/next=${count + 1}` } });
    }) as typeof fetch;

    await expect(
      safeFetch("https://example.com/next=0", { maxRedirects: 3 }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow("too many redirects");
  });

  it("caps the response body size", async () => {
    const fetchImpl = (async () => new Response("x".repeat(2000), { status: 200 })) as typeof fetch;
    await expect(
      safeFetch("https://example.com/", { maxBytes: 1000 }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow("exceeded");
  });

  it("times out a stalled response", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return new Response("never");
    }) as typeof fetch;
    await expect(
      safeFetch("https://example.com/", { timeoutMs: 25 }, { fetchImpl, lookupImpl: PUBLIC_LOOKUP }),
    ).rejects.toThrow("timed out");
  });
});