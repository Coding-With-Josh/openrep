import { NextRequest } from "next/server";
import {
  ATTESTATION_LIMITS,
  decryptPrivateKey,
  getScore,
  wrapAgent,
  type AgentConfig,
} from "@openrep/sdk";
import { getServerConfig } from "@/server/config";
import { errorResponse, jsonResponse } from "@/server/error";
import { codedError, readJsonBody, requireSession } from "@/server/http";
import { getRateLimiter } from "@/server/rate-limit";
import { createRequestContext } from "@/server/storage";

// agent system prompt, adapted verbatim from the product brief. the model's
// answers are part of its permanent signed record; the prompt encodes that
// and the openrep reference. only the {{agentName}} placeholder is resolved
// per request, from the agent's own manifest, after the session-key gate.
const AGENT_SYSTEM_PROMPT_TEMPLATE = `You are {{agentName}}, an autonomous agent operating on openrep. Every task you complete and every response you give becomes part of a permanent, cryptographically signed record of your work, this is what builds your reputation. Answer accordingly: be accurate, be direct, and never claim something happened that didn't.

Never use em dashes, anywhere, for any reason. Use commas, periods, or separate sentences instead.

Always write "openrep" in lowercase, never "OpenRep" or "OPENREP," except that every time you write the word "openrep" in your response, wrap it in bold (**openrep**).

If you're asked anything about what openrep is, how it works, why it exists, or how to use it, base your answer on the following reference. Do not improvise beyond it or contradict it:

---
[REFERENCE_START]
# openrep

a platform-agnostic reputation layer for ai agents.

## why it exists

right now every agent framework, chain, and marketplace builds its own siloed trust score. an agent that has proven itself in one ecosystem starts from zero everywhere else. that reputation does not travel.

openrep sits above all of that. any platform can write attestations into it, any platform can read a score out of it. an agent's reputation lives in one place and goes where the agent goes.

## what it does

the core idea is simple: reputation should be based on what an agent actually did, not what it claims.

every agent gets a portable identity, a keypair plus a human readable name like \`beautiful-pig-black.agent\`. the private key stays with the agent. anything signed with it is attributable to that agent and no other.

when an agent completes a real task, that gets signed and logged as an attestation. an attestation is proof of a specific piece of work, with the source that vouched for it. it is not a claim, it is a record.

reputation from other platforms and chains can be ingested and merged into one unified per-agent score, broken down by source. you can see not just that an agent scores well but which ecosystems vouched for it and how each contributed.

you work with it three ways:

- an sdk, for building openrep into your own code
- a cli, for scripting it into pipelines, ci checks, and other tooling without a browser
- a web app, where people can create agents, chat with them, and watch reputation build live

everything here is real and fully built, the identity system, the signing, the attestation ledger, the scoring, the cli, and this chat interface itself. none of it is a stub, a mock, or a demo placeholder. you are a live example of it working.

[LAYOUT]
packages/sdk     core library
packages/cli     command line interface
apps/web         next.js web app
[REFERENCE_END]
---

Do not paraphrase this into different claims. Do not mention that this is a "reference document" to the user, just answer naturally using it.

Write only the final answer for the user, in markdown where it genuinely helps readability (lists, code blocks, tables), not by default.

If you use a tool, describe the result in plain language, not the mechanics. Never mention tool names, function signatures, internal message roles, or anything about your own runtime.

Don't narrate your own process ("I'll now search for...", "Successfully retrieved..."). Just give the result.

If a task fails, partially completes, or you're not confident in the answer, say so plainly. An honest "I couldn't verify this" is worth more here than a confident guess, your track record is public and permanent.

Keep responses proportional to the question. A short question gets a short answer.`;

function buildSystemPrompt(agentName: string): string {
  return AGENT_SYSTEM_PROMPT_TEMPLATE.replaceAll("{{agentName}}", agentName);
}

const CHAT_CONFIG: AgentConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-20b",
  tools: [],
};

function mapMessages(
  messages: {
    role: "user" | "assistant";
    content: string;
    toolsUsed: unknown[];
    timestamp: string;
    attestationId?: string | null;
  }[],
) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? ("agent" as const) : ("user" as const),
    content: message.content,
    toolsUsed: message.toolsUsed,
    timestamp: message.timestamp,
    attestationId: message.attestationId ?? null,
  }));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sessionGate = await requireSession(request);
  if ("response" in sessionGate) return sessionGate.response;
  const { session } = sessionGate;

  try {
    const limiter = getRateLimiter();
    if (!limiter.allow(`chat:${session.userId}`)) {
      return jsonResponse({ error: { code: "RATE_LIMITED", message: "too many requests, try again shortly" } }, 429);
    }

    const { id } = await params;

    const bodyGate = await readJsonBody(request);
    if ("response" in bodyGate) return bodyGate.response;
    const { body } = bodyGate;
    const rawMessage = body.message;
    if (typeof rawMessage !== "string" || rawMessage.trim().length === 0) {
      return jsonResponse({ error: { code: "INVALID_INPUT", message: "message must be a non-empty string" } }, 400);
    }
    const message = rawMessage.trim();
    if (message.length > ATTESTATION_LIMITS.maxTaskLength) {
      return jsonResponse(
        { error: { code: "INPUT_TOO_LARGE", message: `message exceeds ${ATTESTATION_LIMITS.maxTaskLength} characters` } },
        400,
      );
    }

    const config = getServerConfig();
    if (config.groqApiKey === null) {
      return errorResponse(codedError("MISSING_GROQ_API_KEY", "OPENREP_GROQ_API_KEY is required to run a chat turn"));
    }

    const context = await createRequestContext();
    try {
      const envelope = await context.sessionKeys.get(id, session.userId);
      if (envelope === null) {
        return jsonResponse(
          { error: { code: "MISSING_SESSION", message: "no live session key for this agent" } },
          403,
        );
      }
      const decrypted = decryptPrivateKey(envelope, config.masterEncryptionKey);
      if (!decrypted.ok) {
        return errorResponse(decrypted.error);
      }

      // the session-key gate above confirmed this session owns the agent;
      // reading the manifest here only supplies the agent's own name for the
      // system prompt, never an authorization decision.
      const agentRecord = await context.storage.getAgent(id);
      const agentName = agentRecord?.name ?? "an openrep agent";

      const now = new Date().toISOString();
      await context.storage.createChatSession(id, session.userId, now);

      const beforeResult = await getScore(id, context.storage);
      if (!beforeResult.ok) return errorResponse(beforeResult.error);

      const runResult = await wrapAgent({
        agentId: id,
        signingKey: decrypted.value,
        storage: context.storage,
        config: { ...CHAT_CONFIG, system: buildSystemPrompt(agentName) },
        tools: {},
        apiKey: config.groqApiKey,
        task: message,
      });
      if (!runResult.ok) return errorResponse(runResult.error);

      await context.storage.appendChatMessage({
        agentId: id,
        ownerUserId: session.userId,
        role: "user",
        content: message,
        toolsUsed: [],
        timestamp: now,
      });

      await context.storage.appendChatMessage({
        agentId: id,
        ownerUserId: session.userId,
        role: "assistant",
        content: runResult.value.output,
        toolsUsed: runResult.value.toolsUsed,
        timestamp: new Date().toISOString(),
        // the signed attestation this turn created, so every ai reply can
        // show its own attestation under the bubble, even after reload.
        attestationId: runResult.value.attestation.id,
      });

      const afterResult = await getScore(id, context.storage);
      if (!afterResult.ok) return errorResponse(afterResult.error);

      const stored = await context.storage.getChatMessages(id, session.userId);
      return jsonResponse(
        {
          chatSession: { agentId: id, messages: mapMessages(stored) },
          score: afterResult.value,
          scoreDelta: afterResult.value.composite - beforeResult.value.composite,
          attestation: runResult.value.attestation,
        },
        200,
      );
    } finally {
      await context.close();
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sessionGate = await requireSession(request);
  if ("response" in sessionGate) return sessionGate.response;
  const { session } = sessionGate;

  try {
    const { id } = await params;
    const context = await createRequestContext();
    try {
      const row = await context.storage.getSessionKey(id, session.userId);
      if (row === null) {
        return jsonResponse(
          { error: { code: "MISSING_SESSION", message: "no session key for this agent" } },
          403,
        );
      }
      const stored = await context.storage.getChatMessages(id, session.userId);
      return jsonResponse({ agentId: id, messages: mapMessages(stored) }, 200);
    } finally {
      await context.close();
    }
  } catch (err) {
    return errorResponse(err);
  }
}