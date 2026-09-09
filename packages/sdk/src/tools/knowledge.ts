// hacker news and arxiv lookups. both are public json apis; results are
// compact objects whose fields are picked explicitly, never a passthrough of
// the remote payload. arxiv's atom xml is parsed with a tiny regex over the
// well-formed entries because the tool registry carries no xml dependency.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { readJsonBody, safeFetch, ToolError } from "./guards.js";

const HACKER_NEWS_ORIGIN = "https://hacker-news.firebaseio.com";
const ARXIV_ORIGIN = "https://export.arxiv.org";

async function fetchHnItem(id: number) {
  const result = await safeFetch(`${HACKER_NEWS_ORIGIN}/v0/item/${id}.json`);
  if (result.status !== 200) {
    throw new ToolError(`hacker news returned status ${result.status}`);
  }
  const body = readJsonBody(result.body) as {
    id?: unknown;
    type?: unknown;
    by?: unknown;
    title?: unknown;
    text?: unknown;
    url?: unknown;
    score?: unknown;
    descendants?: unknown;
  };
  return {
    id: typeof body.id === "number" ? body.id : id,
    type: typeof body.type === "string" ? body.type : null,
    by: typeof body.by === "string" ? body.by : null,
    title: typeof body.title === "string" ? body.title : null,
    text: typeof body.text === "string" ? body.text : null,
    url: typeof body.url === "string" ? body.url : null,
    score: typeof body.score === "number" ? body.score : null,
    comments: typeof body.descendants === "number" ? body.descendants : null,
  };
}

const hackerNewsDefinition: ToolDefinition = {
  name: "hacker_news_lookup",
  description:
    `look up a hacker news story by numeric id and return title, url, points, comment count, and the submitter.`,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "number" },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const hackerNewsImplementation: ToolImplementation = async (args: unknown) => {
  const id = (args as { id?: unknown }).id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new ToolError("id must be a positive integer");
  }
  return fetchHnItem(id);
};

// arxiv feeds are atom xml. `simpleXmlField` extracts the first occurrence
// of a leaf tag from an atom entry: the entries arrive as one contiguous
// xml string per query, so a single pass per field is enough and cheap.
function simpleXmlField(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  if (match === null) return null;
  return match[1].trim();
}

function simpleXmlFields(xml: string, tag: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    out.push(match[1].trim());
  }
  return out;
}

function stripTags(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/<[^>]+>/g, "").trim();
}

interface ArxivResult {
  id: string;
  title: string | null;
  summary: string | null;
  // joined strings, not arrays: the entry output sits one level deeper than
  // the per-entry validator measures, and a nested array in every result
  // would overflow canonicalize's depth-6 budget at signing time.
  authors: string;
  published: string | null;
  updated: string | null;
  categories: string;
}

function arxivCategories(entry: string): string[] {
  const out: string[] = [];
  const pattern = /<category[^>]*\sterm="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(entry)) !== null) {
    out.push(match[1]);
  }
  return out;
}

export function parseArxivFeed(xml: string): ArxivResult[] {
  const entryMatches = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entryMatches.map((entry) => {
    const id = simpleXmlField(entry, "id");
    const title = simpleXmlField(entry, "title");
    const summary = simpleXmlField(entry, "summary");
    const published = simpleXmlField(entry, "published");
    const updated = simpleXmlField(entry, "updated");
    return {
      id: id !== null ? id : "",
      title: stripTags(title),
      summary: stripTags(summary),
      authors: simpleXmlFields(entry, "name").map((name) => name.trim()).filter((name) => name.length > 0).join(", "),
      published,
      updated,
      categories: arxivCategories(entry).join(", "),
    };
  });
}

const arxivDefinition: ToolDefinition = {
  name: "arxiv_search",
  description:
    `search arxiv for academic papers matching a query and return the top few results with title, authors, summary, and the paper id.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 300 },
      maxResults: { type: "number" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const MAX_ARXIV_RESULTS = 5;

const arxivImplementation: ToolImplementation = async (args: unknown) => {
  const query = (args as { query?: unknown }).query;
  const maxResults = (args as { maxResults?: unknown }).maxResults;
  if (typeof query !== "string" || query.length === 0) {
    throw new ToolError("query must be a non-empty string");
  }
  const count =
    typeof maxResults === "number" && Number.isInteger(maxResults)
      ? Math.min(Math.max(maxResults, 1), MAX_ARXIV_RESULTS)
      : 3;

  const url = new URL("/api/query", ARXIV_ORIGIN);
  url.searchParams.set("search_query", `all:${query}`);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(count));
  const result = await safeFetch(url.toString());
  if (result.status !== 200) {
    throw new ToolError(`arxiv returned status ${result.status}`);
  }
  const entries = parseArxivFeed(result.body);
  return {
    query,
    results: entries.slice(0, count),
  };
};

export const knowledgeTools: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
  { definition: hackerNewsDefinition, implementation: hackerNewsImplementation },
  { definition: arxivDefinition, implementation: arxivImplementation },
];