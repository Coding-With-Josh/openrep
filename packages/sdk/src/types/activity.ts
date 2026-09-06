import type { AgentId } from "./identity";
import type { Paginated, PaginationParams } from "./storage";

// one event in the activity feed.
export interface ActivityEvent {
  id: string;
  type: "agent_created" | "attestation_created" | "score_updated" | "source_ingested";
  agentId: AgentId;
  summary: string; // human readable one line description
  timestamp: string; // iso 8601 utc
}

// query params for the activity feed. shares the standard paginated shape
// from storage.ts rather than redefining it.
export interface ActivityFeedQuery extends PaginationParams {}

// the paginated activity feed shape, reuse of the standard pagination.
export type ActivityFeed = Paginated<ActivityEvent>;