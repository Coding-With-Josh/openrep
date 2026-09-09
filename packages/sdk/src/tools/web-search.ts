// web_search via the freeserp discovery index (keyless, no signup). the
// origin is a constant and every argument is whitelisted before it reaches
// the query string, so a model cannot steer the request off the api or
// inject parameters. the index covers recently-live and newly-registered
// domains, not the whole web, and the description says so to keep the model
// from treating it as a general search engine. output is a compact pick of
// the documented fields, never a passthrough of the remote payload.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { readJsonBody, safeFetch, ToolError, type SafeFetchDeps } from "./guards.js";

const FREESERP_ORIGIN = "https://freeserp.ai";
const WEB_SEARCH_MAX_SIZE = 10;
const WEB_SEARCH_MAX_QUERY = 300;
const WEB_SEARCH_RETRY_DELAY_MS = 350;

const WEB_SEARCH_SORT_FIELDS = new Set([
  "relevance",
  "domain",
  "category",
  "ai_categories",
  "ai_source",
  "dr",
  "went_live",
  "first_seen",
  "real_site",
  "tld",
  "http_status",
  "content_length",
  "html_size",
  "webserver",
  "ip",
  "fetched_at",
]);

interface FreeSerpResult {
  domain?: unknown;
  url?: unknown;
  title?: unknown;
  ai_summary?: unknown;
  category?: unknown;
  ai_categories?: unknown;
  ai_source?: unknown;
  dr?: unknown;
  went_live?: unknown;
  first_seen?: unknown;
  tld?: unknown;
  http_status?: unknown;
  real_site?: unknown;
}

function pickResult(result: FreeSerpResult) {
  return {
    domain: typeof result.domain === "string" ? result.domain : null,
    url: typeof result.url === "string" ? result.url : null,
    title: typeof result.title === "string" ? result.title : null,
    summary: typeof result.ai_summary === "string" ? result.ai_summary : null,
    category: typeof result.category === "string" ? result.category : null,
    aiCategories: Array.isArray(result.ai_categories)
      ? result.ai_categories.filter((value): value is string => typeof value === "string")
      : [],
    aiSource: typeof result.ai_source === "string" ? result.ai_source : null,
    domainRating: typeof result.dr === "number" ? result.dr : null,
    wentLive: typeof result.went_live === "string" ? result.went_live : null,
    tld: typeof result.tld === "string" ? result.tld : null,
    httpStatus: typeof result.http_status === "number" ? result.http_status : null,
    realSite: typeof result.real_site === "number" ? result.real_site === 1 : null,
  };
}

const webSearchDefinition: ToolDefinition = {
  name: "web_search",
  description:
    `search freeserp's index of recently-live and newly-registered websites (keyless discovery index, not a general web search: established sites like google.com are not in it). good for finding new startups and niche sites, looking up one exact domain, discovering competitors, and checking whether a domain is live. "query" is the full-text search; "sort" is an optional field from relevance, domain, category, ai_categories, ai_source, dr, went_live, first_seen, real_site, tld, http_status, content_length, html_size, webserver, ip, fetched_at; "order" is asc or desc; "size" is 1 to ${WEB_SEARCH_MAX_SIZE}.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: WEB_SEARCH_MAX_QUERY },
      sort: { type: "string", minLength: 1, maxLength: 64 },
      order: { type: "string", minLength: 3, maxLength: 8 },
      size: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const webSearchImplementation: ToolImplementation = async (args: unknown) => {
  return runWebSearch(args);
};

// the runnable core takes injectable fetch/lookup deps so tests can stub the
// network deterministically; the registered implementation uses the real
// node defaults.
export async function runWebSearch(
  args: unknown,
  deps: SafeFetchDeps = {},
): Promise<{
  query: string;
  total: number | null;
  count: number;
  results: unknown[];
}> {
  const { query, sort, order, size } = args as {
    query?: unknown;
    sort?: unknown;
    order?: unknown;
    size?: unknown;
  };

  if (typeof query !== "string" || query.trim().length === 0) {
    throw new ToolError("query must be a non-empty string");
  }
  const cleanQuery = query.trim();
  if (cleanQuery.length > WEB_SEARCH_MAX_QUERY) {
    throw new ToolError(`query exceeds ${WEB_SEARCH_MAX_QUERY} characters`);
  }

  let cleanSort: string | undefined;
  if (sort !== undefined) {
    if (typeof sort !== "string" || !WEB_SEARCH_SORT_FIELDS.has(sort)) {
      throw new ToolError(
        `unknown sort field "${String(sort)}"; choose from: ${[...WEB_SEARCH_SORT_FIELDS].join(", ")}`,
      );
    }
    cleanSort = sort;
  }

  let cleanOrder: "asc" | "desc" | undefined;
  if (order !== undefined) {
    if (order !== "asc" && order !== "desc") {
      throw new ToolError(`order must be "asc" or "desc"`);
    }
    cleanOrder = order;
  }

  let cleanSize = 5;
  if (size !== undefined) {
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1 || size > WEB_SEARCH_MAX_SIZE) {
      throw new ToolError(`size must be an integer between 1 and ${WEB_SEARCH_MAX_SIZE}`);
    }
    cleanSize = size;
  }

  const url = new URL("/api.php", FREESERP_ORIGIN);
  url.searchParams.set("q", cleanQuery);
  if (cleanSort !== undefined && cleanSort !== "relevance") {
    url.searchParams.set("sort", cleanSort);
    url.searchParams.set("order", cleanOrder ?? "desc");
  }
  url.searchParams.set("size", String(cleanSize));
  // identification params the api accepts (no key); they only help the
  // operator reach us before breaking changes, they never affect results.
  url.searchParams.set("agent", "openrep-tool/0.1");
  url.searchParams.set("project", "openrep");

  // the api documents 502 as an upstream search error and asks for a retry
  // with backoff; one retry is enough for a per-turn tool call.
  let result = await safeFetch(url.toString(), {}, deps);
  if (result.status === 502) {
    await new Promise((resolve) => setTimeout(resolve, WEB_SEARCH_RETRY_DELAY_MS));
    result = await safeFetch(url.toString(), {}, deps);
  }
  if (result.status !== 200) {
    throw new ToolError(`search api returned status ${result.status}`);
  }

  const body = readJsonBody(result.body) as {
    ok?: unknown;
    total?: unknown;
    results?: unknown;
    error?: unknown;
    detail?: unknown;
  };
  if (body.ok !== true) {
    const detail = typeof body.detail === "string" ? ` (${body.detail})` : "";
    const error = typeof body.error === "string" ? body.error : "unknown";
    throw new ToolError(`search api failed: ${error}${detail}`);
  }

  const results = Array.isArray(body.results) ? body.results : [];
  return {
    query: cleanQuery,
    total: typeof body.total === "number" ? body.total : null,
    count: Math.min(results.length, cleanSize),
    results: results
      .slice(0, cleanSize)
      .map((entry) => pickResult(entry as FreeSerpResult)),
  };
};

export const webSearchTool: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
  { definition: webSearchDefinition, implementation: webSearchImplementation },
];