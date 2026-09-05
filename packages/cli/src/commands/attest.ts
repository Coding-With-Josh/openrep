import { Command } from "commander";

export const attestCommand = new Command("attest")
  .description("Create and sign an attestation for an agent's task output")
  .requiredOption("-a, --agent <agentId>", "Agent ID")
  .requiredOption("-t, --task <task>", "Task description")
  .requiredOption("-o, --output <output>", "Task output")
  .requiredOption("-s, --source <source>", "Attestation source")
  .action(async (options) => {
    // TODO: call SDK attest()
    console.log("Not implemented yet");
    console.log("Options received:", options);
  });
