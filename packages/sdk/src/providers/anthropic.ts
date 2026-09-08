// the anthropic provider adapter. translates ToolDefinition[] into
// anthropic's tool format, makes the api request over global fetch, and
// maps the raw response into the normalized ProviderResponse. no provider
// parsing exists outside this file; the run loop never sees anthropic's
// wire shape.

import type { AgentConfig, ProviderMessage, ProviderResponse, ProviderClient } from "../types/providers.js";
import { ANTHROPIC_API_URL, toolPayload, toTextMessages } from "./shared.js";
import { isAbortError, ProviderApiError } from "./errors.js";

// anthropic's messages api model id is supplied by the caller in
// AgentConfig.model, so the adapter itself is stateless beyond the api key.
export class AnthropicClient implements ProviderClient {
  readonly provider = "anthropic" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async complete(
    messages: ProviderMessage[],
    signal: AbortSignal,
    config: AgentConfig,
  ): Promise<ProviderResponse> {
    const body = {
      model: config.model,
      max_tokens: 2048,
      // anthropic wire format: the system prompt is a top-level field, not a
      // conversation turn. attached separately so toTextMessages stays a pure
      // user/assistant mapping.
      ...(config.system ? { system: config.system } : {}),
      messages: toTextMessages(messages),
      tools: config.tools.map((tool) => toolPayload(tool.name, tool.description, tool.inputSchema)),
    };

    let response: Response;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // fetch throws on network error or abort. abort is a timeout, anything
      // else is a provider failure. the api key never enters this message.
      if (isAbortError(error)) throw error;
      throw new ProviderApiError("anthropic request failed");
    }

    if (!response.ok) {
      throw new ProviderApiError(`anthropic api error ${response.status}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderApiError("anthropic response was not json");
    }
    return parseAnthropicResponse(json);
  }
}

function parseAnthropicResponse(json: unknown): ProviderResponse {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ProviderApiError("anthropic response shape was invalid");
  }
  const content = (json as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new ProviderApiError("anthropic response had no content array");
  }
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const item = block as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
    if (item.type === "text" && typeof item.text === "string") {
      return { kind: "text", text: item.text };
    }
    if (item.type === "tool_use" && typeof item.name === "string" && item.input !== undefined) {
      return { kind: "tool_call", name: item.name, arguments: item.input };
    }
  }
  throw new ProviderApiError("anthropic response contained no usable block");
}