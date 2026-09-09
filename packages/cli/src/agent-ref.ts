// resolves an agent reference (a name or a canonical public key) against the
// real storage adapter. the name is a mutable alias; the public key is the
// canonical id. a 64-char lowercase hex string is treated as a public key,
// anything else as a name, so both spellings work for --agent/--ref flags.

import type { AgentRecord, StorageAdapter } from "@openrepso/sdk";
import { isLowercaseHexOfLength } from "./hex.js";

export async function resolveAgentRef(
  ref: string,
  storage: StorageAdapter,
): Promise<AgentRecord | null> {
  if (isLowercaseHexOfLength(ref, 32)) {
    return storage.getAgent(ref);
  }
  return storage.getAgentByName(ref);
}