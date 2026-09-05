import type { AgentId } from "./types";

export interface ScoreBreakdown {
  source: string;
  count: number;
  avgConfidence: number;
}

export interface ReputationScore {
  agentId: AgentId;
  composite: number;
  breakdown: ScoreBreakdown[];
  lastUpdated: string;
}

/**
 * Returns composite reputation score, broken down by source.
 */
export async function getScore(agentId: AgentId): Promise<ReputationScore> {
  // TODO: implement score computation
  throw new Error("Not implemented yet");
}
