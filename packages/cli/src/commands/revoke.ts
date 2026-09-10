import { Command } from "commander";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkCode, handleCustodyError } from "./helpers.js";
import { actionOutcomeToCliError, isActionOutcomeOk, runRevokeAgent } from "./actions.js";
import type { RevokeCommandArgs } from "../types.js";

export function revokeCommand(ctx: CliContext): Command {
  return new Command("revoke")
    .description("irreversibly revoke an agent; authorized only by its owner key")
    .requiredOption("-a, --agent <ref>", "agent name or public key")
    .option("--owner-key <hex>", "owner private key (32-byte hex); default: OPENREP_OWNER_KEY, then keychain, then encrypted file")
    .action(async (options: RevokeCommandArgs) => {
      try {
        const record = await resolveAgentRef(options.agent, ctx.storage);
        if (record === null) {
          failSdkCode("AGENT_NOT_FOUND", `no agent matches "${options.agent}"`);
          return;
        }

        // shared with the tui's dashboard revoke flow. the command wrapper
        // keeps the one-line stdout and the custody try/catch exactly as
        // before; the explicit --owner-key shape check now lives in
        // runRevokeAgent but produces the same INVALID_INPUT stderr.
        const outcome = await runRevokeAgent(ctx, record, options.ownerKey);
        if (!isActionOutcomeOk(outcome)) {
          const error = actionOutcomeToCliError(outcome);
          if (error !== null) failSdkCode(error.code, error.message);
          return;
        }
        console.log(outcome.value.alreadyRevoked ? "agent is already revoked" : `revoked agent ${record.publicKey}`);
      } catch (err) {
        if (handleCustodyError(err)) return;
        throw err;
      }
    });
}