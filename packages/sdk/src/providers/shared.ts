// shared, provider-agnostic helpers for the anthropic + openai adapters.
// everything here is deliberately free of provider-specific request shapes;
// each adapter owns its own translation below.

import type { ProviderMessage } from "../types/providers.js";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

// json schema shims the provider tool formats both accept. the sdk's
// ToolDefinition.inputSchema is `unknown`, so the adapter only needs to
// forward it as opaque json. no provider-specific schema conversion happens
// here: the model-facing tool contract is the caller's inputSchema verbatim.
export function toolPayload(name: string, description: string, inputSchema: unknown): {
  name: string;
  description: string;
  input_schema: unknown;
} {
  return { name, description, input_schema: inputSchema };
}

// normalize the sdk's ProviderMessage list into a plain string conversation
// for providers whose api accepts string-only content. each message maps
// onto the role the provider understands. tool results are delivered as a
// labeled user turn so the model sees the outcome. providers with no native
// "name" field on user messages (anthropic) get the tool name folded into
// the content so the model still knows which tool produced the result.
export function toTextMessages(messages: ProviderMessage[]): {
  role: "user" | "assistant";
  content: string;
}[] {
  return messages.map((message) => {
    if ("name" in message) {
      return { role: "user", content: `[tool ${message.name}]\n${message.content}` };
    }
    return { role: message.role, content: message.content };
  });
}