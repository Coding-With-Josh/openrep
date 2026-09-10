import { Command } from "commander";
import { type ToolCall } from "@openrepso/sdk";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkCode, handleCustodyError } from "./helpers.js";
import { actionOutcomeToCliError, isActionOutcomeOk, runAttestNative } from "./actions.js";
import type { AttestCommandArgs } from "../types.js";

export function attestCommand(ctx: CliContext): Command {
  return new Command("attest")
    .description("sign and persist a native attestation for an agent's work (source is always native)")
    .requiredOption("-a, --agent <ref>", "agent name or public key")
    .requiredOption("-t, --task <task>", "task description")
    .requiredOption("-o, --output <output>", "task output")
    .option("--tools <json>", `tool calls as json, e.g. [{"tool":"name","input":{}}]`)
    .option("--idempotency-key <key>", "dedupe retried submissions of the same work")
    .action(async (options: AttestCommandArgs) => {
      try {
        const record = await resolveAgentRef(options.agent, ctx.storage);
        if (record === null) {
          failSdkCode("AGENT_NOT_FOUND", `no agent matches "${options.agent}"`);
          return;
        }

        let toolsUsed: ToolCall[] | undefined;
        if (options.tools !== undefined) {
          // --tools arrives as a raw argv string: parse and shape check it
          // before anything reaches the sdk.
          let parsed: unknown;
          try {
            parsed = JSON.parse(options.tools);
          } catch {
            failSdkCode("INVALID_INPUT", "--tools must be valid json");
            return;
          }
          if (!Array.isArray(parsed)) {
            failSdkCode("INVALID_INPUT", "--tools must be a json array");
            return;
          }
          toolsUsed = parsed as ToolCall[];
        }

        // shared with the tui's chat screen; the command wrapper keeps the
        // full attestation json on stdout.
        const outcome = await runAttestNative(ctx, record, options.task, options.output, toolsUsed, options.idempotencyKey);
        if (!isActionOutcomeOk(outcome)) {
          const error = actionOutcomeToCliError(outcome);
          if (error !== null) failSdkCode(error.code, error.message);
          return;
        }
        console.log(JSON.stringify(outcome.value, null, 2));
      } catch (err) {
        if (handleCustodyError(err)) return;
        throw err;
      }
    });
}