import type { AgentManifest } from "./types";
import type { ReputationScore } from "./score";

export interface ResolvedAgent {
  manifest: AgentManifest;
  score: ReputationScore;
}

/**
 * Looks up an agent by name, returns manifest + score.
 */
export async function resolve(name: string): Promise<ResolvedAgent> {
  // TODO: implement agent lookup by name
  throw new Error("Not implemented yet");
}
