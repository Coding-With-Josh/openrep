import { Command } from "commander";

export const verifyCommand = new Command("verify")
  .description("Verify an agent's attestation history — re-hash and check signatures locally")
  .argument("<name>", "Agent name or ID")
  .action(async (name: string) => {
    // TODO: implement local verification without trusting OpenRep server
    console.log("Not implemented yet");
    console.log("Agent:", name);
  });
