import type { AgentManifest } from "./identity";
import type { Attestation, ExternalAttestation } from "./attestation";
import type { AgentScore } from "./score";
import type { AgentRecord } from "./storage";

// browser to server contracts. these cross the network, so by design none
// of them ever includes a private key or an encryption related field.

// response to creating an agent. carries only the public manifest, the
// private key stays server side.
export interface CreateAgentResponse {
  name: string; // convenience copy, also in the manifest
  publicKey: string; // convenience copy, also in the manifest
  manifest: AgentManifest;
}

// body of a chat message to an agent.
export interface ChatRequest {
  agentId: string; // canonical agent id
  message: string;
}

// reply from a chat run: the model reply, what tools ran, the attestation
// that was created, and the score as it stands after this turn.
export interface ChatResponse {
  reply: string;
  toolsUsed: Attestation["toolsUsed"];
  attestationId: string;
  updatedScore: AgentScore;
}

// body of an ingest request. carries the raw external sample data.
export interface IngestRequest {
  externalAttestation: ExternalAttestation;
}

// result of ingesting one external record, plus the updated score.
export interface IngestResponse {
  attestation: Attestation;
  updatedScore: AgentScore;
}

// the manifest as returned by resolve(): the stored agent record without
// the storage-internal rowId, so revocation state (revokedAt) travels with
// the identity card without leaking an internal index into a network type.
// ownerPublicKey stays genuinely nullable because pre-revocation-pass legacy
// rows have no owner key on record; the sdk fails closed on those.
export type ResolvedManifest = Omit<AgentRecord, "rowId">;

// response to a resolve by name lookup.
export interface ResolveResponse {
  manifest: ResolvedManifest;
  score: AgentScore;
}