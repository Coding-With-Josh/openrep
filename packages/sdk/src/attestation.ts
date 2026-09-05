import type { AgentId } from "./types";

export interface Attestation {
  agentId: AgentId;
  task: string;
  output: string;
  source: string;
  timestamp: string;
  signature: string;
}

export interface ExternalAttestation {
  platform: string;
  agentName: string;
  task: string;
  output: string;
  timestamp: string;
  signature: string;
}

/**
 * Creates and signs an attestation for a given agent's task output.
 */
export async function attest(
  agentId: AgentId,
  task: string,
  output: string,
  source: string,
): Promise<Attestation> {
  // TODO: implement attestation signing
  throw new Error("Not implemented yet");
}

/**
 * Normalizes an external platform's attestation into the ledger.
 */
export async function ingest(
  externalAttestation: ExternalAttestation,
): Promise<Attestation> {
  // TODO: implement external attestation normalization
  throw new Error("Not implemented yet");
}
