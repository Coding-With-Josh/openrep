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

const CHAT_CONFIG: AgentConfig = {
  provider: "openai-compatible",
  baseUrl: "https://api.groq.com/openai/v1",
  model: "openai/gpt-oss-20b",
  tools: [],
};

function mapMessages(
  messages: { role: "user" | "assistant"; content: string; toolsUsed: unknown[]; timestamp: string }[],
) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? ("agent" as const) : ("user" as const),
    content: message.content,
    toolsUsed: message.toolsUsed,
    timestamp: message.timestamp,
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

      const now = new Date().toISOString();
      await context.storage.createChatSession(id, session.userId, now);

      const beforeResult = await getScore(id, context.storage);
      if (!beforeResult.ok) return errorResponse(beforeResult.error);

      const runResult = await wrapAgent({
        agentId: id,
        signingKey: decrypted.value,
        storage: context.storage,
        config: CHAT_CONFIG,
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