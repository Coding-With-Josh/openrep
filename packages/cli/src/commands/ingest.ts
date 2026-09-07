import { readFileSync } from "node:fs";
import { Command } from "commander";
import { ingest, type ExternalAttestation } from "@openrep/sdk";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { getSourceAdapter } from "../registry.js";
import { failSdkError, failSdkCode, handleCustodyError } from "./helpers.js";
import type { IngestCommandArgs } from "../types.js";

export function ingestCommand(ctx: CliContext): Command {
  return new Command("ingest")
    .description("normalize, sign, and persist an external attestation through a registered source adapter")
    .requiredOption("-f, --file <path>", "path to the raw external attestation json")
    .requiredOption("-s, --source <name>", "external source name, e.g. marketplace")
    .requiredOption("-a, --agent <ref>", "openrep agent the record is attributed to")
    .action(async (options: IngestCommandArgs) => {
      try {
        // the adapter registry is the trust boundary for source names: an
        // unregistered source fails loudly here before any file is read.
        const adapter = getSourceAdapter(options.source);
        if (adapter === null) {
          failSdkCode(
            "UNKNOWN_SOURCE",
            `no adapter registered for source "${options.source}"; the marketplace adapter ships in a later pass`,
          );
          return;
        }

        let rawText: string;
        try {
          rawText = readFileSync(options.file, "utf8");
        } catch (err) {
          failSdkCode("INVALID_INPUT", `could not read ${options.file}: ${(err as Error).message}`);
          return;
        }
        let raw: ExternalAttestation;
        try {
          raw = JSON.parse(rawText) as ExternalAttestation;
        } catch {
          failSdkCode("INVALID_INPUT", `${options.file} is not valid json`);
          return;
        }

        const record = await resolveAgentRef(options.agent, ctx.storage);
        if (record === null) {
          failSdkCode("AGENT_NOT_FOUND", `no agent matches "${options.agent}"`);
          return;
        }
        const resolution = await ctx.custody.resolveIdentityKey(record.publicKey);
        if (resolution === null) {
          failSdkCode(
            "KEYCHAIN_UNAVAILABLE",
            `no identity signing key available for agent ${record.publicKey}; set OPENREP_SIGNING_KEY`,
          );
          return;
        }
        const result = await ingest(raw, adapter, resolution.key, ctx.storage);
        if (!result.ok) {
          failSdkError(result.error);
          return;
        }
        console.log(JSON.stringify(result.value, null, 2));
      } catch (err) {
        if (handleCustodyError(err)) return;
        throw err;
      }
    });
}