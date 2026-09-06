// provider adapter tests. these never hit a real api: global fetch is
// stubbed with fixture responses shaped like each provider's real wire
// format, so the adapter parsing logic is verified against both
// anthropic's and openai's actual response shapes.
import { describe, expect, it, vi } from "vitest";
import { AnthropicClient, OpenAiClient } from "../src/index.js";
import { sampleConfigFixture } from "./fixtures.js";

const abortController = new AbortController();

function stubFetch(response: unknown, ok = true, status = 200) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      async json() {
        return response;
      },
    })),
  );
}

describe("anthropic adapter", () => {
  it("parses a text response", async () => {
    stubFetch({ content: [{ type: "text", text: "hello from claude" }] });
    const client = new AnthropicClient("sk-ant-test");
    const result = await client.complete(
      [{ role: "user", content: "hi" }],
      abortController.signal,
      sampleConfigFixture,
    );
    expect(result).toEqual({ kind: "text", text: "hello from claude" });
    vi.unstubAllGlobals();
  });

  it("parses a tool_use response", async () => {
    stubFetch({
      content: [
        { type: "tool_use", name: "add", input: { a: 1, b: 2 } },
      ],
    });
    const client = new AnthropicClient("sk-ant-test");
    const result = await client.complete(
      [{ role: "user", content: "add" }],
      abortController.signal,
      sampleConfigFixture,
    );
    expect(result).toEqual({ kind: "tool_call", name: "add", arguments: { a: 1, b: 2 } });
    vi.unstubAllGlobals();
  });

  it("throws ProviderApiError on a non-2xx status", async () => {
    stubFetch({ error: { message: "nope" } }, false, 429);
    const client = new AnthropicClient("sk-ant-test");
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, sampleConfigFixture),
    ).rejects.toThrow(/anthropic api error 429/);
    vi.unstubAllGlobals();
  });
});

describe("openai adapter", () => {
  it("parses a text response", async () => {
    stubFetch({
      choices: [{ message: { role: "assistant", content: "hello from gpt" } }],
    });
    const client = new OpenAiClient("sk-open-test");
    const result = await client.complete(
      [{ role: "user", content: "hi" }],
      abortController.signal,
      sampleConfigFixture,
    );
    expect(result).toEqual({ kind: "text", text: "hello from gpt" });
    vi.unstubAllGlobals();
  });

  it("parses a tool_call response (arguments as json string)", async () => {
    stubFetch({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":1,"b":2}' } }],
          },
        },
      ],
    });
    const client = new OpenAiClient("sk-open-test");
    const result = await client.complete(
      [{ role: "user", content: "add" }],
      abortController.signal,
      sampleConfigFixture,
    );
    expect(result).toEqual({ kind: "tool_call", name: "add", arguments: { a: 1, b: 2 } });
    vi.unstubAllGlobals();
  });

  it("throws ProviderApiError on a non-2xx status", async () => {
    stubFetch({ error: { message: "rate limited" } }, false, 429);
    const client = new OpenAiClient("sk-open-test");
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, sampleConfigFixture),
    ).rejects.toThrow(/openai api error 429/);
    vi.unstubAllGlobals();
  });
});