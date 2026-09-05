import { Command } from "commander";

export const createCommand = new Command("create")
  .description("Create a new agent with a generated keypair and name")
  .option("-n, --name <name>", "Human-readable agent name (auto-generated if omitted)")
  .action(async (options) => {
    // TODO: call SDK createAgent()
    console.log("Not implemented yet");
    console.log("Options received:", options);
  });
