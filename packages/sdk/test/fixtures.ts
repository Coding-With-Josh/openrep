// shared fixtures for the provider adapter tests.
import type { AgentConfig } from "../src/types/providers.js";

export const sampleConfigFixture: AgentConfig = {
  provider: "anthropic",
  model: "claude-3-5-sonnet-latest",
  tools: [
    {
      name: "add",
      description: "add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
    },
  ],
};

export const openAiConfigFixture: AgentConfig = {
  ...sampleConfigFixture,
  provider: "openai",
  model: "gpt-4o-mini",
};

export const geminiConfigFixture: AgentConfig = {
  ...sampleConfigFixture,
  provider: "gemini",
  model: "gemini-3.8-flash",
};

export const openAiCompatibleConfigFixture: AgentConfig = {
  ...sampleConfigFixture,
  provider: "openai-compatible",
  model: "gpt-4o-mini",
  baseUrl: "https://compat.example/v1",
};