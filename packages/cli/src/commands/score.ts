import { Command } from "commander";
import { getScore } from "@openrepso/sdk";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkError, failSdkCode } from "./helpers.js";
import { printScoreBlock } from "../print.js";

export function scoreCommand(ctx: CliContext): Command {
  return new Command("score")
    .description("show an agent's composite score and per-source breakdown")
    .argument("<name>", "agent name or public key")
    .action(async (name: string) => {
      const record = await resolveAgentRef(name, ctx.storage);
      if (record === null) {
        failSdkCode("AGENT_NOT_FOUND", `no agent matches "${name}"`);
        return;
      }
      const result = await getScore(record.publicKey, ctx.storage);
      if (!result.ok) {
        failSdkError(result.error);
        return;
      }
      printScoreBlock(record.publicKey, record.name, result.value);
    });
}