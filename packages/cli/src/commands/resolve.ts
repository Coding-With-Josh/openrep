import { Command } from "commander";
import { resolve } from "@openrepso/sdk";

import type { CliContext } from "../context.js";
import { failSdkError, failSdkCode } from "./helpers.js";
import { printManifestBlock, printScoreBlock } from "../print.js";

export function resolveCommand(ctx: CliContext): Command {
  return new Command("resolve")
    .description("resolve an agent by name: signed manifest plus live score")
    .argument("<name>", "agent name (name lookup per the sdk contract)")
    .action(async (name: string) => {
      const result = await resolve(name, ctx.storage);
      if (!result.ok) {
        failSdkError(result.error);
        return;
      }
      const { manifest, score } = result.value;
      printManifestBlock(manifest);
      console.log("");
      printScoreBlock(manifest.publicKey, manifest.name, score);
    });
}