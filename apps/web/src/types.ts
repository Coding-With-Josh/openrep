import type { AgentManifest, AgentScore, Attestation } from "@openrep/sdk";

// a browser session or user, distinct from an agent. one user owns multiple
// agents.
export interface UserSession {
  userId: string; // stable id for this browser session
  createdAt: string; // iso 8601 utc
}

// links one user to one owned agent.
export interface UserAgentLink {
  userId: string;
  agentId: string;
  createdAt: string; // iso 8601 utc
}

// one message in a chat between a user and an agent.
export interface ChatMessage {
  role: "user" | "agent";
  content: string;
  toolsUsed?: Attestation["toolsUsed"]; // present on agent replies
  timestamp: string; // iso 8601 utc
}

// the full message history for one chat session scoped to one agent.
export interface ChatSession {
  agentId: string;
  messages: ChatMessage[];
}

// shape consumed by the side by side comparison screen: one score plus
// manifest summary per agent.
export interface ComparisonViewData {
  agents: {
    manifest: AgentManifest;
    score: AgentScore;
  }[];
}