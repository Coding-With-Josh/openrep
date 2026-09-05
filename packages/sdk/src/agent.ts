import type { AgentId, AgentManifest } from "./types";

/**
 * Generates a keypair + human-readable name, returns a signed manifest.
 */
export async function createAgent(
  name?: string,
): Promise<AgentManifest> {
  // TODO: implement keypair generation, name generation, manifest signing
  throw new Error("Not implemented yet");
}

/**
 * Wraps an agent's run function, capturing task/tool calls/output.
 */
export async function wrapAgent<T>(
  agentId: AgentId,
  agentFn: () => Promise<T>,
): Promise<T> {
  // TODO: implement run capture, task tracking, tool call logging
  throw new Error("Not implemented yet");
}
