import { Command } from "commander";
import { SCORE_PAGE_LIMIT, verifyAttestation, verifyManifest, type AgentManifest } from "@openrep/sdk";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { failSdkError, failSdkCode } from "./helpers.js";

// verify is the ci gate: it re-derives and re-checks everything from raw
// stored rows only, never from anything the cli process itself supplied. it
// paginates the FULL attestation history (a truncated audit is not an audit)
// and exits non-zero unless the manifest AND every attestation pass.

export function verifyCommand(ctx: CliContext): Command {
  return new Command("verify")
    .description("independently verify a manifest and every attestation against raw stored data; exit 0 only when all pass")
    .argument("<name>", "agent name or public key")
    .action(async (name: string) => {
      const record = await resolveAgentRef(name, ctx.storage);
      if (record === null) {
        failSdkCode("AGENT_NOT_FOUND", `no agent matches "${name}"`);
        return;
      }

      let valid = true;

      // the stored row is untrusted input to the verifier: the boundary cast
      // is deliberate (AgentRecord widens ownerPublicKey to null) and
      // verifyManifest shape-checks every field itself.
      const manifestResult = await verifyManifest(record as unknown as AgentManifest, ctx.storage);
      if (!manifestResult.ok) {
        console.log(`manifest: FAIL (${manifestResult.error.message})`);
        valid = false;
      } else if (manifestResult.value.valid) {
        console.log(`manifest: ok`);
      } else {
        console.log(`manifest: FAIL (${manifestResult.value.reason ?? "invalid"})`);
        valid = false;
      }

      let checked = 0;
      let failed = 0;
      let cursor: string | undefined;
      for (;;) {
        const page = await ctx.storage.getAttestations(record.publicKey, { cursor, limit: SCORE_PAGE_LIMIT });
        for (const attestation of page.items) {
          checked += 1;
          const verdict = await verifyAttestation(attestation, ctx.storage);
          if (verdict.valid) {
            console.log(`  ok    ${attestation.id}  ${attestation.timestamp}`);
          } else {
            console.log(`  FAIL  ${attestation.id}  ${verdict.reason ?? "invalid"}`);
            failed += 1;
          }
        }
        if (page.nextCursor === null || page.items.length === 0) break;
        cursor = page.nextCursor;
      }

      const okCount = checked - failed;
      if (valid && failed === 0) {
        console.log(`summary: ${okCount}/${checked} attestations valid, manifest valid`);
      } else {
        console.log(`summary: verify FAILED (${okCount}/${checked} attestations valid, manifest ${valid ? "valid" : "invalid"})`);
        process.exitCode = 1;
      }
    });
}