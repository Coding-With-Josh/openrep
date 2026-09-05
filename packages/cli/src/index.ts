#!/usr/bin/env node

import { Command } from "commander";
import { createCommand } from "./commands/create.js";
import { attestCommand } from "./commands/attest.js";
import { ingestCommand } from "./commands/ingest.js";
import { scoreCommand } from "./commands/score.js";
import { resolveCommand } from "./commands/resolve.js";
import { verifyCommand } from "./commands/verify.js";

const program = new Command();

program
  .name("openrep")
  .description("CLI for OpenRep — platform-agnostic reputation layer for AI agents")
  .version("0.1.0");

program.addCommand(createCommand);
program.addCommand(attestCommand);
program.addCommand(ingestCommand);
program.addCommand(scoreCommand);
program.addCommand(resolveCommand);
program.addCommand(verifyCommand);

program.parse();
