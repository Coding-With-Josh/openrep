// the openai provider adapter. mirrors anthropic.ts: translates
// ToolDefinition[] into openai's function tool format, makes the api
// request over global fetch, and maps the raw response into the normalized
// ProviderResponse. all openai parsing stays inside this file.

import type { AgentConfig, ProviderMessage, ProviderResponse, ProviderClient } from "../types/providers.js";
import { OPENAI_API_URL } from "./shared.js";
import { isAbortError, ProviderApiError } from "./errors.js";

export class OpenAiClient implements ProviderClient {
  readonly provider = "openai" as const;
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
      messages: messages.map((message) => {
        if ("name" in message) {
          // a tool result: deliver as a user turn labeled with the tool name.
          return { role: "user", content: message.content, name: message.name };
        }
        return { role: message.role, content: message.content };
      }),
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
      response = await fetch(OPENAI_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new ProviderApiError("openai request failed");
    }

    if (!response.ok) {
      throw new ProviderApiError(`openai api error ${response.status}`);
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderApiError("openai response was not json");
    }
    return parseOpenAiResponse(json);
  }
}

function parseOpenAiResponse(json: unknown): ProviderResponse {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ProviderApiError("openai response shape was invalid");
  }
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderApiError("openai response had no choices");
  }
  const choice = choices[0];
  if (choice === null || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ProviderApiError("openai response choice shape was invalid");
  }
  const message = (choice as { message?: unknown }).message;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProviderApiError("openai response had no message");
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
      throw new ProviderApiError("openai tool call shape was invalid");
    }
    const fn = (call as { function?: unknown }).function;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) {
      throw new ProviderApiError("openai tool call had no function");
    }
    const fnItem = fn as { name?: unknown; arguments?: unknown };
    if (typeof fnItem.name !== "string") {
      throw new ProviderApiError("openai tool call had no name");
    }
    let parsed: unknown;
    try {
      parsed = typeof fnItem.arguments === "string" ? JSON.parse(fnItem.arguments) : fnItem.arguments;
    } catch {
      throw new ProviderApiError("openai tool arguments were not json");
    }
    return { kind: "tool_call", name: fnItem.name, arguments: parsed };
  }

  throw new ProviderApiError("openai response contained no usable message");
}