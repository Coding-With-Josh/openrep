import { NextRequest } from "next/server";
import { getScore, verifyAttestation, verifyManifest, type AgentManifest } from "@openrepso/sdk";
import { errorResponse, jsonResponse } from "@/server/error";
import { codedError, requireSession } from "@/server/http";
import { createRequestContext } from "@/server/storage";

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
      const record = await context.storage.getAgent(id);
      if (record === null) {
        return errorResponse(codedError("AGENT_NOT_FOUND", `no agent with id ${id}`));
      }
      const isOwner = (await context.storage.getSessionKey(id, session.userId)) !== null;

      const manifest: AgentManifest = {
        name: record.name,
        publicKey: record.publicKey,
        ownerPublicKey: record.ownerPublicKey ?? "",
        memoryPointer: record.memoryPointer,
        permissions: record.permissions,
        createdAt: record.createdAt,
        manifestVersion: record.manifestVersion,
        signature: record.signature,
      };
      const manifestVerdict = await verifyManifest(manifest, context.storage);

      const scoreResult = await getScore(id, context.storage);
      if (!scoreResult.ok) return errorResponse(scoreResult.error);

      const attestations = [];
      let cursor: string | undefined;
      let verifiedCount = 0;
      let totalCount = 0;
      for (;;) {
        const page = await context.storage.getAttestations(id, { cursor, limit: 1000 });
        for (const row of page.items) {
          totalCount += 1;
          const verdict = await verifyAttestation(row, context.storage);
          if (verdict.valid) verifiedCount += 1;
          if (isOwner) attestations.push({ attestation: row, verdict });
        }
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      return jsonResponse(
        {
          manifest,
          manifestVerdict: manifestVerdict.ok
            ? manifestVerdict.value
            : { valid: false, reason: manifestVerdict.error.message },
          score: scoreResult.value,
          isOwner,
          attestations,
          verifiedCount,
          totalCount,
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