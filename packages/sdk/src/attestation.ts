import { getPublicKeyAsync, signAsync, verifyAsync } from "@noble/ed25519";
import { createHash, randomUUID } from "node:crypto";
import type { AgentId } from "./types/identity.js";
import type { Attestation, AttestationInput, ExternalAttestation, ToolCall } from "./types/attestation.js";
import type { Result, VerificationResult } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import type { AttestationRecord, StorageAdapter } from "./types/storage.js";
import { canonicalize } from "./canonical.js";
import { bytesToHex, hexToBytes, isLowercaseHexOfLength } from "./hex.js";

// the schema this module writes today. bumping it lets old rows stay valid
// while new fields appear, mirroring manifestVersion in the identity module.
export const ATTESTATION_SCHEMA_VERSION = 1;

// input size limits, enforced before any hashing or signing work. the actual
// values are a judgment call for demo scale; the property they protect is
// that crafted input cannot drive unbounded canonicalization or storage.
const MAX_TASK_LENGTH = 4000;
const MAX_OUTPUT_LENGTH = 8000;
const MAX_TOOLS_USED_ENTRIES = 50;
const MAX_TOOL_NAME_LENGTH = 100;
const MAX_TOOL_ENTRY_SERIALIZED_LENGTH = 4000;

// the same limits, exported read-only so wrapAgent() can pre-check oversized
// input before spending a provider call, without duplicating the values.
// attest() remains the authoritative enforcement backstop.
export const ATTESTATION_LIMITS = {
  maxTaskLength: MAX_TASK_LENGTH,
  maxOutputLength: MAX_OUTPUT_LENGTH,
  maxToolsUsedEntries: MAX_TOOLS_USED_ENTRIES,
  maxToolNameLength: MAX_TOOL_NAME_LENGTH,
  maxToolEntrySerializedLength: MAX_TOOL_ENTRY_SERIALIZED_LENGTH,
} as const;

// the firm boundary between attest() and ingest(): attestation only ever
// accepts native runs; anything else must go through a registered source.
const NATIVE_SOURCE = "native";

function toolEntriesValid(toolsUsed: unknown): ToolCall[] | "invalid" | "too-large" {
  if (!Array.isArray(toolsUsed)) return "invalid";
  if (toolsUsed.length > MAX_TOOLS_USED_ENTRIES) return "too-large";
  for (const tool of toolsUsed) {
    if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return "invalid";
    const entry = tool as Partial<ToolCall>;
    if (typeof entry.tool !== "string" || entry.tool.length === 0) return "invalid";
    if (entry.tool.length > MAX_TOOL_NAME_LENGTH) return "too-large";
    // the entry must be canonicalizable as a whole so the size bound below
    // measures the exact bytes that will be hashed, and cycles or
    // unsupported values surface here with a clear entry index instead of
    // crashing mid-commit. a cycle spanning two entries would be rejected by
    // name as a duplicate sibling reference is legal, an ancestor cycle is
    // not, and canonicalize draws that line correctly. output is optional,
    // so it is only included when present: canonicalize rejects undefined
    // values, and absent output is a legitimate tool call.
    try {
      const serialized = canonicalize(
        entry.output === undefined
          ? { tool: entry.tool, input: entry.input }
          : { tool: entry.tool, input: entry.input, output: entry.output },
      );
      if (serialized.length > MAX_TOOL_ENTRY_SERIALIZED_LENGTH) return "too-large";
    } catch {
      return "invalid";
    }
  }
  return toolsUsed as ToolCall[];
}

// strips storage internals (rowId, idempotencyKey) off a persisted record so
// the portable Attestation returned to callers stays the exact shape that is
// signed and verifiable.
function toPortable(record: AttestationRecord): Attestation {
  return {
    id: record.id,
    agentId: record.agentId,
    task: record.task,
    output: record.output,
    toolsUsed: record.toolsUsed,
    source: record.source,
    contentHash: record.contentHash,
    signature: record.signature,
    signedBy: record.signedBy,
    timestamp: record.timestamp,
    schemaVersion: record.schemaVersion,
  };
}

/**
 * Creates and signs an attestation for a given agent's task output.
 * signs the contentHash, not the raw fields, so any tampering with task,
 * output, or toolsUsed invalidates the signature. idempotent per
 * (agentId, idempotencyKey): retrying with the same key returns the existing
 * attestation instead of writing a second one.
 */
export async function attest(
  input: AttestationInput,
  signingKey: string,
  storage: StorageAdapter,
): Promise<Result<Attestation>> {
  // phase 1: shape and size validation. read-only, no crypto, no storage,
  // so crafted input is rejected before it consumes any work.
  if (!isLowercaseHexOfLength(input.agentId, 32)) {
    return failure("INVALID_INPUT", "agentId must be 32-byte lowercase hex");
  }
  if (!isLowercaseHexOfLength(signingKey, 32)) {
    return failure("INVALID_INPUT", "signingKey must be 32-byte lowercase hex");
  }
  if (typeof input.task !== "string") {
    return failure("INVALID_INPUT", "task must be a string");
  }
  if (input.task.length > MAX_TASK_LENGTH) {
    return failure("INPUT_TOO_LARGE", `task exceeds ${MAX_TASK_LENGTH} characters`);
  }
  if (typeof input.output !== "string") {
    return failure("INVALID_INPUT", "output must be a string");
  }
  if (input.output.length > MAX_OUTPUT_LENGTH) {
    return failure("INPUT_TOO_LARGE", `output exceeds ${MAX_OUTPUT_LENGTH} characters`);
  }
  const toolsChecked = toolEntriesValid(input.toolsUsed ?? []);
  if (toolsChecked === "invalid") {
    return failure("INVALID_INPUT", "toolsUsed entry is malformed, not canonicalizable, or contains invalid field types");
  }
  if (toolsChecked === "too-large") {
    return failure(
      "INPUT_TOO_LARGE",
      `toolsUsed exceeds ${MAX_TOOLS_USED_ENTRIES} entries, a tool name of ${MAX_TOOL_NAME_LENGTH} characters, or an entry of ${MAX_TOOL_ENTRY_SERIALIZED_LENGTH} canonical characters per entry`,
    );
  }

  // phase 2: firm source boundary. external sources belong to ingest();
  // attest() never accepts them, keeping the native ledger distinguishable
  // from imported platform data at the schema level.
  if (input.source !== NATIVE_SOURCE) {
    return failure(
      "INVALID_SOURCE",
      `attest() only accepts source "native", got ${input.source === undefined ? "(missing)" : `"${input.source}"`}`,
    );
  }

  // phase 3: revocation pre-check. the storage record is the single source
  // of truth for both "does this agent exist" and "is it revoked", and it is
  // checked BEFORE any key derivation, hashing, or signing work. a revoked
  // agent is refused with AGENT_REVOKED no matter how valid the caller's
  // key is, and an unknown agent fails closed with AGENT_NOT_FOUND. a
  // failing read is never treated as "not revoked": under a flaky store the
  // attestation fails closed rather than proceeding on stale nothing.
  let agentRecord;
  try {
    agentRecord = await storage.getAgent(input.agentId);
  } catch {
    return failure("STORAGE_WRITE_FAILED", "could not check the agent's revocation status");
  }
  if (agentRecord === null) {
    return failure("AGENT_NOT_FOUND", `unknown agent: ${input.agentId}`);
  }
  if (agentRecord.revokedAt !== null) {
    return failure("AGENT_REVOKED", "agent has been revoked and cannot sign new attestations");
  }

  // phase 4: key correspondence. the agentId IS the derived public key per
  // the identity decision, so the provided signing key either derives to the
  // claimed agent or the caller is using the wrong key.
  let signedBy: string;
  try {
    signedBy = bytesToHex(await getPublicKeyAsync(hexToBytes(signingKey)));
  } catch {
    return failure("KEY_MISMATCH", "signing key could not be used to derive a public key");
  }
  if (signedBy !== input.agentId) {
    return failure("KEY_MISMATCH", "signing key does not match the claimed agent");
  }

  const idempotencyKey = input.idempotencyKey;
  if (idempotencyKey !== undefined) {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0) {
      return failure("INVALID_INPUT", "idempotencyKey must be a non-empty string");
    }
    // optimistic dedup read. deliberately not the source of truth: the
    // composite unique index arbitrates the real race, and a failing read
    // degrades to a miss so a flaky store can never silently double-count
    // (the insert constraint still catches duplicates).
    let existing: AttestationRecord | null;
    try {
      existing = await storage.getAttestationByIdempotencyKey(input.agentId, idempotencyKey);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      return ok(toPortable(existing));
    }
  }

  // phase 5: hash and sign. only the three content fields are canonicalized,
  // never the signature or metadata, so unknown extra properties on the
  // input object cannot influence the signed bytes. sign over the sha-256
  // content hash bytes, not the raw canonical text, per the plan.
  const canonical = canonicalize({ task: input.task, output: input.output, toolsUsed: toolsChecked });
  const contentHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const signature = bytesToHex(await signAsync(hexToBytes(contentHash), hexToBytes(signingKey)));
  const timestamp = new Date().toISOString();
  // randomUUID rather than a content derived id: hash based ids would bump
  // into the unique attestations.id constraint when two legitimate runs
  // produce identical content, which must be allowed.
  const id = randomUUID();

  const record: AttestationRecord = {
    rowId: 0, // assigned by the store on insert
    id,
    agentId: input.agentId,
    task: input.task,
    output: input.output,
    toolsUsed: toolsChecked,
    source: NATIVE_SOURCE,
    contentHash,
    signature,
    signedBy,
    timestamp,
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    idempotencyKey,
  };

  try {
    await storage.saveAttestation(record);
  } catch (err) {
    // the storage layer already translated the composite unique violation to
    // DUPLICATE_IDEMPOTENCY_KEY: a concurrent call with the same (agent,
    // key) won the insert race. resolve by fetching and returning the
    // existing attestation so retries collapse into one. this is the
    // idempotency contract: same key, same result. if the follow-up read
    // fails too, the failure propagates rather than fabricate a success.
    if (isCodedError(err, "DUPLICATE_IDEMPOTENCY_KEY")) {
      if (idempotencyKey !== undefined) {
        try {
          const existing = await storage.getAttestationByIdempotencyKey(input.agentId, idempotencyKey);
          if (existing !== null) return ok(toPortable(existing));
        } catch {
          // fall through to the error return below
        }
      }
      return failure("DUPLICATE_IDEMPOTENCY_KEY", "attestation already exists and could not be fetched");
    }
    // the storage layer translated the foreign key violation; surfaced
    // unchanged so callers can tell an unknown agent from a broken store.
    if (isCodedError(err, "AGENT_NOT_FOUND")) {
      return failure("AGENT_NOT_FOUND", `unknown agent: ${input.agentId}`);
    }
    return failure("STORAGE_WRITE_FAILED", "attestation could not be saved");
  }

  return ok(toPortable(record));
}

/**
 * Normalizes an external platform's attestation into the ledger using the
 * registered SourceAdapter for the source name.
 */
export async function ingest(
  externalAttestation: ExternalAttestation,
): Promise<Result<Attestation>> {
  // TODO: implement adapter lookup, normalization, validation
  throw new Error("Not implemented yet");
}

function isCodedError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * Verifies that an attestation's signature is valid, that the content hash
 * matches its task, output, and toolsUsed, and that the signing agent has
 * not been revoked. never throws; every bad shape yields an invalid verdict
 * with a specific reason.
 *
 * storage is mandatory for the revocation gate: the record is the single
 * source of truth for "is the signer still live". a revoked signer fails
 * with reason "key revoked" (revocation wins over signature validity), and a
 * missing record fails closed with "agent not found" rather than verifying.
 */
export async function verifyAttestation(attestation: Attestation, storage: StorageAdapter): Promise<VerificationResult> {
  if (typeof attestation.contentHash !== "string" || !isLowercaseHexOfLength(attestation.contentHash, 32)) {
    return { valid: false, reason: "contentHash is not a 32-byte lowercase hex sha-256" };
  }
  if (typeof attestation.signature !== "string" || !isLowercaseHexOfLength(attestation.signature, 64)) {
    return { valid: false, reason: "signature is not a 64-byte lowercase hex ed25519 signature" };
  }
  if (typeof attestation.signedBy !== "string" || !isLowercaseHexOfLength(attestation.signedBy, 32)) {
    return { valid: false, reason: "signedBy is not a 32-byte lowercase hex public key" };
  }

  // revocation gate runs before any hashing or verification: a revoked
  // signer's attestation is invalid regardless of its signature bytes. the
  // gate failing (read throws) is also invalid, never a silent "still live".
  let record;
  try {
    record = await storage.getAgent(attestation.signedBy);
  } catch {
    return { valid: false, reason: "revocation status could not be checked" };
  }
  if (record === null) {
    return { valid: false, reason: "agent not found" };
  }
  if (record.revokedAt !== null) {
    return { valid: false, reason: "key revoked" };
  }

  // re-derive the exact three content fields. the signature itself is never
  // part of the signed bytes, so unknown extra properties on the object
  // cannot influence the verdict.
  let canonical: string;
  try {
    canonical = canonicalize({
      task: attestation.task,
      output: attestation.output,
      toolsUsed: attestation.toolsUsed,
    });
  } catch {
    return { valid: false, reason: "attestation content could not be canonicalized" };
  }
  const computedHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (computedHash !== attestation.contentHash) {
    return { valid: false, reason: "content hash mismatch" };
  }

  const valid = await verifyAsync(
    hexToBytes(attestation.signature),
    hexToBytes(attestation.contentHash),
    hexToBytes(attestation.signedBy),
    { zip215: false },
  );
  return valid ? { valid: true, reason: null } : { valid: false, reason: "signature verification failed" };
}