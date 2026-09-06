// resolve(): ties the identity model and the scoring model together. looks
// an agent up by its human readable name alias and returns the manifest plus
// the live computed score. this function is deliberately a thin composition
// of getAgentByName + getScore: it does no attestation reading and no
// scoring math of its own, so there is exactly one implementation of each.

import type { ResolveResponse } from "./types/api.js";
import type { Result } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import type { StorageAdapter } from "./types/storage.js";
import { getScore } from "./score.js";

/**
 * Looks up an agent by its human readable name, returns manifest + score.
 * the name is a mutable alias, the canonical id is the public key.
 */
export async function resolve(
  name: string,
  storage: StorageAdapter,
): Promise<Result<ResolveResponse>> {
  const record = await storage.getAgentByName(name);
  if (record === null) {
    return failure("AGENT_NOT_FOUND", `no agent named ${name}`);
  }

  // by composition: getScore does the paginated history read and the math.
  // its failure (e.g. SCORE_COMPUTATION_LIMIT_EXCEEDED) propagates unchanged
  // rather than being re-wrapped here.
  const scoreResult = await getScore(record.publicKey, storage);
  if (!scoreResult.ok) {
    return scoreResult;
  }

  // strip the storage-internal rowId so the resolved manifest stays portable
  // (ResolvedManifest = Omit<AgentRecord, "rowId">); revokedAt travels with
  // it so a caller can see revocation alongside the score.
  const { rowId: _rowId, ...manifest } = record;
  void _rowId;

  return ok({ manifest, score: scoreResult.value });
}