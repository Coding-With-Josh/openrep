// the gemini provider adapter. translates ToolDefinition[] into gemini's
// functionDeclarations, makes the api request over global fetch, and maps
// the raw response into the normalized ProviderResponse. all gemini parsing
// stays inside this file; the run loop never sees gemini's wire shape.
//
// wire format (verified against ai.google.dev current docs, 2026-09):
//   - endpoint POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   - auth via the x-goog-api-key header, never in the body or url query
//   - request bodies carry contents as role+parts arrays and optional
//     tools[].functionDeclarations
//   - tool definitions use lowered OpenAPI-style json schema for parameters,
//     so ToolDefinition.inputSchema is forwarded verbatim
//   - a model turn that is a tool call is a parts entry with a functionCall
//     object; the tool result comes back as a functionResponse part. gemini 3
//     attaches an id and/or thoughtSignature to functionCall which must be
//     echoed in the paired functionResponse; the run loop carries those
//     fields through the normalized message model unchanged.

import type { AgentConfig, ProviderMessage, ProviderResponse, ProviderClient } from "../types/providers.js";
import { isAbortError, ProviderApiError, retryAfterSeconds } from "./errors.js";

export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export class GeminiClient implements ProviderClient {
  readonly provider = "gemini" as const;
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async complete(
    messages: ProviderMessage[],
    signal: AbortSignal,
    config: AgentConfig,
  ): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      contents: toGeminiContents(messages),
    };
    if (config.system) {
      // gemini wire format: system instruction is a top-level
      // systemInstruction content block, not a conversation turn. the sdk
      // supplies it separately so the user/assistant contents never carry the
      // raw instruction as model-facing text.
      body.systemInstruction = { parts: [{ text: config.system }] };
    }
    if (config.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: config.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            // forwarded verbatim: the rest endpoint accepts the lowered
            // json-schema subset the sdk already validates against.
            parameters: tool.inputSchema,
          })),
        },
      ];
    }

    const url = `${GEMINI_API_URL}/${encodeURIComponent(config.model)}:generateContent`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // fetch throws on network error or abort. abort is a timeout, anything
      // else is a provider failure. the api key never enters this message.
      if (isAbortError(error)) throw error;
      throw new ProviderApiError("gemini request failed");
    }

    if (!response.ok) {
      throw new ProviderApiError(`gemini api error ${response.status}`, response.status, retryAfterSeconds(response));
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ProviderApiError("gemini response was not json");
    }
    return parseGeminiResponse(json);
  }
}

// map the normalized conversation onto gemini contents. a structured
// assistant message with a toolCall becomes a model turn carrying exactly
// the functionCall part the model originally produced, including the
// id/thoughtSignature the loop echoed; a tool-result user message becomes a
// user turn with the paired functionResponse part. plain user and assistant
// text turns map to text parts.
function toGeminiContents(messages: ProviderMessage[]): { role: "user" | "model"; parts: unknown[] }[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      if (message.toolCall) {
        const functionCall: Record<string, unknown> = {
          name: message.toolCall.name,
          args: message.toolCall.arguments,
          ...(message.toolCall.id !== undefined && { id: message.toolCall.id }),
          ...(message.toolCall.thoughtSignature !== undefined && { thoughtSignature: message.toolCall.thoughtSignature }),
        };
        return { role: "model", parts: [{ functionCall }] };
      }
      return { role: "model", parts: [{ text: message.content }] };
    }
    if ("name" in message) {
      // a fed-back tool result. the response payload is the serialized tool
      // output, and the id/thoughtSignature fields echo the original call
      // so gemini 3 can pair the result with its functionCall.
      const functionResponse: Record<string, unknown> = {
        name: message.name,
        response: { output: message.content },
        ...(message.toolCallId !== undefined && { id: message.toolCallId }),
        ...(message.thoughtSignature !== undefined && { thoughtSignature: message.thoughtSignature }),
      };
      return { role: "user", parts: [{ functionResponse }] };
    }
    return { role: "user", parts: [{ text: message.content }] };
  });
}

function parseGeminiResponse(json: unknown): ProviderResponse {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ProviderApiError("gemini response shape was invalid");
  }
  const candidates = (json as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ProviderApiError("gemini response had no candidates");
  }
  const candidate = candidates[0];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProviderApiError("gemini response candidate shape was invalid");
  }
  const content = (candidate as { content?: unknown }).content;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    throw new ProviderApiError("gemini response candidate had no content");
  }
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) {
    throw new ProviderApiError("gemini response candidate had no parts");
  }
  for (const part of parts) {
    if (part === null || typeof part !== "object") continue;
    const item = part as { text?: unknown; functionCall?: unknown };
    if (typeof item.text === "string") {
      return { kind: "text", text: item.text };
    }
    if (item.functionCall !== undefined) {
      const call = item.functionCall;
      if (call === null || typeof call !== "object" || Array.isArray(call)) {
        throw new ProviderApiError("gemini tool call shape was invalid");
      }
      const callItem = call as { name?: unknown; args?: unknown; id?: unknown; thoughtSignature?: unknown };
      if (typeof callItem.name !== "string") {
        throw new ProviderApiError("gemini tool call had no name");
      }
      const args = callItem.args ?? {};
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        throw new ProviderApiError("gemini tool call arguments were invalid");
      }
      return {
        kind: "tool_call",
        name: callItem.name,
        arguments: args,
        ...(typeof callItem.id === "string" && { id: callItem.id }),
        ...(typeof callItem.thoughtSignature === "string" && { thoughtSignature: callItem.thoughtSignature }),
      };
    }
  }
  throw new ProviderApiError("gemini response contained no usable part");
}