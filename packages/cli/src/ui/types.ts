// ui-facing data shapes, kept separate from the sdk types so the screens
// render exactly what interactive.ts reconciles and nothing else. plain
// data only: no functions, no sdk imports here, so tests can construct
// fixtures trivially.

import type { AgentRecord, AgentScore, Attestation } from "@openrepso/sdk";

// one dashboard row: the stored record plus its freshly computed score
// (null when storage read or scoring failed; the row still renders with a
// "score unavailable" secondary line instead of vanishing).
export interface UiAgentRow {
  record: AgentRecord;
  score: AgentScore | null;
}

// a rendered chat message. the assistant turn carries toolsUsed and
// attestationId from the signed attestation when the run converged; user
// messages are plain text.
export interface UiChatEntry {
  role: "user" | "assistant";
  content: string;
  toolsUsed: { tool: string; input: unknown; output?: unknown }[];
  attestationId?: string | null;
  error?: boolean; // user turn that failed to converge, rendered in red
}

// the verify audit buffer state on the score screen. lines are the exact
// strings the ci `openrep verify` would print; the tui renders them without
// touching process.exitCode.
export interface UiVerifyState {
  running: boolean;
  lines: string[];
  failed: boolean;
}

export type Screen = "splash" | "dashboard" | "chat" | "score";

// an inline error rendered in red at the bottom of the active screen. code
// comes from the sdk/cii vocabulary (AGENT_NOT_FOUND, KEYCHAIN_UNAVAILABLE,
// ...) or the generic "INTERNAL" when an unexpected throw escaped an action;
// messages never include stack traces or key material.
export interface UiError {
  code: string;
  message: string;
}

// a freshly wrapped chat turn: the signed attestation plus the derived view
// for the chat screen. only a converged run produces this; every failure
// path yields UiError instead.
export interface UiTurnResult {
  attestation: Attestation;
  content: string;
  toolsUsed: { tool: string; input: unknown; output?: unknown }[];
}