// package_info tool tests, focused on the github branch's optional
// OPENREP_GITHUB_TOKEN authentication. the token is a rate-limit-only,
// public-repo-read credential: it must attach as an Authorization bearer
// header when present, must be entirely absent when unset or blank, and
// must never surface in the tool's output or in any error message. every
// case stubs fetch and dns so no real network call happens.
import { afterEach, describe, expect, it } from "vitest";
import { runPackageInfo } from "../src/tools/package-info.js";

const TOKEN = "ghp_openrep_test_token_1234567890";

const LOOKUP = async (hostname: string): Promise<readonly string[]> => {
  if (hostname === "api.github.com") return ["140.82.112.3"];
  if (hostname === "registry.npmjs.org") return ["104.16.25.34"];
  if (hostname === "pypi.org") return ["151.101.0.223"];
  throw new Error(`no such host ${hostname}`);
};

function capturedFetch(
  capture: (url: string, init: RequestInit) => void,
  status: number,
  body: unknown,
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    capture(String(input), init ?? {});
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

function capturedHeaders(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

afterEach(() => {
  delete process.env.OPENREP_GITHUB_TOKEN;
});

describe("package_info github with OPENREP_GITHUB_TOKEN", () => {
  it("sends Authorization: Bearer when the token is set and never echoes it into output", async () => {
    process.env.OPENREP_GITHUB_TOKEN = TOKEN;
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = capturedFetch(
      (url, init) => {
        seenUrl = url;
        seenHeaders = capturedHeaders(init);
      },
      200,
      {
        full_name: "facebook/react",
        description: "the library",
        stargazers_count: 999,
        language: "TypeScript",
        license: { spdx_id: "MIT" },
        html_url: "https://github.com/facebook/react",
      },
    );

    const output = await runPackageInfo(
      { name: "facebook/react", source: "github" },
      { fetchImpl, lookupImpl: LOOKUP },
    );

    expect(seenUrl).toBe("https://api.github.com/repos/facebook/react");
    expect(seenHeaders.authorization).toBe(`Bearer ${TOKEN}`);
    // the standard identity header is unchanged alongside the credential.
    expect(seenHeaders["user-agent"]).toBe("openrep-tool/0.1");
    expect(output).toEqual({
      source: "github",
      name: "facebook/react",
      description: "the library",
      stars: 999,
      language: "TypeScript",
      license: "MIT",
      url: "https://github.com/facebook/react",
    });
    // the token must never reach the model-facing output, a log line, or
    // the attestation evidence built from this result.
    expect(JSON.stringify(output)).not.toContain(TOKEN);
  });

  it("sends no authorization header (same request shape as today) when the token is unset or blank", async () => {
    const seenHeaders: Record<string, string>[] = [];
    const fetchImpl = capturedFetch(
      (_url, init) => seenHeaders.push(capturedHeaders(init)),
      200,
      { full_name: "n/a" },
    );

    delete process.env.OPENREP_GITHUB_TOKEN;
    await runPackageInfo({ name: "facebook/react", source: "github" }, { fetchImpl, lookupImpl: LOOKUP });
    expect(seenHeaders[0].authorization).toBeUndefined();
    expect(seenHeaders[0]["user-agent"]).toBe("openrep-tool/0.1");

    // whitespace-only is treated as absent, same convention as the provider key.
    process.env.OPENREP_GITHUB_TOKEN = "   ";
    await runPackageInfo({ name: "facebook/react", source: "github" }, { fetchImpl, lookupImpl: LOOKUP });
    expect(seenHeaders[1].authorization).toBeUndefined();
  });

  it("keeps the token out of a not-found error message", async () => {
    process.env.OPENREP_GITHUB_TOKEN = TOKEN;
    const fetchImpl = capturedFetch(() => {}, 404, {});
    let message = "";
    try {
      await runPackageInfo({ name: "missing/thing", source: "github" }, { fetchImpl, lookupImpl: LOOKUP });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/not found/);
    expect(message).not.toContain(TOKEN);
  });

  it("suppresses an upstream failure message that echoes the token", async () => {
    process.env.OPENREP_GITHUB_TOKEN = TOKEN;
    const fetchImpl = (async () => {
      throw new Error(`rate limited, token ${TOKEN} is over quota`);
    }) as typeof fetch;
    let message = "";
    try {
      await runPackageInfo({ name: "facebook/react", source: "github" }, { fetchImpl, lookupImpl: LOOKUP });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(TOKEN);
    expect(message).toMatch(/suppressed/i);
  });
});

describe("package_info npm and pypi baselines", () => {
  it("looks up npm without any authorization header", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = capturedFetch(
      (_url, init) => {
        seenHeaders = capturedHeaders(init);
      },
      200,
      {
        name: "express",
        "dist-tags": { latest: "4.19.2" },
        description: "web framework",
        license: "MIT",
        homepage: "https://expressjs.com",
        repository: { url: "https://github.com/expressjs/express" },
      },
    );

    const output = await runPackageInfo({ name: "express", source: "npm" }, { fetchImpl, lookupImpl: LOOKUP });

    expect(output).toEqual({
      source: "npm",
      name: "express",
      version: "4.19.2",
      description: "web framework",
      license: "MIT",
      homepage: "https://expressjs.com",
      repository: "https://github.com/expressjs/express",
    });
    expect(seenHeaders.authorization).toBeUndefined();
  });

  it("looks up pypi without any authorization header", async () => {
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = capturedFetch(
      (_url, init) => {
        seenHeaders = capturedHeaders(init);
      },
      200,
      {
        info: {
          name: "requests",
          version: "2.31.0",
          summary: "http library",
          license: "Apache-2.0",
          home_page: "https://requests.readthedocs.io",
        },
      },
    );

    const output = await runPackageInfo({ name: "requests", source: "pypi" }, { fetchImpl, lookupImpl: LOOKUP });

    expect(output).toEqual({
      source: "pypi",
      name: "requests",
      version: "2.31.0",
      summary: "http library",
      license: "Apache-2.0",
      homepage: "https://requests.readthedocs.io",
    });
    expect(seenHeaders.authorization).toBeUndefined();
  });
});