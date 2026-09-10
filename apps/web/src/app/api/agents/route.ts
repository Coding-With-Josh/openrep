import { NextRequest } from "next/server";
import {
  createAgent,
  encryptPrivateKey,
  getScore,
  type AgentIdentity,
  type AgentManifest,
} from "@openrepso/sdk";
import { getServerConfig } from "@/server/config";
import { errorResponse, jsonResponse } from "@/server/error";
import { codedError, readJsonBody, requireSession } from "@/server/http";
import { getRateLimiter } from "@/server/rate-limit";
import { createRequestContext } from "@/server/storage";

interface ManifestSource {
  name: string;
  publicKey: string;
  ownerPublicKey: string | null;
  memoryPointer: string | null;
  permissions: AgentManifest["permissions"];
  createdAt: string;
  manifestVersion: number;
  signature: string;
}

function publicManifest(agent: ManifestSource): AgentManifest {
  if (agent.ownerPublicKey === null) {
    throw codedError("OWNER_KEY_MISSING", "agent has no owner key on record");
  }
  return {
    name: agent.name,
    publicKey: agent.publicKey,
    ownerPublicKey: agent.ownerPublicKey,
    memoryPointer: agent.memoryPointer,
    permissions: agent.permissions as AgentManifest["permissions"],
    createdAt: agent.createdAt,
    manifestVersion: agent.manifestVersion,
    signature: agent.signature,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const sessionGate = await requireSession(request);
  if ("response" in sessionGate) return sessionGate.response;
  const { session } = sessionGate;

  try {
    const limiter = getRateLimiter();
    if (!limiter.allow(`user:${session.userId}`)) {
      return jsonResponse({ error: { code: "RATE_LIMITED", message: "too many requests, try again shortly" } }, 429);
    }

    const bodyGate = await readJsonBody(request);
    if ("response" in bodyGate) return bodyGate.response;
    const { body } = bodyGate;

    let name: string | undefined;
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return jsonResponse({ error: { code: "INVALID_INPUT", message: "name must be a non-empty string" } }, 400);
      }
      name = body.name.trim();
    }

    // visibility is a closed set {public, private} enforced at the perimeter:
    // any other value (including mistyped strings) is rejected before the sdk
    // runs, so the leaderboard's public read can never receive a row that a
    // caller smuggled through a laxer spelling. absent => sdk default public.
    let visibility: "public" | "private" | undefined;
    if (body.visibility !== undefined) {
      if (body.visibility !== "public" && body.visibility !== "private") {
        return jsonResponse(
          { error: { code: "INVALID_INPUT", message: 'visibility must be "public" or "private"' } },
          400,
        );
      }
      visibility = body.visibility;
    }

    const context = await createRequestContext();
    try {
      const result = await createAgent({ storage: context.storage, name, visibility });
      if (!result.ok) {
        return errorResponse(result.error);
      }
      const identity = result.value;
      const config = getServerConfig();
      const record = encryptPrivateKey(identity.privateKey, config.masterEncryptionKey, identity.publicKey);
      await context.sessionKeys.set(identity.publicKey, session.userId, record);
      return jsonResponse(publicManifest(identity), 200);
    } finally {
      await context.close();
    }
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const sessionGate = await requireSession(request);
  if ("response" in sessionGate) return sessionGate.response;
  const { session } = sessionGate;

  try {
    const context = await createRequestContext();
    try {
      const owned = await context.storage.listOwnedAgents(session.userId);
      const items = [];
      for (const record of owned) {
        const scoreResult = await getScore(record.publicKey, context.storage);
        if (!scoreResult.ok) return errorResponse(scoreResult.error);
        const row = await context.storage.getSessionKey(record.publicKey, session.userId);
        const sessionStatus = row !== null && row.expiresAtEpochMs > Date.now() ? "active" : "expired";
        items.push({ manifest: publicManifest(record), visibility: record.visibility, score: scoreResult.value, sessionStatus });
      }
      return jsonResponse(items, 200);
    } finally {
      await context.close();
    }
  } catch (err) {
    return errorResponse(err);
  }
}