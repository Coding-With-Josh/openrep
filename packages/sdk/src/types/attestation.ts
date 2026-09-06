import type { AgentId } from "./identity";

// one tool call observed during an agent run.
export interface ToolCall {
  tool: string; // tool name as invoked
  input: unknown; // arguments passed to the tool
  output?: unknown; // tool result when captured
}

// a signed record that an agent completed a specific piece of work.
// contentHash is what actually gets signed, so any change to task, output,
// or toolsUsed invalidates the signature.
export interface Attestation {
  id: string; // unique to this attestation, distinct from the agent id
  agentId: AgentId; // canonical id per the identity decision
  task: string; // what the agent was asked to do
  output: string; // what the agent produced
  toolsUsed: ToolCall[]; // tools invoked during the run, empty when none
  source: string; // "native" or a registered external source name
  contentHash: string; // hash of the deterministic serialization of task, output, toolsUsed
  signature: string; // signature over contentHash
  signedBy: string; // the public key that produced the signature
  timestamp: string; // iso 8601 utc
  schemaVersion: number; // so the schema can evolve without breaking old rows
}

// raw input from an external platform before normalization. intentionally
// loose, this is sample/mock external platform data for demo purposes, the
// one legitimate mock in this entire project. sourceName is always present,
// the rest depends on the platform.
export interface ExternalAttestation {
  sourceName: string;
  [key: string]: unknown;
}

// input to a single attest() call. idempotencyKey lets a retried submission
// from a flaky pipeline be recognized so it is not double counted.
export interface AttestationInput {
  agentId: AgentId;
  task: string;
  output: string;
  toolsUsed?: ToolCall[];
  source: string;
  idempotencyKey?: string; // same key on retry maps to the same attestation
}

// options for a wrapped agent run.
export interface WrapAgentOptions {
  source?: string; // defaults to "native"
  idempotencyKey?: string; // lets retries collapse into one attestation
}

// result of a wrapped run: the output, the tool calls captured during the
// loop, the number of model turns it took to converge, plus the signed
// attestation created for it.
export interface WrappedRunResult {
  output: string;
  toolsUsed: Attestation["toolsUsed"];
  turns: number; // how many model turns the loop took before producing text
  attestation: Attestation; // the signed record of this run
}