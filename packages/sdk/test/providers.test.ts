// provider adapter tests. these never hit a real api: global fetch is
// stubbed with fixture responses shaped like each provider's real wire
// format, so the adapter parsing logic is verified against both
// anthropic's and openai's actual response shapes.
import { describe, expect, it, vi } from "vitest";
import {
  AnthropicClient,
  GeminiClient,
  OpenAiClient,
  OpenAiCompatibleClient,
  createProviderClient,
} from "../src/index.js";
import type { ProviderMessage } from "../src/index.js";
import { geminiConfigFixture, openAiCompatibleConfigFixture, sampleConfigFixture } from "./fixtures.js";

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

// like stubFetch but records the request the adapter made, so tests can
// assert on the exact url, headers, and body (including key-absence).
function stubCapturingFetch(body: unknown, ok = true, status = 200) {
  const mock = vi.fn(async () => ({
    ok,
    status,
    async json() {
      return body;
    },
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
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

describe("gemini adapter", () => {
  it("parses a text response", async () => {
    stubFetch({ candidates: [{ content: { parts: [{ text: "hello from gemini" }] } }] });
    const client = new GeminiClient("sk-gem-test");
    const result = await client.complete(
      [{ role: "user", content: "hi" }],
      abortController.signal,
      geminiConfigFixture,
    );
    expect(result).toEqual({ kind: "text", text: "hello from gemini" });
    vi.unstubAllGlobals();
  });

  it("parses a functionCall response and passes id/thoughtSignature through", async () => {
    stubFetch({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "add", args: { a: 1, b: 2 }, id: "call_gc_1", thoughtSignature: "sig_1" },
              },
            ],
          },
        },
      ],
    });
    const client = new GeminiClient("sk-gem-test");
    const result = await client.complete(
      [{ role: "user", content: "add" }],
      abortController.signal,
      geminiConfigFixture,
    );
    expect(result).toEqual({
      kind: "tool_call",
      name: "add",
      arguments: { a: 1, b: 2 },
      id: "call_gc_1",
      thoughtSignature: "sig_1",
    });
    vi.unstubAllGlobals();
  });

  it("maps the loop's structured history to a valid functionCall/functionResponse round trip", async () => {
    // the exact message list the run loop feeds after one tool turn, with
    // the gemini 3 id/thoughtSignature passthrough (see run-loop.ts). the
    // body pinned here is the api-valid multi-turn contents shape.
    const history: ProviderMessage[] = [
      { role: "user", content: "add 1 and 2" },
      {
        role: "assistant",
        content: "call add",
        toolCall: { name: "add", arguments: { a: 1, b: 2 }, id: "call_gc_1", thoughtSignature: "sig_1" },
      },
      { role: "user", content: '{"sum":3}', name: "add", toolCallId: "call_gc_1", thoughtSignature: "sig_1" },
    ];
    const fetchMock = stubCapturingFetch({
      candidates: [{ content: { parts: [{ text: "done" }] } }],
    });

    const client = new GeminiClient("sk-gem-test");
    const result = await client.complete(history, abortController.signal, geminiConfigFixture);

    expect(result).toEqual({ kind: "text", text: "done" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    const sent = JSON.parse((init as { body: string }).body);
    expect(sent).toEqual({
      contents: [
        { role: "user", parts: [{ text: "add 1 and 2" }] },
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "add", args: { a: 1, b: 2 }, id: "call_gc_1", thoughtSignature: "sig_1" },
            },
          ],
        },
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "add",
                response: { output: '{"sum":3}' },
                id: "call_gc_1",
                thoughtSignature: "sig_1",
              },
            },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: "add",
              description: "add two numbers",
              parameters: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
                additionalProperties: false,
              },
            },
          ],
        },
      ],
    });
    vi.unstubAllGlobals();
  });

  it("throws ProviderApiError on no candidates", async () => {
    stubFetch({ candidates: [] });
    const client = new GeminiClient("sk-gem-test");
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, geminiConfigFixture),
    ).rejects.toThrow(/gemini response had no candidates/);
    vi.unstubAllGlobals();
  });

  it("throws ProviderApiError on a non-2xx status", async () => {
    stubFetch({ error: { message: "rate limited" } }, false, 429);
    const client = new GeminiClient("sk-gem-test");
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, geminiConfigFixture),
    ).rejects.toThrow(/gemini api error 429/);
    vi.unstubAllGlobals();
  });

  it("the api key never appears in the request body or the error messages", async () => {
    const fetchMock = stubCapturingFetch({
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
    });
    const client = new GeminiClient("sk-gemini-secret-key");
    await client.complete([{ role: "user", content: "hi" }], abortController.signal, geminiConfigFixture);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init as { headers: Record<string, string>; body: string };
    // the key travels only in the x-goog-api-key header, never in the body
    // (the body is what would be captured as evidence or logged).
    expect(headers.headers["x-goog-api-key"]).toBe("sk-gemini-secret-key");
    expect(headers.body).not.toContain("sk-gemini-secret-key");

    // the same invariant holds on the failure path: the thrown message is
    // the provider label + status, never the key.
    stubFetch({ error: { message: "nope" } }, false, 429);
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, geminiConfigFixture),
    ).rejects.toThrow(/gemini api error 429/);
    vi.unstubAllGlobals();
  });
});

describe("openai-compatible adapter", () => {
  it("parses a text response and normalizes a bare base url to chat/completions", async () => {
    const fetchMock = stubCapturingFetch({
      choices: [{ message: { role: "assistant", content: "hello from compat" } }],
    });
    const client = new OpenAiCompatibleClient("sk-comp-test", "https://compat.example/v1");
    const result = await client.complete(
      [{ role: "user", content: "hi" }],
      abortController.signal,
      openAiCompatibleConfigFixture,
    );
    expect(result).toEqual({ kind: "text", text: "hello from compat" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://compat.example/v1/chat/completions");
    vi.unstubAllGlobals();
  });

  it("keeps an already-complete chat/completions base url verbatim", async () => {
    const fetchMock = stubCapturingFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const client = new OpenAiCompatibleClient("sk-comp-test", "https://compat.example/v1/chat/completions");
    await client.complete(
      [{ role: "user", content: "hi" }],
      abortController.signal,
      openAiCompatibleConfigFixture,
    );
    expect(fetchMock.mock.calls[0][0]).toBe("https://compat.example/v1/chat/completions");
    vi.unstubAllGlobals();
  });

  it("parses a tool_call response", async () => {
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
    const client = new OpenAiCompatibleClient("sk-comp-test", "https://compat.example/v1");
    const result = await client.complete(
      [{ role: "user", content: "add" }],
      abortController.signal,
      openAiCompatibleConfigFixture,
    );
    expect(result).toEqual({ kind: "tool_call", name: "add", arguments: { a: 1, b: 2 } });
    vi.unstubAllGlobals();
  });

  it("throws ProviderApiError on a non-2xx status with a provider-specific label", async () => {
    stubFetch({ error: { message: "rate limited" } }, false, 429);
    const client = new OpenAiCompatibleClient("sk-comp-test", "https://compat.example/v1");
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, openAiCompatibleConfigFixture),
    ).rejects.toThrow(/openai-compatible api error 429/);
    vi.unstubAllGlobals();
  });

  it("throws ProviderApiError on a malformed response", async () => {
    stubFetch({ choices: [] });
    const client = new OpenAiCompatibleClient("sk-comp-test", "https://compat.example/v1");
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, openAiCompatibleConfigFixture),
    ).rejects.toThrow(/openai-compatible response had no choices/);
    vi.unstubAllGlobals();
  });

  it("the api key never appears in the request body or the error messages", async () => {
    const fetchMock = stubCapturingFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const client = new OpenAiCompatibleClient("sk-compat-secret-key", "https://compat.example/v1");
    await client.complete([{ role: "user", content: "hi" }], abortController.signal, openAiCompatibleConfigFixture);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init as { headers: Record<string, string>; body: string };
    // the key travels only in the authorization header, never in the body.
    expect(headers.headers.authorization).toBe("Bearer sk-compat-secret-key");
    expect(headers.body).not.toContain("sk-compat-secret-key");

    stubFetch({ error: { message: "nope" } }, false, 429);
    await expect(
      client.complete([{ role: "user", content: "hi" }], abortController.signal, openAiCompatibleConfigFixture),
    ).rejects.toThrow(/openai-compatible api error 429/);
    vi.unstubAllGlobals();
  });
});

describe("createProviderClient factory", () => {
  it("fails closed on an unknown provider", () => {
    expect(() =>
      createProviderClient({ ...sampleConfigFixture, provider: "wat" as never }, "k"),
    ).toThrow(/unsupported provider/);
  });

  it("returns a GeminiClient for provider gemini", () => {
    expect(createProviderClient(geminiConfigFixture, "k")).toBeInstanceOf(GeminiClient);
  });

  it("requires config.baseUrl for openai-compatible", () => {
    const { baseUrl: _removed, ...noBaseUrl } = openAiCompatibleConfigFixture;
    void _removed;
    expect(() => createProviderClient(noBaseUrl, "k")).toThrow(/requires config.baseUrl/);
  });

  it("rejects a non-url or non-http(s) baseUrl", () => {
    expect(() =>
      createProviderClient({ ...openAiCompatibleConfigFixture, baseUrl: "not a url" }, "k"),
    ).toThrow(/not a valid url/);
    expect(() =>
      createProviderClient({ ...openAiCompatibleConfigFixture, baseUrl: "ftp://example.com/v1" }, "k"),
    ).toThrow(/must be an http\(s\) url/);
  });

  it("constructs an openai-compatible client pointed at the normalized endpoint", async () => {
    const fetchMock = stubCapturingFetch({
      choices: [{ message: { role: "assistant", content: "ok" } }],
    });
    const client = createProviderClient(
      { ...openAiCompatibleConfigFixture, baseUrl: "https://api.deepseek.com/v1" },
      "k",
    );
    expect(client).toBeInstanceOf(OpenAiCompatibleClient);
    await client.complete(
      [{ role: "user", content: "hi" }],
      abortController.signal,
      openAiCompatibleConfigFixture,
    );
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/chat/completions");
    vi.unstubAllGlobals();
  });
});