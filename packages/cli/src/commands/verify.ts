import { Command } from "commander";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkCode } from "./helpers.js";
import { runVerifyAgent } from "./actions.js";

// verify is the ci gate: it re-derives and re-checks everything from raw
// stored rows only, never from anything the cli process itself supplied. it
// paginates the FULL attestation history (a truncated audit is not an audit)
// and exits non-zero unless the manifest AND every attestation pass. the
// audit logic itself is shared with the tui's "v" key via runVerifyAgent;
// the exit-code contract stays here so the tui never sets process.exitCode.

export function verifyCommand(ctx: CliContext): Command {
  return new Command("verify")
    .description("independently verify a manifest and every attestation against raw stored data; exit 0 only when all pass")
    .argument("<name>", "agent name or public key")
    .action(async (name: string) => {
      const record = await resolveAgentRef(name, ctx.storage);
      if (record === null) {
        failSdkCode("AGENT_NOT_FOUND", `no agent matches "${name}"`);
        return;
      }

      const summary = await runVerifyAgent(record, ctx.storage, (line) => console.log(line));
      if (!summary.valid) {
        process.exitCode = 1;
      }
    });
}