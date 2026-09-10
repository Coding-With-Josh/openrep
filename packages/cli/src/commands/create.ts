import { Command } from "commander";

import type { CliContext } from "../context.js";
import { failSdkCode, handleCustodyError } from "./helpers.js";
import { actionOutcomeToCliError, isActionOutcomeOk, runCreateAgent } from "./actions.js";
import type { CreateCommandOptions } from "../types.js";

export function createCommand(ctx: CliContext): Command {
  return new Command("create")
    .description("create an agent: generate a keypair, persist the signed manifest, and take custody of the private keys")
    .argument("[name]", "human readable agent name (word-word-word.agent); generated when omitted")
    .option("--reveal-keys", "print the generated private keys to stdout. off by default so keys never reach scrollback, shell history, or ci logs")
    .action(async (name: string | undefined, options: CreateCommandOptions) => {
      try {
        // shared with the tui's dashboard "create agent" flow; the command
        // wrapper keeps the json stdout and the --reveal-keys filtering.
        const outcome = await runCreateAgent(ctx, name);
        if (!isActionOutcomeOk(outcome)) {
          const error = actionOutcomeToCliError(outcome);
          if (error !== null) failSdkCode(error.code, error.message);
          return;
        }
        const identity = outcome.value;

        const publicInfo = {
          name: identity.name,
          publicKey: identity.publicKey,
          ownerPublicKey: identity.ownerPublicKey,
          createdAt: identity.createdAt,
          memoryPointer: identity.memoryPointer,
          permissions: identity.permissions,
          manifestVersion: identity.manifestVersion,
          signature: identity.signature,
        };
        const output =
          options.revealKeys === true
            ? { ...publicInfo, privateKey: identity.privateKey, ownerPrivateKey: identity.ownerPrivateKey }
            : publicInfo;
        console.log(JSON.stringify(output, null, 2));
      } catch (err) {
        if (handleCustodyError(err)) return;
        throw err;
      }
    });
}