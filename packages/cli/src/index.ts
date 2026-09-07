// cli entry point. every command is wired to a real sdk function; nothing
// here is a stub. failures print "<CODE>: <message>" to stderr and exit
// non-zero; only explicit help, version, and full-verification-success exit 0.

import { Command, CommanderError } from "commander";

import { buildContext, type CliContext } from "./context.js";
import { attestCommand } from "./commands/attest.js";
import { createCommand } from "./commands/create.js";
import { ingestCommand } from "./commands/ingest.js";
import { resolveCommand } from "./commands/resolve.js";
import { revokeCommand } from "./commands/revoke.js";
import { scoreCommand } from "./commands/score.js";
import { verifyCommand } from "./commands/verify.js";

function buildProgram(ctx: CliContext): Command {
  const program = new Command();
  program
    .name("openrep")
    .description("cli for OpenRep, the platform-agnostic reputation layer for AI agents")
    .version("0.1.0");
  program.addCommand(createCommand(ctx));
  program.addCommand(attestCommand(ctx));
  program.addCommand(ingestCommand(ctx));
  program.addCommand(scoreCommand(ctx));
  program.addCommand(resolveCommand(ctx));
  program.addCommand(revokeCommand(ctx));
  program.addCommand(verifyCommand(ctx));
  // commander reports errors (unknown command, missing required option) by
  // throwing; main maps those to exit codes instead of letting them crash.
  program.exitOverride();
  return program;
}

// main is exported so in-process tests can run the full cli with injected
// contexts and capture the exit code without spawning the binary.
export async function main(argv: string[], overrides: Partial<CliContext> = {}): Promise<number> {
  let ctx: CliContext;
  try {
    ctx = buildContext(process.env, overrides);
  } catch (err) {
    process.stderr.write(`error: could not open storage: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    await buildProgram(ctx).parseAsync(argv);
    // process.exitCode is string | number at the type level; our code only
    // ever sets 1, and anything non-numeric fails closed to 1.
    const code = Number(process.exitCode ?? 0);
    return Number.isFinite(code) ? code : 1;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === "commander.helpDisplayed" || err.code === "commander.version") return 0;
      process.stderr.write(`error: ${err.message}\n`);
      // commander's exitCode is typed string | number; failure codes are
      // always positive, so anything non-positive fails closed to 1.
      const exitCode = Number(err.exitCode);
      return Number.isFinite(exitCode) && exitCode > 0 ? exitCode : 1;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}