// package metadata lookup for npm, pypi, and github. registry and api
// responses are json, read through the ssrf guard; the package name is
// restricted to slug characters before it is ever interpolated into a url.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { readJsonBody, safeFetch, ToolError } from "./guards.js";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
const PYPI_ORIGIN = "https://pypi.org";
const GITHUB_API_ORIGIN = "https://api.github.com";

const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

function normalizeSlug(raw: string, label: string): string {
  const slug = raw.trim();
  if (slug.length > 214 || !SLUG_PATTERN.test(slug)) {
    throw new ToolError(`${label} must be a slug of letters, digits, dots, dashes, and underscores (max 214 chars)`);
  }
  return slug;
}

function normalizeRepo(raw: string): { owner: string; repo: string } {
  const trimmed = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\/$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new ToolError("github repo must be owner/name");
  }
  if (!SLUG_PATTERN.test(parts[0]) || !SLUG_PATTERN.test(parts[1])) {
    throw new ToolError("github owner and name must be slugs");
  }
  return { owner: parts[0], repo: parts[1] };
}

async function lookupNpm(name: string) {
  const url = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}`;
  const result = await safeFetch(url);
  if (result.status !== 200) {
    throw new ToolError(`npm returned status ${result.status} for ${name}`);
  }
  const body = readJsonBody(result.body) as {
    name?: unknown;
    "dist-tags"?: { latest?: unknown };
    description?: unknown;
    license?: unknown;
    homepage?: unknown;
    repository?: { url?: unknown } | { type?: unknown; url?: unknown };
  };
  const license =
    typeof body.license === "string"
      ? body.license
      : typeof body.license === "object" && body.license !== null &&
        typeof (body.license as { type?: unknown }).type === "string"
        ? (body.license as { type: string }).type
        : null;
  const repository =
    body.repository !== null && typeof body.repository === "object"
      ? ((body.repository as { url?: unknown }).url ?? null)
      : null;
  return {
    source: "npm",
    name: typeof body.name === "string" ? body.name : name,
    version: typeof body["dist-tags"]?.latest === "string" ? body["dist-tags"].latest : null,
    description: typeof body.description === "string" ? body.description : null,
    license,
    homepage: typeof body.homepage === "string" ? body.homepage : null,
    repository: typeof repository === "string" ? repository : null,
  };
}

async function lookupPypi(name: string) {
  const url = `${PYPI_ORIGIN}/pypi/${encodeURIComponent(name)}/json`;
  const result = await safeFetch(url);
  if (result.status !== 200) {
    throw new ToolError(`pypi returned status ${result.status} for ${name}`);
  }
  const body = readJsonBody(result.body) as {
    info?: {
      name?: unknown;
      version?: unknown;
      summary?: unknown;
      license?: unknown;
      home_page?: unknown;
      project_urls?: unknown;
    };
  };
  const info = body.info ?? {};
  const projectUrls = info.project_urls;
  let homepage: unknown = info.home_page;
  if (typeof projectUrls === "object" && projectUrls !== null && !Array.isArray(projectUrls)) {
    const first = Object.values(projectUrls as Record<string, unknown>).find((value) => typeof value === "string");
    if (homepage === undefined || homepage === "") homepage = first;
  }
  return {
    source: "pypi",
    name: typeof info.name === "string" ? info.name : name,
    version: typeof info.version === "string" ? info.version : null,
    summary: typeof info.summary === "string" ? info.summary : null,
    license: typeof info.license === "string" ? info.license : null,
    homepage: typeof homepage === "string" ? homepage : null,
  };
}

async function lookupGithub(owner: string, repo: string) {
  const url = `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const result = await safeFetch(url);
  if (result.status === 404) {
    throw new ToolError(`github repo ${owner}/${repo} not found`);
  }
  if (result.status !== 200) {
    throw new ToolError(`github api returned status ${result.status} for ${owner}/${repo}`);
  }
  const body = readJsonBody(result.body) as {
    full_name?: unknown;
    description?: unknown;
    stargazers_count?: unknown;
    language?: unknown;
    license?: { spdx_id?: unknown };
    html_url?: unknown;
  };
  return {
    source: "github",
    name: typeof body.full_name === "string" ? body.full_name : `${owner}/${repo}`,
    description: typeof body.description === "string" ? body.description : null,
    stars: typeof body.stargazers_count === "number" ? body.stargazers_count : null,
    language: typeof body.language === "string" ? body.language : null,
    license: typeof body.license?.spdx_id === "string" ? body.license.spdx_id : null,
    url: typeof body.html_url === "string" ? body.html_url : null,
  };
}

const packageInfoDefinition: ToolDefinition = {
  name: "package_info",
  description:
    `look up metadata for a software package or repository. source is one of "npm", "pypi", or "github". for npm and pypi "name" is the package slug; for github "name" is owner/name. returns version, description, license, and links where available.`,
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1, maxLength: 300 },
      source: { type: "string", minLength: 1, maxLength: 16 },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

const packageInfoImplementation: ToolImplementation = async (args: unknown) => {
  const { name, source } = args as { name?: unknown; source?: unknown };
  const givenSource = typeof source === "string" ? source.trim().toLowerCase() : "auto";
  const rawName = typeof name === "string" ? name : "";
  if (rawName.length === 0) {
    throw new ToolError("name is required");
  }

  if (givenSource === "npm") {
    return lookupNpm(normalizeSlug(rawName, "npm package name"));
  }
  if (givenSource === "pypi") {
    return lookupPypi(normalizeSlug(rawName, "pypi package name"));
  }
  if (givenSource === "github") {
    const { owner, repo } = normalizeRepo(rawName);
    return lookupGithub(owner, repo);
  }
  if (givenSource === "auto") {
    if (rawName.includes("/")) {
      const { owner, repo } = normalizeRepo(rawName);
      return lookupGithub(owner, repo);
    }
    const slug = normalizeSlug(rawName, "package name");
    try {
      return await lookupNpm(slug);
    } catch {
      return lookupPypi(slug);
    }
  }
  throw new ToolError(`unknown package source "${givenSource}" (expected npm, pypi, or github)`);
};

export const packageInfoTool: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
  { definition: packageInfoDefinition, implementation: packageInfoImplementation },
];