// the single place wrapAgent() branches on provider: selecting the adapter.
// the adapters expose a common ProviderClient contract, so no provider-
// specific logic ever lives in the run loop.

import type { AgentConfig, ProviderClient } from "../types/providers.js";
import { AnthropicClient } from "./anthropic.js";
import { GeminiClient } from "./gemini.js";
import { OpenAiClient, OpenAiCompatibleClient, normalizeChatCompletionsBaseUrl } from "./openai.js";
import { ProviderConfigError } from "./errors.js";

export function createProviderClient(config: AgentConfig, apiKey: string): ProviderClient {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicClient(apiKey);
    case "openai":
      return new OpenAiClient(apiKey);
    case "gemini":
      return new GeminiClient(apiKey);
    case "openai-compatible": {
      // baseUrl is required for the compatible tier: the endpoint is not
      // guessed here, because a guessed default could point the api key at
      // an unexpected host. validated before any client is constructed.
      if (typeof config.baseUrl !== "string" || config.baseUrl.length === 0) {
        throw new ProviderConfigError("provider openai-compatible requires config.baseUrl");
      }
      let parsed: URL;
      try {
        parsed = new URL(config.baseUrl);
      } catch {
        throw new ProviderConfigError("provider openai-compatible config.baseUrl is not a valid url");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ProviderConfigError("provider openai-compatible config.baseUrl must be an http(s) url");
      }
      return new OpenAiCompatibleClient(apiKey, normalizeChatCompletionsBaseUrl(config.baseUrl));
    }
    default: {
      // fail closed: an unknown provider string never silently picks a
      // client or falls through to a default that could send the key
      // somewhere unexpected.
      const never: never = config.provider;
      throw new ProviderConfigError(`unsupported provider ${String(never)}`);
    }
  }
}