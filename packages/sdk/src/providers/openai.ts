// the openai provider adapter. mirrors anthropic.ts: translates
// ToolDefinition[] into openai's function tool format, makes the api
// request over global fetch, and maps the raw response into the normalized
// ProviderResponse. all openai parsing stays inside this file.
//
// the wire format is shared with the openai-compatible tier: any
// chat-completions-style endpoint that accepts a Bearer key and function
// tools speaks the same protocol, so the core implementation is one class
// parameterized by base url and the label used in error messages.
// OpenAiClient is a thin instance pointed at openai's own endpoint;
// OpenAiCompatibleClient is the same core pointed at a caller-supplied
// base url.

import type { AgentConfig, ModelProvider, ProviderMessage, ProviderResponse, ProviderClient } from "../types/providers.js";
import { OPENAI_API_URL } from "./shared.js";
import { isAbortError, ProviderApiError } from "./errors.js";

// normalize a caller-supplied base url to the full chat-completions
// endpoint. deterministic and additive only: a value already ending in
// /chat/completions is kept verbatim, otherwise the path is appended. this
// is a syntactic helper; the caller's url is validated (present, http/https)
// at the factory boundary before any request could carry the api key.
export function normalizeChatCompletionsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

// the shared core. not exported: the two public clients pin the provider
// label and the base url, which keeps each request bound to one endpoint.
class OpenAiChatCore implements ProviderClient {
  readonly provider: ModelProvider;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly label: string;

  constructor(apiKey: string, baseUrl: string, provider: ModelProvider, label: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.provider = provider;
    this.label = label;
  }

  async complete(
    messages: ProviderMessage[],
    signal: AbortSignal,
    config: AgentConfig,
  ): Promise<ProviderResponse> {
    const body = {
      model: config.model,
      messages: [
        // openai / openai-compatible wire format: system instruction as the
        // first role:system message in the conversation, separate from the
        // user/assistant flow. when absent, the provider uses its default.
        ...(config.system
          ? [{ role: "system" as const, content: config.system }]
          : []),
        ...messages.map((message) => {
          if ("name" in message) {
            // a tool result: deliver as a user turn labeled with the tool
            // name, matching the historical openai wire format even though
            // the message model may carry extra structured fields that this
            // provider does not model.
            return { role: "user" as const, content: message.content, name: message.name };
          }
          return { role: message.role, content: message.content };
        }),
      ],
      tools: config.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
    };

    let response: Response;
    try {
      response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // fetch throws on network error or abort. abort is a timeout, anything
      // else is a provider failure. the api key never enters this message.
      if (isAbortError(error)) throw error;
      throw new ProviderApiError(`${this.label} request failed`);
    }

    if (!response.ok) {
      throw new ProviderApiError(`${this.label} api error ${response.status}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderApiError(`${this.label} response was not json`);
    }
    return parseOpenAiResponse(json, this.label);
  }
}

export class OpenAiClient implements ProviderClient {
  readonly provider = "openai" as const;
  private readonly core: OpenAiChatCore;

  constructor(apiKey: string) {
    this.core = new OpenAiChatCore(apiKey, OPENAI_API_URL, "openai", "openai");
  }

  async complete(
    messages: ProviderMessage[],
    signal: AbortSignal,
    config: AgentConfig,
  ): Promise<ProviderResponse> {
    return this.core.complete(messages, signal, config);
  }
}

export class OpenAiCompatibleClient implements ProviderClient {
  readonly provider = "openai-compatible" as const;
  private readonly core: OpenAiChatCore;

  constructor(apiKey: string, baseUrl: string) {
    this.core = new OpenAiChatCore(
      apiKey,
      normalizeChatCompletionsBaseUrl(baseUrl),
      "openai-compatible",
      "openai-compatible",
    );
  }

  async complete(
    messages: ProviderMessage[],
    signal: AbortSignal,
    config: AgentConfig,
  ): Promise<ProviderResponse> {
    return this.core.complete(messages, signal, config);
  }
}

function parseOpenAiResponse(json: unknown, label: string): ProviderResponse {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ProviderApiError(`${label} response shape was invalid`);
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderApiError(`${label} response had no choices`);
  }
  const choice = choices[0];
  if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ProviderApiError(`${label} response choice shape was invalid`);
  }
  const message = (choice as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProviderApiError(`${label} response had no message`);
  }
  const item = message as { content?: unknown; tool_calls?: unknown };

  // a text turn may carry content as a string or null when a tool call was
  // requested instead.
  if (typeof item.content === "string" && item.content.length > 0) {
    return { kind: "text", text: item.content };
  }

  if (Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
    const call = item.tool_calls[0];
    if (call === null || typeof call !== "object" || Array.isArray(call)) {
      throw new ProviderApiError(`${label} tool call shape was invalid`);
    }
    const fn = (call as { function?: unknown }).function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) {
      throw new ProviderApiError(`${label} tool call had no function`);
    }
    const fnItem = fn as { name?: unknown; arguments?: unknown };
    if (typeof fnItem.name !== "string") {
      throw new ProviderApiError(`${label} tool call had no name`);
    }
    let parsed: unknown;
    try {
      parsed = typeof fnItem.arguments === "string" ? JSON.parse(fnItem.arguments) : fnItem.arguments;
    } catch {
      throw new ProviderApiError(`${label} tool arguments were not json`);
    }
    return { kind: "tool_call", name: fnItem.name, arguments: parsed };
  }

  throw new ProviderApiError(`${label} response contained no usable message`);
}