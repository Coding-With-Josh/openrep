import type { AgentId } from "./identity";

// one source's contribution to an agent's score.
export interface ScoreBreakdown {
  source: string; // native or registered external source name
  value: number; // per source score, same scale as composite
  count: number; // attestations from this source
  lastUpdated: string; // iso 8601 utc
}

// the reputation score for one agent, computed from its attestation history.
export interface AgentScore {
  agentId: AgentId; // canonical id
  composite: number; // aggregate across sources, trustWeight weighted
  breakdown: ScoreBreakdown[]; // per source details
  computedAt: string; // iso 8601 utc, when this score was computed
}

// scoring policy. decay is off by default in this pass; the type exists so
// enabling it later is not a breaking change. when enabled, decayFactor
// controls how much older attestations count less.
export interface ScoringConfig {
  decayEnabled: boolean; // default false
  decayFactor?: number; // used only when decayEnabled is true
}