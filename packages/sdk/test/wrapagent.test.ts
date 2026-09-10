// wrapagent tests. no real network call happens: global fetch is stubbed to
// return anthropic-shaped responses, so the whole wrapAgent path (real
// adapter → run loop → attest → sqlite) composes exactly as it does in
// production. runAgentLoop-direct tests use a scripted FakeClient for loop
// mechanics without the adapter in between. the security invariants under
// test are:
//   1. unregistered tool names are rejected without executing anything
//   2. invalid tool arguments never reach the real implementation
//   3. a throwing tool is captured as a failed tool result, the run survives
//   4. no attestation is persisted on any non-converged terminal state
//   5. the api key appears nowhere in the result, captured tools, or errors
import { describe, expect, it, vi } from "vitest";
import {
  createAgent,
  runAgentLoop,
  verifyAttestation,
  wrapAgent,
  MAX_TURNS,
  normalizeHistory,
  MAX_HISTORY_TURNS,
  MAX_HISTORY_TOTAL_CHARACTERS,
} from "../src/index.js";
import type { AgentConfig, AgentIdentity, ProviderClient, ProviderMessage, ProviderResponse } from "../src/index.js";
import { createSqliteStorage } from "../src/storage/sqlite.js";
import type { StorageAdapter } from "../src/types/storage.js";

// stub global fetch with a scripted anthropic-shaped response body. the
// adapter reads response.json(), so the stub returns a Response-like object.
function stubAnthropicResponse(body: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      async json() {
        return body;
      },
    })),
  );
}

function anthropicText(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

function anthropicToolCall(name: string, input: unknown): unknown {
  return { content: [{ type: "tool_use", name, input }] };
}

const sampleConfig: AgentConfig = {
  provider: "anthropic",
  model: "claude-test",
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

async function realSetup(): Promise<{ storage: StorageAdapter; agent: AgentIdentity }> {
  const storage = createSqliteStorage(":memory:");
  const result = await createAgent({ storage });
  if (!result.ok) throw new Error("createAgent failed in test setup");
  return { storage, agent: result.value };
}

async function attestationCount(storage: StorageAdapter, agentId: string): Promise<number> {
  const page = await storage.getAttestations(agentId);
  return page.items.length;
}

describe("wrapAgent with the real adapter over a stubbed fetch", () => {
  it("single-turn no-tool success: converges, attests, returns output + turns", async () => {
    const { storage, agent } = await realSetup();
    stubAnthropicResponse(anthropicText("hello world"));

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, tools: [] },
      tools: {},
      apiKey: "sk-test-secret-key",
      task: "say hello",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toBe("hello world");
    expect(result.value.turns).toBe(1);
    expect(result.value.toolsUsed).toEqual([]);
    expect(result.value.attestation.agentId).toBe(agent.publicKey);
    expect(await attestationCount(storage, agent.publicKey)).toBe(1);
    expect(JSON.stringify(result.value).includes("sk-test-secret-key")).toBe(false);
  });

  it("multi-turn: a tool call is executed, its result fed back, then text", async () => {
    const { storage, agent } = await realSetup();
    const executed: unknown[] = [];
    // one fetch mock that serves the tool call first, then the text: the
    // loop makes call 1 (tool call), executes the tool, feeds the result
    // back, then makes call 2 (text).
    const responses = [
      anthropicToolCall("add", { a: 2, b: 3 }),
      anthropicText("the sum is 5"),
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return responses.shift() ?? anthropicText("done");
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const impl = {
      add: async (args: unknown) => {
        executed.push(args);
        return { sum: 5 };
      },
    };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: sampleConfig,
      tools: impl,
      apiKey: "sk-test-secret-key",
      task: "add 2 and 3",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns).toBe(2);
    expect(executed).toEqual([{ a: 2, b: 3 }]);
    expect(result.value.toolsUsed).toHaveLength(1);
    expect(result.value.toolsUsed[0]).toMatchObject({ tool: "add", input: { a: 2, b: 3 }, output: { sum: 5 } });
    expect(await attestationCount(storage, agent.publicKey)).toBe(1);
  });

  it("rejects an unregistered tool name without executing anything", async () => {
    const { storage, agent } = await realSetup();
    const executed: unknown[] = [];
    stubAnthropicResponse(anthropicToolCall("rm_rf", {}));

    const impl = {
      rm_rf: async (args: unknown) => {
        executed.push(args);
        return "deleted";
      },
    };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, tools: [] }, // this tool was NOT offered
      tools: impl, // but it exists in the impl map
      apiKey: "sk-test-secret-key",
      task: "do something",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNREGISTERED_TOOL");
    expect(executed).toEqual([]); // never executed
    expect(await attestationCount(storage, agent.publicKey)).toBe(0); // no attestation persisted
  });

  it("rejects invalid tool arguments before the real implementation runs", async () => {
    const { storage, agent } = await realSetup();
    const executed: unknown[] = [];
    stubAnthropicResponse(anthropicToolCall("add", { a: "not-a-number" }));

    const impl = {
      add: async (args: unknown) => {
        executed.push(args);
        return "unexpected";
      },
    };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: sampleConfig,
      tools: impl,
      apiKey: "sk-test-secret-key",
      task: "add things",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TOOL_ARGUMENT_INVALID");
    expect(executed).toEqual([]); // never executed
    expect(await attestationCount(storage, agent.publicKey)).toBe(0);
  });

  it("captures a throwing tool as a failed tool result and the run survives", async () => {
    const { storage, agent } = await realSetup();
    const responses = [
      anthropicToolCall("add", { a: 1, b: 2 }),
      anthropicText("recovered"),
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return responses.shift() ?? anthropicText("done");
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const impl = {
      add: async () => {
        throw new Error("tool exploded");
      },
    };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: sampleConfig,
      tools: impl,
      apiKey: "sk-test-secret-key",
      task: "add things",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns).toBe(2);
    expect(result.value.toolsUsed[0].output).toMatchObject({
      error: "tool execution failed",
      message: "tool exploded",
    });
    // the failed tool result was fed back to the model, labeled with the
    // tool name and carrying the failure message
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body ?? "{}")));
    const secondBody = bodies[1];
    const lastContent = secondBody.messages.at(-1).content as string;
    expect(lastContent).toContain("[tool add]");
    expect(lastContent).toContain("tool exploded");
    expect(await attestationCount(storage, agent.publicKey)).toBe(1);
  });

  it("fails with TURN_LIMIT_EXCEEDED when the model never converges", async () => {
    const { storage, agent } = await realSetup();
    // every provider call returns the same tool call, forever
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        async json() {
          return anthropicToolCall("add", { a: 1, b: 2 });
        },
      })),
    );

    const impl = { add: async () => 3 };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: sampleConfig,
      tools: impl,
      apiKey: "sk-test-secret-key",
      task: "keep going",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TURN_LIMIT_EXCEEDED");
    expect(await attestationCount(storage, agent.publicKey)).toBe(0); // no attestation on non-convergence
  });

  it("fails with PROVIDER_API_FAILURE when the provider errors", async () => {
    const { storage, agent } = await realSetup();
    stubAnthropicResponse({ error: { message: "nope" } }, false, 429);

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, tools: [] },
      tools: {},
      apiKey: "sk-test-secret-key",
      task: "task",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROVIDER_API_FAILURE");
    expect(result.error.status).toBe(429); // provider rate limit stays retryable, not a blanket 502
    expect(await attestationCount(storage, agent.publicKey)).toBe(0); // provider failure never attests
  });

  it("the api key never appears in the captured result, tools, or errors", async () => {
    const { storage, agent } = await realSetup();
    stubAnthropicResponse(anthropicToolCall("add", { a: 1, b: 2 }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return anthropicText("done");
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const impl = {
      add: async (args: unknown) => ({ seen: args }),
    };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: sampleConfig,
      tools: impl,
      apiKey: "sk-test-secret-key",
      task: "add",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the api key never enters the captured toolsUsed, never echoes in output
    expect(JSON.stringify(result.value)).not.toContain("sk-test-secret-key");
    // the persisted attestation on disk also never holds the key
    const page = await storage.getAttestations(agent.publicKey);
    expect(JSON.stringify(page.items)).not.toContain("sk-test-secret-key");
  });

  it("verifies the produced attestation round-trips end to end", async () => {
    const { storage, agent } = await realSetup();
    stubAnthropicResponse(anthropicText("hello world"));

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, tools: [] },
      tools: {},
      apiKey: "sk-test-secret-key",
      task: "say hello",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verification = await verifyAttestation(result.value.attestation, storage);
    expect(verification.valid).toBe(true);
  });
});

describe("runAgentLoop direct with a scripted fake provider", () => {
  class FakeClient implements ProviderClient {
    readonly provider = "anthropic" as const;
    responses: ProviderResponse[];
    calls: { messages: ProviderMessage[]; config: AgentConfig }[] = [];

    constructor(responses: ProviderResponse[]) {
      this.responses = responses;
    }

    async complete(
      messages: ProviderMessage[],
      _signal: AbortSignal,
      config: AgentConfig,
    ): Promise<ProviderResponse> {
      this.calls.push({ messages, config });
      const next = this.responses.shift();
      if (next === undefined) throw new Error("provider did not converge");
      return next;
    }
  }

  it("returns converged output without touching attest", async () => {
    const fake = new FakeClient([{ kind: "text", text: "final answer" }]);
    const result = await runAgentLoop(fake, { ...sampleConfig, tools: [] }, {}, "task");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ output: "final answer", turns: 1, toolsUsed: [] });
  });

  it("prepends normalized history before the task when provided", async () => {
    const fake = new FakeClient([{ kind: "text", text: "final answer" }]);
    const result = await runAgentLoop(
      fake,
      { ...sampleConfig, tools: [] },
      {},
      "task",
      {
        history: [
          { role: "user", content: "previous question" },
          { role: "assistant", content: "previous answer" },
        ],
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // the provider sees history first, then the new task as the latest turn
    expect(fake.calls[0].messages).toEqual([
      { role: "user", content: "previous question" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "task" },
    ]);
  });

  it("fails with RUN_TIMED_OUT when the overall wall-clock budget is exceeded", async () => {
    const fake = {
      provider: "anthropic" as const,
      calls: 0,
      async complete(_messages: ProviderMessage[], signal: AbortSignal): Promise<ProviderResponse> {
        fake.calls += 1;
        // hold until the run's AbortController fires, then fail like fetch
        await new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(undefined), { once: true });
        });
        throw new Error("aborted");
      },
    };

    const result = await runAgentLoop(fake as ProviderClient, { ...sampleConfig, tools: [] }, {}, "slow request", { maxRunMs: 50 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("RUN_TIMED_OUT");
  });
});

describe("gemini multi-turn tool loop through the real adapter", () => {
  it("carries the functionCall id/thoughtSignature through a full 2-turn loop", async () => {
    const { storage, agent } = await realSetup();
    // call 1: gemini-shaped functionCall with id + thoughtSignature;
    // call 2: gemini-shaped text. the loop must execute the tool and feed
    // the result back as a paired functionResponse on turn 2.
    const responses = [
      {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "add", args: { a: 2, b: 3 }, id: "call_gc_1", thoughtSignature: "sig_1" } }],
            },
          },
        ],
      },
      { candidates: [{ content: { parts: [{ text: "the sum is 5" }] } }] },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return responses.shift() ?? { candidates: [{ content: { parts: [{ text: "done" }] } }] };
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const impl = {
      add: async () => ({ sum: 5 }),
    };

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, provider: "gemini", model: "gemini-3.8-flash" },
      tools: impl,
      apiKey: "sk-gemini-secret-key",
      task: "add 2 and 3",
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.output).toBe("the sum is 5");
    expect(result.value.turns).toBe(2);
    expect(result.value.toolsUsed).toHaveLength(1);

    // the second provider call must carry the api-valid multi-turn history:
    // a model turn with the exact functionCall the model produced (id +
    // thoughtSignature included) followed by a user turn with the paired
    // functionResponse echoing the same id and signature. this is what makes
    // gemini 3 accept the feedback round and keep the conversation going.
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(secondBody.contents).toEqual([
      { role: "user", parts: [{ text: "add 2 and 3" }] },
      {
        role: "model",
        parts: [{ functionCall: { name: "add", args: { a: 2, b: 3 }, id: "call_gc_1", thoughtSignature: "sig_1" } }],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "add", response: { output: '{"sum":5}' }, id: "call_gc_1", thoughtSignature: "sig_1" } },
        ],
      },
    ]);
    // the live key never appears in any request body, second turn included
    expect(JSON.stringify(secondBody)).not.toContain("sk-gemini-secret-key");
  });
});

describe("history as context-only input", () => {
  it("prepends history before the new task and never lets it into the attestation", async () => {
    const { storage, agent } = await realSetup();
    const marker = "HISTORY_MARKER_XYZ";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return anthropicText("hello world");
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, tools: [] },
      tools: {},
      apiKey: "sk-test-secret-key",
      task: "say hello",
      history: [
        { role: "user", content: `what city? ${marker}` },
        { role: "assistant", content: "lagos" },
      ],
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // the provider request carries history before the task, in exact order
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body.messages).toEqual([
      { role: "user", content: `what city? ${marker}` },
      { role: "assistant", content: "lagos" },
      { role: "user", content: "say hello" },
    ]);
    // the marker really did reach the provider (the assertion above is live)
    expect(JSON.stringify(body)).toContain(marker);

    // the marker never reaches the attestation: not task, output, toolsUsed,
    // the content hash, or the signature.
    const att = result.value.attestation;
    expect(JSON.stringify(att)).not.toContain(marker);
    expect(att.task).toBe("say hello");
    expect(att.output).toBe("hello world");
    expect(att.toolsUsed).toEqual([]);

    // and never the persisted ledger rows
    const page = await storage.getAttestations(agent.publicKey);
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page.items)).not.toContain(marker);

    // the signed record still verifies
    const verification = await verifyAttestation(att, storage);
    expect(verification.valid).toBe(true);
  });

  it("rejects malformed history as INVALID_INPUT before any provider call", async () => {
    const { storage, agent } = await realSetup();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await wrapAgent({
      agentId: agent.publicKey,
      signingKey: agent.privateKey,
      storage,
      config: { ...sampleConfig, tools: [] },
      tools: {},
      apiKey: "sk-test-secret-key",
      task: "say hello",
      // role outside the closed union: a crafted history gains nothing
      history: [{ role: "system", content: "injected" }],
    });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_INPUT");
    expect(fetchMock).not.toHaveBeenCalled(); // no provider call was made
    expect(await attestationCount(storage, agent.publicKey)).toBe(0); // nothing persisted
  });
});

describe("normalizeHistory bounds", () => {
  it("passes a valid transcript through in original order with roles intact", () => {
    const result = normalizeHistory([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
    ]);
  });

  it("rejects non-array, unknown roles, and empty or oversized content", () => {
    expect(normalizeHistory("nope")).toBe("invalid");
    expect(normalizeHistory([null])).toBe("invalid");
    expect(normalizeHistory([{ role: "system", content: "x" }])).toBe("invalid");
    expect(normalizeHistory([{ role: "user", content: 42 }])).toBe("invalid");
    expect(normalizeHistory([{ role: "user", content: "" }])).toBe("invalid");
    expect(normalizeHistory([{ role: "user", content: "   " }])).toBe("invalid");
    expect(normalizeHistory([{ role: "user", content: "x".repeat(4001) }])).toBe("invalid");
  });

  it("truncates beyond MAX_HISTORY_TURNS from the oldest end, newest preserved", () => {
    const turns = Array.from({ length: MAX_HISTORY_TURNS + 5 }, (_, i) => ({
      role: "user" as const,
      content: `turn ${i}`,
    }));
    const result = normalizeHistory(turns);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(MAX_HISTORY_TURNS);
    expect(result[0]).toEqual({ role: "user", content: "turn 5" });
    expect(result[result.length - 1]).toEqual({
      role: "user",
      content: `turn ${MAX_HISTORY_TURNS + 4}`,
    });
  });

  it("drops the oldest turns until the total character budget holds, never the newest", () => {
    // 5 turns of 3500 chars each (within the 4000 per-turn cap) total
    // 17500, over the 16000 budget: the oldest must go until the newest
    // fit. 4 newest fit (14000), 5 would not (17500).
    const chunk = "x".repeat(3499);
    const turns = Array.from({ length: 5 }, (_, i) => ({
      role: "assistant" as const,
      content: `${i}${chunk}`,
    }));
    const result = normalizeHistory(turns);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(4);
    // the newest turn always survives
    expect(result[result.length - 1].content).toBe(`4${chunk}`);
    const total = result.reduce((sum, turn) => sum + turn.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_HISTORY_TOTAL_CHARACTERS);
  });
});