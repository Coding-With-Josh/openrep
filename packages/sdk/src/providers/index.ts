// the single place wrapAgent() branches on provider: selecting from the two
// adapters. the adapters expose a common ProviderClient contract, so no
// provider-specific logic ever lives in the run loop.

import type { AgentConfig, ProviderClient } from "../types/providers.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAiClient } from "./openai.js";
import { ProviderConfigError } from "./errors.js";

export function createProviderClient(config: AgentConfig, apiKey: string): ProviderClient {
  switch (config.provider) {
    case "anthropic":
      return new AnthropicClient(apiKey);
    case "openai":
      return new OpenAiClient(apiKey);
    default: {
      // fail closed: an unknown provider string never silently picks a
      // client or falls through to a default that could send the key
      // somewhere unexpected.
      const never: never = config.provider;
      throw new ProviderConfigError(`unsupported provider ${String(never)}`);
    }
  }
}