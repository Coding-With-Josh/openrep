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
    .option("--public", "make the agent public on the leaderboard (default)")
    .option("--private", "keep the agent private: visible only to its owner")
    .action(async (name: string | undefined, options: CreateCommandOptions) => {
      try {
        // --public and --private are mutually exclusive: the flags are
        // permissive at the parser level and narrowed to a single value
        // here, before anything reaches the sdk (fail-closed: both flags
        // is an error, never a silent last-one-wins).
        if (options.public === true && options.private === true) {
          failSdkCode("INVALID_INPUT", "use exactly one of --public or --private");
          return;
        }
        const visibility = options.private === true ? "private" : "public";

        // shared with the tui's dashboard "create agent" flow; the command
        // wrapper keeps the json stdout and the --reveal-keys filtering.
        const outcome = await runCreateAgent(ctx, name, visibility);
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
          visibility,
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