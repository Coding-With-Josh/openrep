import { Command } from "commander";
import { attest, type ToolCall } from "@openrepso/sdk";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkError, failSdkCode, handleCustodyError } from "./helpers.js";
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

        const resolution = await ctx.custody.resolveIdentityKey(record.publicKey);
        if (resolution === null) {
          failSdkCode(
            "KEYCHAIN_UNAVAILABLE",
            `no identity signing key available for agent ${record.publicKey}; set OPENREP_SIGNING_KEY or run "openrep create" for this agent first`,
          );
          return;
        }

        // source is deliberately closed to "native": external records belong
        // to `openrep ingest`, and the sdk rejects non-native here anyway.
        const result = await attest(
          {
            agentId: record.publicKey,
            task: options.task,
            output: options.output,
            toolsUsed,
            source: "native",
            idempotencyKey: options.idempotencyKey,
          },
          resolution.key,
          ctx.storage,
        );
        if (!result.ok) {
          failSdkError(result.error);
          return;
        }
        console.log(JSON.stringify(result.value, null, 2));
      } catch (err) {
        if (handleCustodyError(err)) return;
        throw err;
      }
    });
}