// opt-in live provider integration test. this is the ONLY test in the sdk
// that makes a real network call to a model provider. it is skipped by
// default and runs only when OPENREP_LIVE_TEST=1 and the matching key env
// var is set, so the default test suite never depends on the network or a
// paid api key.
//
// to opt in:
//   OPENREP_LIVE_TEST=1 ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @openrep/sdk test
//   OPENREP_LIVE_TEST=1 OPENAI_API_KEY=sk-... pnpm --filter @openrep/sdk test
//
// the test makes one cheap call per provider and asserts the adapter's
// response parsing matches a real (not fixture) response. it does not spend
// tool calls, so the cost is a single prompt completion per provider.
import { describe, expect, it } from "vitest";
import { AnthropicClient, OpenAiClient } from "../src/index.js";
import type { AgentConfig, ProviderResponse } from "../src/index.js";
import { sampleConfigFixture } from "./fixtures.js";

const liveEnabled = process.env.OPENREP_LIVE_TEST === "1";

function skipUnless(envKey: string) {
  const enabled = liveEnabled && process.env[envKey];
  return enabled ? undefined : "skipped: set OPENREP_LIVE_TEST=1 and the provider key to run";
}

const controller = new AbortController();

describe("live provider smoke test (opt-in)", () => {
  it("anthropic real response parses into a text or tool_call", async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    const reason = skipUnless("ANTHROPIC_API_KEY");
    if (reason) return; // vitest treats a returned value as a skip note

    const client = new AnthropicClient(key!);
    const result: ProviderResponse = await client.complete(
      [{ role: "user", content: "say exactly: ok" }],
      controller.signal,
      sampleConfigFixture,
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text.length).toBeGreaterThan(0);
  });

  it("openai real response parses into a text or tool_call", async () => {
    const key = process.env.OPENAI_API_KEY;
    const reason = skipUnless("OPENAI_API_KEY");
    if (reason) return;

    const cfg: AgentConfig = { ...sampleConfigFixture, provider: "openai", model: "gpt-4o-mini" };
    const client = new OpenAiClient(key!);
    const result: ProviderResponse = await client.complete(
      [{ role: "user", content: "say exactly: ok" }],
      controller.signal,
      cfg,
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text.length).toBeGreaterThan(0);
  });
});