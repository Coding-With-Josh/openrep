// parsed argument shapes for cli commands, before conversion into sdk input
// types. kept separate from ExternalAttestation so file parsing failures
// are distinguishable from sdk validation failures.

export interface CreateCommandArgs {
  name?: string; // optional explicit name, auto generated when absent
}

export interface AttestCommandArgs {
  agent: string; // agent id or name
  task: string;
  output: string;
  source: string;
}

export interface IngestCommandArgs {
  file: string; // path to the external attestation file
  source: string; // source name to attribute
}

export interface ScoreCommandArgs {
  name: string;
}

export interface ResolveCommandArgs {
  name: string;
}

export interface VerifyCommandArgs {
  name: string;
}