import { Command } from "commander";

export const scoreCommand = new Command("score")
  .description("Get the reputation score for an agent")
  .argument("<name>", "Agent name or ID")
  .action(async (name: string) => {
    // TODO: call SDK getScore()
    console.log("Not implemented yet");
    console.log("Agent:", name);
  });
