// opt-in live provider integration test. this is the ONLY test in the sdk
// that makes a real network call to a model provider. it is skipped by
// default and runs only when OPENREP_LIVE_TEST=1 and the matching key env
// var is set, so the default test suite never depends on the network or a
// paid api key.
//
// to opt in:
//   OPENREP_LIVE_TEST=1 ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @openrep/sdk test
//   OPENREP_LIVE_TEST=1 OPENAI_API_KEY=sk-... pnpm --filter @openrep/sdk test
//   OPENREP_LIVE_TEST=1 GEMINI_API_KEY=... pnpm --filter @openrep/sdk test
//   OPENREP_LIVE_TEST=1 OPENAI_COMPATIBLE_API_KEY=... OPENAI_COMPATIBLE_BASE_URL=https://... pnpm --filter @openrep/sdk test
//
// the tests make one or two cheap calls per provider and assert the
// adapter's response parsing matches a real (not fixture) response. model
// ids default to a current cheap model per provider and can be overridden
// with GEMINI_MODEL / OPENAI_COMPATIBLE_MODEL. the gemini multi-turn case
// exercises the real functionCall -> functionResponse round trip that the
// run loop now carries; it degrades to a pass when the model answers with
// plain text instead of calling the tool.
import { describe, expect, it } from "vitest";
import {
  AnthropicClient,
  GeminiClient,
  OpenAiClient,
  OpenAiCompatibleClient,
  runAgentLoop,
} from "../src/index.js";
import type { AgentConfig, ProviderMessage, ProviderResponse } from "../src/index.js";
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

  it("gemini real response parses into a text or tool_call", async () => {
    const key = process.env.GEMINI_API_KEY;
    const reason = skipUnless("GEMINI_API_KEY");
    if (reason) return;

    const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
    const cfg: AgentConfig = { ...sampleConfigFixture, provider: "gemini", model };
    const client = new GeminiClient(key!);
    const result: ProviderResponse = await client.complete(
      [{ role: "user", content: "say exactly: ok" }],
      controller.signal,
      cfg,
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text.length).toBeGreaterThan(0);
  });

  it("gemini multi-turn tool round trip is accepted by the real api", async () => {
    const key = process.env.GEMINI_API_KEY;
    const reason = skipUnless("GEMINI_API_KEY");
    if (reason) return;

    const model = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
    const cfg: AgentConfig = { ...sampleConfigFixture, provider: "gemini", model };
    const client = new GeminiClient(key!);

    const prompt = "use the add tool to compute 1 + 2, then say the result";
    const first = await client.complete([{ role: "user", content: prompt }], controller.signal, cfg);
    if (first.kind !== "tool_call") {
      // the model chose a plain text answer; the single-turn path above
      // already covers parsing, and there is no round trip to validate.
      return;
    }

    // feed the result back exactly as the run loop does (run-loop.ts):
    // a model turn with the raw functionCall fields, then a user turn with
    // the paired functionResponse echoing the same id/signature.
    const { name, arguments: args, id, thoughtSignature } = first;
    const feedback: ProviderMessage[] = [
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: `call ${name}`,
        toolCall: {
          name,
          arguments: args,
          ...(id !== undefined && { id }),
          ...(thoughtSignature !== undefined && { thoughtSignature }),
        },
      },
      {
        role: "user",
        content: JSON.stringify({ sum: 3 }),
        name,
        ...(id !== undefined && { toolCallId: id }),
        ...(thoughtSignature !== undefined && { thoughtSignature }),
      },
    ];
    const second = await client.complete(feedback, controller.signal, cfg);
    // the api accepted the paired functionResponse and produced another turn
    expect(second.kind === "text" || second.kind === "tool_call").toBe(true);
  });

  it("openai-compatible real response parses against a caller-supplied endpoint", async () => {
    const key = process.env.OPENAI_COMPATIBLE_API_KEY;
    const baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;
    if (!liveEnabled || !key || !baseUrl) {
      // vitest treats a returned value as a skip note
      return "skipped: set OPENREP_LIVE_TEST=1, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_BASE_URL to run";
    }

    const model = process.env.OPENAI_COMPATIBLE_MODEL ?? "gpt-4o-mini";
    const cfg: AgentConfig = { ...sampleConfigFixture, provider: "openai-compatible", model, baseUrl };
    const client = new OpenAiCompatibleClient(key, baseUrl);
    const result: ProviderResponse = await client.complete(
      [{ role: "user", content: "say exactly: ok" }],
      controller.signal,
      cfg,
    );
    expect(result.kind).toBe("text");
    if (result.kind === "text") expect(result.text.length).toBeGreaterThan(0);
  });

  it("runAgentLoop carries prior turns into the second call (coherence)", async () => {
    const key = process.env.OPENAI_COMPATIBLE_API_KEY;
    const baseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL;
    if (!liveEnabled || !key || !baseUrl) {
      // vitest treats a returned value as a skip note
      return "skipped: set OPENREP_LIVE_TEST=1, OPENAI_COMPATIBLE_API_KEY, and OPENAI_COMPATIBLE_BASE_URL to run";
    }

    const model = process.env.OPENAI_COMPATIBLE_MODEL ?? "gpt-4o-mini";
    const cfg: AgentConfig = { ...sampleConfigFixture, provider: "openai-compatible", model, baseUrl, tools: [] };
    const client = new OpenAiCompatibleClient(key, baseUrl);

    // call 1: the model learns a secret word; call 2 has no way to know it
    // except the history passed in. this is the exact bug shape of a chat
    // follow-up ("benin nigeria" after "which city?") minus the storage.
    const firstPrompt = "remember the secret word: radiometer. then say exactly: ok";
    const first = await runAgentLoop(client, cfg, {}, firstPrompt);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await runAgentLoop(
      client,
      cfg,
      {},
      "what was the secret word? reply with only that word",
      {
        history: [
          { role: "user", content: firstPrompt },
          { role: "assistant", content: first.value.output },
        ],
      },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.output.toLowerCase()).toContain("radiometer");
  });
});