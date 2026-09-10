import { Command } from "commander";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkCode } from "./helpers.js";
import { actionOutcomeToCliError, isActionOutcomeOk, runSetVisibility } from "./actions.js";
import type { VisibilityCommandOptions } from "../types.js";

export function visibilityCommand(ctx: CliContext): Command {
  return new Command("visibility")
    .description("show an agent's leaderboard visibility, or change it with --public/--private")
    .requiredOption("-a, --agent <ref>", "agent name or public key")
    .option("--public", "make the agent public on the leaderboard")
    .option("--private", "keep the agent private: visible only to its owner")
    .action(async (options: VisibilityCommandOptions) => {
      const record = await resolveAgentRef(options.agent, ctx.storage);
      if (record === null) {
        failSdkCode("AGENT_NOT_FOUND", `no agent matches "${options.agent}"`);
        return;
      }

      // the two flags are mutually exclusive; both set at once fails closed
      // instead of silently picking one. neither flag means "show current".
      if (options.public === true && options.private === true) {
        failSdkCode("INVALID_INPUT", "use exactly one of --public or --private");
        return;
      }
      if (options.public !== true && options.private !== true) {
        console.log(`${record.publicKey} ${record.visibility}`);
        return;
      }

      const visibility = options.private === true ? "private" : "public";
      const outcome = await runSetVisibility(ctx, record, visibility);
      if (!isActionOutcomeOk(outcome)) {
        const error = actionOutcomeToCliError(outcome);
        if (error !== null) failSdkCode(error.code, error.message);
        return;
      }
      console.log(`${record.publicKey} ${outcome.value.visibility}`);
    });
}