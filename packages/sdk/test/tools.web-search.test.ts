// web_search tool tests. the runnable core takes injected fetch + lookup
// deps, so every case is deterministic and offline. the stub mirrors the
// freeserp contract: http 200 with ok:true on success, 502 for an upstream
// error, ok:false bodies for api-level failures.
import { describe, expect, it } from "vitest";
import { runWebSearch } from "../src/tools/web-search.js";
import { ToolError } from "../src/tools/guards.js";

const LOOKUP = async (hostname: string): Promise<readonly string[]> => {
  if (hostname === "freeserp.ai") return ["93.184.216.34"];
  throw new Error(`no such host ${hostname}`);
};

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch;
}

const RESULT_ROW = {
  domain: "example.ai",
  url: "https://example.ai",
  title: "Example: AI chatbot",
  ai_summary: "Example is an AI chatbot platform.",
  category: "ai",
  ai_categories: ["AI Chatbot & Assistant"],
  ai_source: "nextjs",
  dr: 41,
  went_live: "2026-08-22",
  first_seen: "2026-07-10",
  tld: "ai",
  http_status: 200,
  real_site: 1,
  content_length: 8123,
};

describe("web_search", () => {
  it("returns mapped, compact results for a successful query", async () => {
    const fetchImpl = stubFetch(() =>
      new Response(
        JSON.stringify({ ok: true, query: "ai chatbot", total: 10, count: 1, results: [RESULT_ROW] }),
        { status: 200 },
      ),
    );
    const output = await runWebSearch({ query: "ai chatbot" }, { fetchImpl, lookupImpl: LOOKUP });
    expect(output.query).toBe("ai chatbot");
    expect(output.total).toBe(10);
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toEqual({
      domain: "example.ai",
      url: "https://example.ai",
      title: "Example: AI chatbot",
      summary: "Example is an AI chatbot platform.",
      category: "ai",
      aiCategories: ["AI Chatbot & Assistant"],
      aiSource: "nextjs",
      domainRating: 41,
      wentLive: "2026-08-22",
      tld: "ai",
      httpStatus: 200,
      realSite: true,
    });
  });

  it("passes sort and order through and omits them for relevance", async () => {
    const calls: string[] = [];
    const fetchImpl = stubFetch((url) => {
      calls.push(url);
      return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 });
    });
    await runWebSearch({ query: "startup", sort: "dr", order: "asc" }, { fetchImpl, lookupImpl: LOOKUP });
    await runWebSearch({ query: "startup", sort: "relevance" }, { fetchImpl, lookupImpl: LOOKUP });
    expect(calls[0]).toContain("sort=dr");
    expect(calls[0]).toContain("order=asc");
    expect(calls[1]).not.toContain("sort=");
    // identification params are always present
    expect(calls[0]).toContain("agent=openrep-tool%2F0.1");
    expect(calls[0]).toContain("project=openrep");
  });

  it("rejects unknown sort, invalid order, and out-of-range size", async () => {
    const fetchImpl = stubFetch(() =>
      new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 }),
    );
    await expect(
      runWebSearch({ query: "x", sort: "exec" }, { fetchImpl, lookupImpl: LOOKUP }),
    ).rejects.toThrow(ToolError);
    await expect(
      runWebSearch({ query: "x", order: "up" }, { fetchImpl, lookupImpl: LOOKUP }),
    ).rejects.toThrow(ToolError);
    await expect(
      runWebSearch({ query: "x", size: 50 }, { fetchImpl, lookupImpl: LOOKUP }),
    ).rejects.toThrow(ToolError);
    await expect(
      runWebSearch({ query: "x", size: 1.5 }, { fetchImpl, lookupImpl: LOOKUP }),
    ).rejects.toThrow(ToolError);
  });

  it("retries once after a 502 upstream error and succeeds on the second call", async () => {
    let calls = 0;
    const fetchImpl = stubFetch(() => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ ok: false, error: "upstream" }), { status: 502 });
      }
      return new Response(JSON.stringify({ ok: true, results: [] }), { status: 200 });
    });
    const output = await runWebSearch({ query: "x" }, { fetchImpl, lookupImpl: LOOKUP });
    expect(calls).toBe(2);
    expect(output.results).toEqual([]);
  });

  it("surfaces api-level failure bodies as errors", async () => {
    const fetchImpl = stubFetch(() =>
      new Response(
        JSON.stringify({ ok: false, error: "upstream", detail: "search_phase_execution_exception" }),
        { status: 200 },
      ),
    );
    await expect(
      runWebSearch({ query: "x" }, { fetchImpl, lookupImpl: LOOKUP }),
    ).rejects.toThrow("search api failed: upstream (search_phase_execution_exception)");
  });
});