import { Command } from "commander";

export const resolveCommand = new Command("resolve")
  .description("Look up an agent by name, returning manifest + score")
  .argument("<name>", "Agent name")
  .action(async (name: string) => {
    // TODO: call SDK resolve()
    console.log("Not implemented yet");
    console.log("Agent:", name);
  });
