// web_fetch and wikipedia_lookup: the two url-driven stock tools. every
// request goes through the shared ssrf guard (scheme, dns, redirect, size,
// timeout); wikipedia reads clean json from the REST summary api. output is
// deliberately small because attest() rejects tool entries that serialize
// over its size cap rather than truncating them, so the tools bound their
// own output before returning.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { readJsonBody, safeFetch, ToolError } from "./guards.js";

const WEB_FETCH_MAX_BODY_CHARS = 2500;
const WIKIPEDIA_MAX_EXTRACT_CHARS = 2000;
const WIKIPEDIA_ORIGIN = "https://en.wikipedia.org";

// tags that separate text, not inline spans: replaced with a space so two
// paragraphs do not glue together; everything else is removed outright.
const BLOCK_TAG_PATTERN = new RegExp(
  `</?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|th|table|section|article|header|footer|blockquote|pre|hr)[^>]*>`,
  "gi",
);

export function stripHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(BLOCK_TAG_PATTERN, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, "");
  return withoutTags
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}... (truncated)`; // keeps an explicit marker, never a silent cut
}

const webFetchDefinition: ToolDefinition = {
  name: "web_fetch",
  description: `fetch a public http(s) url and return its visible text. use for documentation, news articles, and any page whose content the agent should read. returns at most ${WEB_FETCH_MAX_BODY_CHARS} characters; refuses private, loopback, and link-local addresses and non-http(s) schemes.`,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", minLength: 4, maxLength: 2048 },
    },
    required: ["url"],
    additionalProperties: false,
  },
};

const webFetchImplementation: ToolImplementation = async (args: unknown) => {
  const url = (args as { url?: unknown }).url;
  if (typeof url !== "string") {
    throw new ToolError("url must be a string");
  }
  const result = await safeFetch(url);
  if (result.status < 200 || result.status >= 300) {
    throw new ToolError(`url returned status ${result.status}`);
  }
  const text = stripHtmlToText(result.body);
  return {
    url: result.finalUrl,
    status: result.status,
    text: truncate(text, WEB_FETCH_MAX_BODY_CHARS),
  };
};

const wikipediaDefinition: ToolDefinition = {
  name: "wikipedia_lookup",
  description: `look up a wikipedia page by search query and return its summary. use for people, places, concepts, and events.`,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 300 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const wikipediaImplementation: ToolImplementation = async (args: unknown) => {
  const query = (args as { query?: unknown }).query;
  if (typeof query !== "string") {
    throw new ToolError("query must be a string");
  }

  const searchUrl = new URL("/w/api.php", WIKIPEDIA_ORIGIN);
  searchUrl.searchParams.set("action", "opensearch");
  searchUrl.searchParams.set("search", query);
  searchUrl.searchParams.set("limit", "1");
  searchUrl.searchParams.set("format", "json");

  const searchResult = await safeFetch(searchUrl.toString());
  if (searchResult.status !== 200) {
    throw new ToolError(`wikipedia search returned status ${searchResult.status}`);
  }
  const searchBody = readJsonBody(searchResult.body) as unknown;
  const titles = Array.isArray(searchBody)
    ? searchBody[1]
    : undefined;
  const title =
    Array.isArray(titles) && typeof titles[0] === "string" ? titles[0] : undefined;
  if (title === undefined) {
    return { found: false, query };
  }

  const summaryUrl = new URL(`/api/rest_v1/page/summary/${encodeURIComponent(title)}`, WIKIPEDIA_ORIGIN);
  const summaryResult = await safeFetch(summaryUrl.toString());
  if (summaryResult.status !== 200) {
    throw new ToolError(`wikipedia summary returned status ${summaryResult.status}`);
  }
  const summary = readJsonBody(summaryResult.body) as {
    title?: unknown;
    extract?: unknown;
    content_urls?: { desktop?: { page?: unknown } };
  };
  const extract = typeof summary.extract === "string" ? summary.extract : "";
  const pageUrl =
    typeof summary.content_urls?.desktop?.page === "string"
      ? summary.content_urls.desktop.page
      : summaryUrl.toString();

  return {
    found: true,
    title: typeof summary.title === "string" ? summary.title : title,
    summary: truncate(extract, WIKIPEDIA_MAX_EXTRACT_CHARS),
    url: pageUrl,
  };
};

export const fetchTools: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
  { definition: webFetchDefinition, implementation: webFetchImplementation },
  { definition: wikipediaDefinition, implementation: wikipediaImplementation },
];