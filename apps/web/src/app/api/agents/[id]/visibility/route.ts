import { NextRequest } from "next/server";
import { setVisibility } from "@openrepso/sdk";
import { errorResponse, jsonResponse } from "@/server/error";
import { codedError, readJsonBody, requireSession } from "@/server/http";
import { createRequestContext } from "@/server/storage";

// toggles an agent's leaderboard visibility. ownership is authorized HERE
// (not at the sdk, which stays a dumb storage write): changing visibility is
// an owner-privileged mutation of another's reputation surface, so the same
// session-key ownership gate the chat route relies on applies. a non-owner
// gets the same AGENT_NOT_FOUND a missing agent returns, so private agents
// stay unobservable to strangers.
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const sessionGate = await requireSession(request);
  if ("response" in sessionGate) return sessionGate.response;
  const { session } = sessionGate;

  try {
    const bodyGate = await readJsonBody(request);
    if ("response" in bodyGate) return bodyGate.response;
    const { body } = bodyGate;

    // the value is a closed set {public, private}; anything else (including
    // an absent field) is rejected at the perimeter before any mutation.
    if (body.visibility !== "public" && body.visibility !== "private") {
      return jsonResponse(
        { error: { code: "INVALID_INPUT", message: 'visibility must be "public" or "private"' } },
        400,
      );
    }
    const visibility: "public" | "private" = body.visibility;

    const { id } = await params;
    const context = await createRequestContext();
    try {
      const ownership = await context.storage.getSessionKey(id, session.userId);
      if (ownership === null) {
        return errorResponse(codedError("AGENT_NOT_FOUND", `no agent with id ${id}`));
      }
      const result = await setVisibility(id, visibility, context.storage);
      if (!result.ok) return errorResponse(result.error);
      return jsonResponse({ id, visibility }, 200);
    } finally {
      await context.close();
    }
  } catch (err) {
    return errorResponse(err);
  }
}

// read the current visibility. owner-only, mirroring the PATCH gate: the
// list page's rows already carry it from /api/agents (owned only), but a
// dedicated read keeps the toggle self-contained and consistent.
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
      const ownership = await context.storage.getSessionKey(id, session.userId);
      if (ownership === null) {
        return errorResponse(codedError("AGENT_NOT_FOUND", `no agent with id ${id}`));
      }
      const record = await context.storage.getAgent(id);
      if (record === null) {
        return errorResponse(codedError("AGENT_NOT_FOUND", `no agent with id ${id}`));
      }
      return jsonResponse({ id, visibility: record.visibility }, 200);
    } finally {
      await context.close();
    }
  } catch (err) {
    return errorResponse(err);
  }
}