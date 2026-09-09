import { Command } from "commander";
import { createAgent } from "@openrepso/sdk";

import type { CliContext } from "../context.js";
import { failSdkError, handleCustodyError } from "./helpers.js";
import type { CreateCommandOptions } from "../types.js";

export function createCommand(ctx: CliContext): Command {
  return new Command("create")
    .description("create an agent: generate a keypair, persist the signed manifest, and take custody of the private keys")
    .argument("[name]", "human readable agent name (word-word-word.agent); generated when omitted")
    .option("--reveal-keys", "print the generated private keys to stdout. off by default so keys never reach scrollback, shell history, or ci logs")
    .action(async (name: string | undefined, options: CreateCommandOptions) => {
      try {
        const result = await createAgent({ storage: ctx.storage, name });
        if (!result.ok) {
          failSdkError(result.error);
          return;
        }
        const identity = result.value;

        // take custody of BOTH keys before printing anything: if no store
        // accepts them, the whole create fails rather than half-succeeds.
        await ctx.custody.storeAgentKeys(identity);

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