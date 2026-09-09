// the stock tool registry: one array of { definition, implementation } per
// tool, assembled into a toolset that cannot drift between the schemas the
// agent sees (config.tools) and the executable map (the tools argument).
// storage-backed tools are created by the factory because the tool
// implementation signature carries no storage or context.
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import type { StorageAdapter } from "../types/storage.js";
import { fetchTools } from "./fetch-tools.js";
import { calculatorTool } from "./calculator.js";
import { weatherTool } from "./weather.js";
import { packageInfoTool } from "./package-info.js";
import { knowledgeTools } from "./knowledge.js";
import { webSearchTool } from "./web-search.js";
import { createStorageTools } from "./storage-tools.js";

export interface StockToolset {
  definitions: ToolDefinition[];
  implementations: Record<string, ToolImplementation>;
}

export function createStockToolset(deps: { storage: StorageAdapter }): StockToolset {
  const tools: readonly { definition: ToolDefinition; implementation: ToolImplementation }[] = [
    ...fetchTools,
    ...calculatorTool,
    ...weatherTool,
    ...packageInfoTool,
    ...knowledgeTools,
    ...webSearchTool,
    ...createStorageTools(deps.storage),
  ];
  const definitions: ToolDefinition[] = [];
  const implementations: Record<string, ToolImplementation> = {};
  for (const tool of tools) {
    definitions.push(tool.definition);
    implementations[tool.definition.name] = tool.implementation;
  }
  return { definitions, implementations };
}

// all tool names the registry can produce, for callers that want to filter
// or document the set before building an agent config.
export const STOCK_TOOL_NAMES: readonly string[] = [
  "web_fetch",
  "wikipedia_lookup",
  "calculator",
  "weather",
  "package_info",
  "hacker_news_lookup",
  "arxiv_search",
  "web_search",
  "self_reputation",
  "lookup_agent",
  "verify_attestation",
];