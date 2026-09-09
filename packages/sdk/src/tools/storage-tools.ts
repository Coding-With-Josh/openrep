// the three storage-backed stock tools. the tool signature has no storage
// or context parameter, so these are produced by a factory that closes over
// the caller's StorageAdapter. each read is scoped to the agent id named in
// the arguments: there is no listing, no cross-agent access, and the agent
// record storage already returns never contains the owner authorization key.
import type { StorageAdapter } from "../types/storage.js";
import type { ToolDefinition, ToolImplementation } from "../types/providers.js";
import { getScore } from "../score.js";
import { verifyAttestation } from "../attestation.js";
import { ToolError } from "./guards.js";

const VERIFY_SCAN_PAGE_LIMIT = 100;
const VERIFY_SCAN_MAX_PAGES = 20;

function requireAgentId(args: unknown): string {
  const agentId = (args as { agentId?: unknown }).agentId;
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 512) {
    throw new ToolError("agentId must be a non-empty string");
  }
  return agentId;
}

const selfReputationDefinition: ToolDefinition = {
  name: "self_reputation",
  description:
    `read the on-chain reputation score for an agent by agentId. returns the composite score and the per-source breakdown. use before or after work to report how the agent's reputation stands.`,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", minLength: 1, maxLength: 512 },
    },
    required: ["agentId"],
    additionalProperties: false,
  },
};

const selfReputationImplementationFactory = (storage: StorageAdapter): ToolImplementation => {
  return async (args: unknown) => {
    const agentId = requireAgentId(args);
    const result = await getScore(agentId, storage);
    if (!result.ok) {
      throw new ToolError(result.error.message);
    }
    const score = result.value;
    return {
      agentId: score.agentId,
      composite: score.composite,
      breakdown: score.breakdown.map((entry) => ({
        source: entry.source,
        value: entry.value,
        count: entry.count,
        lastUpdated: entry.lastUpdated,
      })),
      computedAt: score.computedAt,
    };
  };
};

const lookupAgentDefinition: ToolDefinition = {
  name: "lookup_agent",
  description:
    `resolve an openrep agent's identity card by agentId: name, public key, permissions, creation time, and manifest metadata. the owner authorization key is never included.`,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", minLength: 1, maxLength: 512 },
    },
    required: ["agentId"],
    additionalProperties: false,
  },
};

const lookupAgentImplementationFactory = (storage: StorageAdapter): ToolImplementation => {
  return async (args: unknown) => {
    const agentId = requireAgentId(args);
    const agent = await storage.getAgent(agentId as import("../types/identity.js").AgentId);
    if (agent === null) {
      throw new ToolError(`no agent with id ${agentId}`);
    }
    return {
      agentId,
      name: agent.name,
      publicKey: agent.publicKey,
      memoryPointer: agent.memoryPointer,
      permissions: agent.permissions,
      createdAt: agent.createdAt,
      manifestVersion: agent.manifestVersion,
    };
  };
};

const verifyAttestationDefinition: ToolDefinition = {
  name: "verify_attestation",
  description:
    `verify a stored attestation record for an agent by agentId and attestationId. returns whether the signature and content hash check out. use when the model is asked whether some claimed work is authentic.`,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string", minLength: 1, maxLength: 512 },
      attestationId: { type: "string", minLength: 1, maxLength: 512 },
    },
    required: ["agentId", "attestationId"],
    additionalProperties: false,
  },
};

async function findAttestationById(
  storage: StorageAdapter,
  agentId: string,
  attestationId: string,
): Promise<import("../types/attestation.js").Attestation | null> {
  // storage has no by-id attestation read, so the scan walks the agent's
  // own history page by page, newest first, and stops at the first match.
  let cursor: string | undefined;
  for (let page = 0; page < VERIFY_SCAN_MAX_PAGES; page += 1) {
    const result = await storage.getAttestations(agentId as import("../types/identity.js").AgentId, {
      cursor,
      limit: VERIFY_SCAN_PAGE_LIMIT,
    });
    for (const record of result.items) {
      if (record.id === attestationId) return record;
    }
    if (result.nextCursor === null || result.items.length === 0) break;
    cursor = result.nextCursor;
  }
  return null;
}

const verifyAttestationImplementationFactory = (storage: StorageAdapter): ToolImplementation => {
  return async (args: unknown) => {
    const agentId = requireAgentId(args);
    const attestationId = (args as { attestationId?: unknown }).attestationId;
    if (typeof attestationId !== "string" || attestationId.length === 0 || attestationId.length > 512) {
      throw new ToolError("attestationId must be a non-empty string");
    }
    const record = await findAttestationById(storage, agentId, attestationId);
    if (record === null) {
      return { found: false, valid: null, reason: `no attestation with id ${attestationId} for agent ${agentId}` };
    }
    const verdict = await verifyAttestation(record, storage);
    return {
      found: true,
      valid: verdict.valid,
      reason: verdict.reason,
      agentId,
      attestationId,
    };
  };
};

export function createStorageTools(storage: StorageAdapter): readonly { definition: ToolDefinition; implementation: ToolImplementation }[] {
  return [
    {
      definition: selfReputationDefinition,
      implementation: selfReputationImplementationFactory(storage),
    },
    {
      definition: lookupAgentDefinition,
      implementation: lookupAgentImplementationFactory(storage),
    },
    {
      definition: verifyAttestationDefinition,
      implementation: verifyAttestationImplementationFactory(storage),
    },
  ];
}