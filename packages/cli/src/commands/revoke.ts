import { Command } from "commander";
import { canonicalize, revokeAgent } from "@openrep/sdk";
import { signAsync } from "@noble/ed25519";

import type { CliContext } from "../context.js";
import { resolveAgentRef } from "../agent-ref.js";
import { bytesToHex, hexToBytes, isEd25519PrivateKeyHex } from "../hex.js";
import { failSdkError, failSdkCode, handleCustodyError } from "./helpers.js";
import type { RevokeCommandArgs } from "../types.js";

export function revokeCommand(ctx: CliContext): Command {
  return new Command("revoke")
    .description("irreversibly revoke an agent; authorized only by its owner key")
    .requiredOption("-a, --agent <ref>", "agent name or public key")
    .option("--owner-key <hex>", "owner private key (32-byte hex); default: OPENREP_OWNER_KEY, then keychain, then encrypted file")
    .action(async (options: RevokeCommandArgs) => {
      try {
        const record = await resolveAgentRef(options.agent, ctx.storage);
        if (record === null) {
          failSdkCode("AGENT_NOT_FOUND", `no agent matches "${options.agent}"`);
          return;
        }

        let ownerKeyHex: string;
        if (options.ownerKey !== undefined) {
          // explicit --owner-key is checked at the cli boundary, but the
          // sdk remains the enforcement point: it re-derives the public key
          // and verifies the signature against the STORED owner key.
          if (!isEd25519PrivateKeyHex(options.ownerKey)) {
            failSdkCode("INVALID_INPUT", "--owner-key must be a 64-char lowercase hex ed25519 private key");
            return;
          }
          ownerKeyHex = options.ownerKey;
        } else {
          const resolution = await ctx.custody.resolveOwnerKey(record.publicKey);
          if (resolution === null) {
            failSdkCode(
              "KEYCHAIN_UNAVAILABLE",
              `no owner key available for agent ${record.publicKey}; use --owner-key or set OPENREP_OWNER_KEY`,
            );
            return;
          }
          ownerKeyHex = resolution.key;
        }

        // the revocation request signs exactly the canonicalized
        // { agentId, timestamp }, matching the sdk's request contract.
        const timestamp = new Date().toISOString();
        const canonical = canonicalize({ agentId: record.publicKey, timestamp });
        const signature = bytesToHex(await signAsync(new TextEncoder().encode(canonical), hexToBytes(ownerKeyHex)));

        const result = await revokeAgent({ agentId: record.publicKey, timestamp, signature }, ctx.storage);
        if (!result.ok) {
          failSdkError(result.error);
          return;
        }
        console.log(record.revokedAt !== null ? "agent is already revoked" : `revoked agent ${record.publicKey}`);
      } catch (err) {
        if (handleCustodyError(err)) return;
        throw err;
      }
    });
}