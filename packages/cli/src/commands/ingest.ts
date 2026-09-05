import { Command } from "commander";

export const ingestCommand = new Command("ingest")
  .description("Ingest an external attestation from a file")
  .requiredOption("-f, --file <path>", "Path to attestation JSON file")
  .requiredOption("-s, --source <name>", "External platform name")
  .action(async (options) => {
    // TODO: call SDK ingest()
    console.log("Not implemented yet");
    console.log("Options received:", options);
  });
