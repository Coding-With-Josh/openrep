import type { Attestation, ExternalAttestation } from "./attestation";
import type { VerificationResult } from "./errors";

// pluggable normalization for one external platform. register one adapter
// per source name so ingest stays generic instead of hardcoding per
// platform.
export interface SourceAdapter {
  sourceName: string;
  // turns raw external data into a native attestation.
  normalize(raw: ExternalAttestation): Attestation;
  // optional integrity check on the raw record, e.g. a signature check.
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