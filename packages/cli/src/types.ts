// cli-level command arg shapes. args arrive as raw, untrusted argv strings;
// each command parses and validates them before anything reaches the sdk.

export interface CreateCommandOptions {
  revealKeys?: boolean; // --reveal-keys, opt-in private key printing
  public?: boolean; // --public: leaderboard-visible from birth
  private?: boolean; // --private: hidden from the leaderboard
}

export interface VisibilityCommandOptions {
  agent: string; // -a/--agent
  public?: boolean; // --public
  private?: boolean; // --private
}

export interface AttestCommandArgs {
  agent: string; // -a/--agent
  task: string; // -t/--task
  output: string; // -o/--output
  tools?: string; // --tools, raw json, parsed by the command
  idempotencyKey?: string; // --idempotency-key
}

export interface IngestCommandArgs {
  file: string; // -f/--file
  source: string; // -s/--source
  agent: string; // -a/--agent
}

export interface RevokeCommandArgs {
  agent: string; // -a/--agent
  ownerKey?: string; // --owner-key, overrides custody resolution
}