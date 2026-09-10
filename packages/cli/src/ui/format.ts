// pure formatting helpers for the tui. every function here is deterministic
// and side-effect free so the screens stay testable without a terminal. the
// style rules are the cli house rules: all lowercase, no em-dashes, no
// scrollback-safe secrets (we never render private keys anywhere).

import type { AgentRecord, AgentScore, ScoreBreakdown } from "@openrepso/sdk";

// 7f3a...4b1d style short id, used everywhere a full public key would
// overflow the screen. never a truncation of a private key: this helper is
// only ever fed publicAgent ids.
export function shortPubKey(pub: string): string {
  if (pub.length <= 9) return pub;
  return `${pub.slice(0, 4)}...${pub.slice(-4)}`;
}

// ● active, ○ revoked. the revoked state keeps its row visible (an audit
// trail matters) but reads as off immediately.
export function statusIcon(record: AgentRecord): string {
  return record.revokedAt !== null ? "○" : "●";
}

// [pub] / [priv] badge for the dashboard row: shows the leaderboard
// visibility at a glance next to the name. a public badge is the default
// state, so the badge is informational, not a warning.
export function visibilityBadge(record: AgentRecord): string {
  return record.visibility === "private" ? "[priv]" : "[pub]";
}

// 1.40 style fixed two-decimal score.
export function formatScore(value: number): string {
  return value.toFixed(2);
}

// the dashboard's per-agent delta arrow: ↑ when the score rose since the
// last seen value this session, ↓ when it fell, a blank cell when it is
// flat (within 0.005) or there is nothing to compare against.
export function deltaArrow(current: number, previous: number | undefined): string {
  if (previous === undefined) return " ";
  const delta = current - previous;
  if (delta > 0.005) return "↑";
  if (delta < -0.005) return "↓";
  return " ";
}

// the signed header delta, e.g. "+0.20"; null when flat or uncomputable.
export function scoreDeltaString(current: number, previous: number | undefined): string | null {
  if (previous === undefined) return null;
  const delta = current - previous;
  if (Math.abs(delta) <= 0.005) return null;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(2)}`;
}

// 16-cell horizontal bar: value 0.80 renders ████████░░░░░░░░ (8 filled).
// the scale fixes 1.0 at 10 cells so sub-1 scores read naturally and the
// bar never implies unbounded reputation. clamped to the legal range.
export function barCells(value: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round(value * 10)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// "native 2 · chat 3" for the dashboard secondary line: each source name
// plus its attestation count, in breakdown order.
export function sourceCountLine(breakdown: ScoreBreakdown[] | undefined): string {
  if (breakdown === undefined || breakdown.length === 0) return "no attestations yet";
  return breakdown.map((b) => `${b.source} ${b.count}`).join(" · ");
}

// "7f3a...4b1d · native 2 · chat 3" - the dim secondary line under each
// dashboard row.
export function agentSecondaryLine(row: {
  record: AgentRecord;
  score: AgentScore | null;
}): string {
  const bits = [shortPubKey(row.record.publicKey)];
  if (row.score !== null) {
    const counts = sourceCountLine(row.score.breakdown);
    if (counts !== "no attestations yet") bits.push(counts);
  }
  return bits.join(" · ");
}

// a one-phrase human summary of a tool call for the live chat panel. input
// is untrusted model or sdk data, so extraction is defensive: missing or
// wrongly-typed fields fall back to the generic "running <tool>".
export function toolCallSummary(toolCall: { tool: string; input: unknown }): string {
  const input = toolCall.input;
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const firstString = (value: unknown): string | null =>
      typeof value === "string" && value.length > 0 ? value : null;

    if (toolCall.tool === "web_fetch" || toolCall.tool === "fetch_url" || toolCall.tool === "http_fetch") {
      const url = firstString(record["url"]);
      if (url !== null) return `reading ${url}`;
    }
    if (toolCall.tool === "web_search" || toolCall.tool === "search") {
      const query = firstString(record["query"]);
      if (query !== null) return `searching ${query}`;
    }
  }
  return `running ${toolCall.tool}`;
}

// the "verify passed 4/4" badge on the score screen. passed/exists is the
// ci contract mirror: only a fully clean audit is "passed".
export function verifyBadge(valid: boolean | undefined, checked: number | undefined): string {
  if (valid === undefined || checked === undefined) return "verify not run yet";
  return valid ? `verify passed ${checked}/${checked}` : `verify failed ${checked}/${checked}`;
}

// the last `max` lines of the verify audit, oldest first. verifies against
// thousands of attestations paginate over many pages; the tui shows a
// bounded window and the summary line stays visible by construction.
export function tailLines(lines: string[], max = 16): string[] {
  return lines.slice(-max);
}

// a capped status of the model/provider line for the splash screen: the
// label defaults to "groq" and the tui never guesses the endpoint.
export function splashModelLine(label: string, model: string): string {
  return `${label}: ${model}`;
}

// storage dot label: honest about which backend is in use. interactive.ts
// decides turso vs sqlite from the resolved env before this helper renders.
export function storageDotLine(storageName: string): string {
  return `connected to ${storageName}`;
}

// name + short pubkey for the chat/score headers, e.g. "loud-fox-7.agent".
export function agentHeaderName(record: AgentRecord): string {
  return `${record.name} ${shortPubKey(record.publicKey)}`;
}