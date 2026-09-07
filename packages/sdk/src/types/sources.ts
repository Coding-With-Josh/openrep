import type { ExternalAttestation, ToolCall } from "./attestation";
import type { AgentId } from "./identity";
import type { VerificationResult } from "./errors";

// the content subset ingest() signs: everything the platform mapped and
// nothing else. deliberately narrower than Attestation — ids, source,
// hashes, signatures, and verification metadata are the ledger's business,
// not the adapter's, so an adapter cannot smuggle extra fields toward the
// signed bytes (canonicalize stays { task, output, toolsUsed }).
export interface NormalizedExternalAttestation {
  agentId: AgentId; // the openrep agent this record is about
  task: string; // what the agent was asked to do
  output: string; // what the platform recorded as the agent's result
  toolsUsed: ToolCall[]; // tool-level detail, empty when the platform has none
  timestamp: string; // when the external work happened, iso 8601 utc
}

// pluggable normalization for one external platform. register one adapter
// per source name so ingest stays generic instead of hardcoding per
// platform.
export interface SourceAdapter {
  sourceName: string;
  // turns raw external data into the content subset ingest() will sign. the
  // adapter is the only piece that understands the platform's shape; ingest
  // treats the result as untrusted adapter output and re-validates every
  // field through the same ledger validator before anything is hashed or
  // signed.
  normalize(raw: ExternalAttestation): NormalizedExternalAttestation;
  // optional integrity check on the raw record, e.g. a signature check by
  // the platform. the verdict lands in externalVerification provenance
  // metadata; a failing check blocks the ingest with
  // EXTERNAL_ATTESTATION_INVALID, and a throwing check is never treated as
  // "passed" (fail closed).
  validate?(raw: ExternalAttestation): VerificationResult;
}

// an approved external source with its trust weight. trustWeight is a real
// multiplier applied when computing the composite score, sources should
// not all count equally.
export interface RegisteredSource {
  sourceName: string;
  registeredAt: string; // iso 8601 utc
  trustWeight: number; // multiplier on this source's contribution
}