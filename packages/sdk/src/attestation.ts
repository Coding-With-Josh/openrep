import { getPublicKeyAsync, signAsync, verifyAsync } from "@noble/ed25519";
import { createHash, randomUUID } from "node:crypto";
import type { AgentId } from "./types/identity.js";
import type {
  Attestation,
  AttestationInput,
  ExternalAttestation,
  ExternalVerification,
  IngestOptions,
  ToolCall,
} from "./types/attestation.js";
import type { Result, VerificationResult } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import type { NormalizedExternalAttestation, SourceAdapter } from "./types/sources.js";
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

// upper bound for an ingest source's declared name. bounded so adapter
// names stay within error-message and log sizes; the value itself is a
// judgment call, the property it protects is that bogus adapter metadata
// cannot drive unbounded output.
const MAX_SOURCE_NAME_LENGTH = 64;

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

// the shared phase-1 shape and size validation for every signing path.
// read-only, no crypto, no storage, so crafted input is rejected before it
// consumes any work. shared by attest() (caller input → INVALID_INPUT /
// INPUT_TOO_LARGE) and ingest() (adapter output → MALFORMED_EXTERNAL_ATTESTATION),
// and re-run inside the signing core as defense in depth, so a future
// careless caller cannot persist unvalidated content through the one place
// that signs. the failure payloads carry the exact messages attest() has
// always produced, keeping its observable behavior byte-identical.
type ContentCheckResult =
  | { kind: "valid"; toolsUsed: ToolCall[] }
  | { kind: "invalid"; message: string }
  | { kind: "too-large"; message: string };

interface ContentToValidate {
  agentId: unknown;
  signingKey: unknown;
  task: unknown;
  output: unknown;
  toolsUsed: unknown;
}

function validateAttestationContent(content: ContentToValidate): ContentCheckResult {
  if (!isLowercaseHexOfLength(content.agentId as string, 32)) {
    return { kind: "invalid", message: "agentId must be 32-byte lowercase hex" };
  }
  if (!isLowercaseHexOfLength(content.signingKey as string, 32)) {
    return { kind: "invalid", message: "signingKey must be 32-byte lowercase hex" };
  }
  if (typeof content.task !== "string") {
    return { kind: "invalid", message: "task must be a string" };
  }
  if (content.task.length > MAX_TASK_LENGTH) {
    return { kind: "too-large", message: `task exceeds ${MAX_TASK_LENGTH} characters` };
  }
  if (typeof content.output !== "string") {
    return { kind: "invalid", message: "output must be a string" };
  }
  if (content.output.length > MAX_OUTPUT_LENGTH) {
    return { kind: "too-large", message: `output exceeds ${MAX_OUTPUT_LENGTH} characters` };
  }
  const toolsChecked = toolEntriesValid(content.toolsUsed ?? []);
  if (toolsChecked === "invalid") {
    return {
      kind: "invalid",
      message: "toolsUsed entry is malformed, not canonicalizable, or contains invalid field types",
    };
  }
  if (toolsChecked === "too-large") {
    return {
      kind: "too-large",
      message: `toolsUsed exceeds ${MAX_TOOLS_USED_ENTRIES} entries, a tool name of ${MAX_TOOL_NAME_LENGTH} characters, or an entry of ${MAX_TOOL_ENTRY_SERIALIZED_LENGTH} canonical characters per entry`,
    };
  }
  // the whole content, not just each entry in isolation, must canonicalize:
  // the signing core hashes { task, output, toolsUsed } as one unit and
  // canonicalize's depth budget is measured from that root. an entry that
  // passes toolEntriesValid standalone still overflows the budget once it
  // sits one level deeper inside toolsUsed (a nested array in a tool output
  // is exactly the live depth-6 crash), so validation re-runs the same
  // canonicalization the signer will perform and converts a depth or cycle
  // failure into the typed "invalid" path instead of an uncaught throw.
  try {
    canonicalize({ task: content.task, output: content.output, toolsUsed: toolsChecked });
  } catch {
    return {
      kind: "invalid",
      message: "attestation content is not canonicalizable: nested values exceed the depth budget or contain a cycle",
    };
  }
  return { kind: "valid", toolsUsed: toolsChecked };
}

// strips storage internals (rowId, idempotencyKey) off a persisted record so
// the portable Attestation returned to callers stays the exact shape that is
// signed and verifiable. the additive externalVerification metadata is
// provenance only and is surfaced as null when a record has none, so callers
// distinguish "no check ran" (null) from "no check exists" (absent field on
// the type).
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
    externalVerification: record.externalVerification ?? null,
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
  const checked = validateAttestationContent({
    agentId: input.agentId,
    signingKey,
    task: input.task,
    output: input.output,
    toolsUsed: input.toolsUsed,
  });
  if (checked.kind === "invalid") return failure("INVALID_INPUT", checked.message);
  if (checked.kind === "too-large") return failure("INPUT_TOO_LARGE", checked.message);

  // phase 2: firm source boundary. external sources belong to ingest();
  // attest() never accepts them, keeping the native ledger distinguishable
  // from imported platform data at the schema level.
  if (input.source !== NATIVE_SOURCE) {
    return failure(
      "INVALID_SOURCE",
      `attest() only accepts source "native", got ${input.source === undefined ? "(missing)" : `"${input.source}"`}`,
    );
  }

  // phase 3+: the shared signing core. the same revocation gate, key
  // correspondence, idempotency arbitration, hashing, signing, and
  // persistence that ingest() runs through, so no path to a signed,
  // persisted attestation can skip any of those checks.
  return signAndPersistAttestation(
    {
      agentId: input.agentId,
      task: input.task,
      output: input.output,
      toolsUsed: checked.toolsUsed,
      source: NATIVE_SOURCE,
      timestamp: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey,
    },
    signingKey,
    storage,
  );
}

// the private shared core behind both attest() and ingest(). every signed,
// persisted attestation flows through here, which makes the guarantees
// single-point: the revocation gate, the key-correspondence check, the
// idempotency arbitration, and the signed-bytes invariant live in exactly
// one place, and a new ingest source cannot bypass any of them. callers
// validate content and source shape before calling; the core re-checks the
// content invariants and timestamp as defense in depth, so even a future
// careless caller cannot persist unvalidated content through the one place
// that signs. the flow mirrors attest()'s historical behavior exactly,
// including storage call order and error codes (that is what the C1
// regression gate locks).
async function signAndPersistAttestation(
  params: {
    agentId: string;
    task: string;
    output: string;
    toolsUsed: ToolCall[];
    source: string;
    timestamp: string;
    idempotencyKey?: string;
    externalVerification?: ExternalVerification | null;
  },
  signingKey: string,
  storage: StorageAdapter,
): Promise<Result<Attestation>> {
  // defense-in-depth revalidation of content and key shape. unreachable for
  // both current callers (each validates first), but load-bearing for the
  // invariant that nothing is signed or persisted that failed the ledger's
  // own shape and size checks (adversarial review: forged normalized output).
  const rechecked = validateAttestationContent({
    agentId: params.agentId,
    signingKey,
    task: params.task,
    output: params.output,
    toolsUsed: params.toolsUsed,
  });
  if (rechecked.kind === "invalid") return failure("INVALID_INPUT", rechecked.message);
  if (rechecked.kind === "too-large") return failure("INPUT_TOO_LARGE", rechecked.message);

  // the source name is metadata, but it must exist: a record without a
  // source would be unweightable by getScore. both callers guarantee a
  // non-empty value before reaching here.
  if (typeof params.source !== "string" || params.source.length === 0) {
    return failure("INVALID_INPUT", "source must be a non-empty string");
  }

  // the timestamp lands in every persisted record and getScore() feeds it
  // straight into Date.parse for the breakdown's lastUpdated, so it must be
  // a parseable instant or the signing work is refused. ingest() pre-checks
  // with MALFORMED_EXTERNAL_ATTESTATION; this is the same invariant re-checked
  // at the one place that signs.
  if (typeof params.timestamp !== "string" || Number.isNaN(Date.parse(params.timestamp))) {
    return failure("INVALID_INPUT", "timestamp must be a parseable iso 8601 instant");
  }

  // phase 3: revocation pre-check. the storage record is the single source
  // of truth for both "does this agent exist" and "is it revoked", and it is
  // checked BEFORE any key derivation, hashing, or signing work. a revoked
  // agent is refused with AGENT_REVOKED no matter how valid the caller's
  // key is, and an unknown agent fails closed with AGENT_NOT_FOUND. a
  // failing read is never treated as "not revoked": under a flaky store the
  // attestation fails closed rather than proceeding on stale nothing.
  // (adversarial review: a revoked agent must not be able to resume signing
  // through ingest(), so this gate is shared, not duplicated.)
  let agentRecord;
  try {
    agentRecord = await storage.getAgent(params.agentId);
  } catch {
    return failure("STORAGE_WRITE_FAILED", "could not check the agent's revocation status");
  }
  if (agentRecord === null) {
    return failure("AGENT_NOT_FOUND", `unknown agent: ${params.agentId}`);
  }
  if (agentRecord.revokedAt !== null) {
    return failure("AGENT_REVOKED", "agent has been revoked and cannot sign new attestations");
  }

  // phase 4: key correspondence. the agentId IS the derived public key per
  // the identity decision, so the provided signing key either derives to the
  // claimed agent or the caller is using the wrong key.
  // (adversarial review: agent substitution — an attacker cannot mint an
  // attestation "for" an agent without that agent's private key, because the
  // key must derive exactly to the claimed agentId.)
  let signedBy: string;
  try {
    signedBy = bytesToHex(await getPublicKeyAsync(hexToBytes(signingKey)));
  } catch {
    return failure("KEY_MISMATCH", "signing key could not be used to derive a public key");
  }
  if (signedBy !== params.agentId) {
    return failure("KEY_MISMATCH", "signing key does not match the claimed agent");
  }

  const idempotencyKey = params.idempotencyKey;
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
      existing = await storage.getAttestationByIdempotencyKey(params.agentId, idempotencyKey);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      return ok(toPortable(existing));
    }
  }

  // phase 5: hash and sign. only the three content fields are canonicalized,
  // never the signature, metadata, or externalVerification, so unknown extra
  // properties on the input object cannot influence the signed bytes and no
  // verification provenance can be retrofitted into the signature. this is
  // the signed-bytes invariant: canonicalize stays exactly
  // { task, output, toolsUsed }, locked by a dedicated test. sign over the
  // sha-256 content hash bytes, not the raw canonical text, per the plan.
  // the validator re-checks this same canonicalization, so reaching here
  // means a future code path skipped validation; fail closed as a typed
  // error instead of letting a depth or cycle throw escape as an anonymous
  // INTERNAL failure (the live web_search depth-6 crash path).
  let canonical: string;
  try {
    canonical = canonicalize({ task: params.task, output: params.output, toolsUsed: params.toolsUsed });
  } catch {
    return failure(
      "INVALID_INPUT",
      "attestation content is not canonicalizable: nested values exceed the depth budget or contain a cycle",
    );
  }
  const contentHash = createHash("sha256").update(canonical, "utf8").digest("hex");
  const signature = bytesToHex(await signAsync(hexToBytes(contentHash), hexToBytes(signingKey)));
  const timestamp = params.timestamp;
  // randomUUID rather than a content derived id: hash based ids would bump
  // into the unique attestations.id constraint when two legitimate runs
  // produce identical content, which must be allowed.
  const id = randomUUID();

  const record: AttestationRecord = {
    rowId: 0, // assigned by the store on insert
    id,
    agentId: params.agentId,
    task: params.task,
    output: params.output,
    toolsUsed: params.toolsUsed,
    source: params.source,
    contentHash,
    signature,
    signedBy,
    timestamp,
    schemaVersion: ATTESTATION_SCHEMA_VERSION,
    idempotencyKey,
    externalVerification: params.externalVerification,
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
          const existing = await storage.getAttestationByIdempotencyKey(params.agentId, idempotencyKey);
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
      return failure("AGENT_NOT_FOUND", `unknown agent: ${params.agentId}`);
    }
    return failure("STORAGE_WRITE_FAILED", "attestation could not be saved");
  }

  return ok(toPortable(record));
}

/**
 * Ingests an external platform's evidence about an agent, normalized through
 * the supplied SourceAdapter, into the ledger as a signed attestation.
 *
 * the adapter is injected (dependency inversion): the caller supplies the
 * platform-specific normalization and optional integrity check, and the
 * ledger stays generic. every guarantee of attest() applies unchanged —
 * same signing key requirement (agentId = derived public key), same
 * revocation gate, same idempotency arbitration — because both run through
 * the same private signing core.
 *
 * trust model, deliberately explicit: a source adapter is code supplied by
 * the caller, and its output is treated as untrusted and re-validated field
 * by field against the ledger's own shape and size rules before anything is
 * signed. an optional validate() verdict is provenance metadata only (it can
 * block an ingest but can never authorize one), and a throwing or malformed
 * check fails closed with EXTERNAL_ATTESTATION_INVALID. no source needs
 * pre-registration to be ingested: an unregistered source counts toward the
 * agent's visible history at weight 0 in getScore until saveRegisteredSource
 * gives it a trust weight.
 */
export async function ingest(
  externalAttestation: ExternalAttestation,
  sourceAdapter: SourceAdapter,
  signingKey: string,
  storage: StorageAdapter,
  options: IngestOptions = {},
): Promise<Result<Attestation>> {
  // phase 1: the source adapter itself must be well formed. a missing or
  // overlong source name, or a missing normalize, means the caller handed us
  // an unusable adapter — INVALID_SOURCE, the same boundary vocabulary
  // attest() uses, never MALFORMED (the record itself may be fine).
  if (
    typeof sourceAdapter.sourceName !== "string" ||
    sourceAdapter.sourceName.length === 0 ||
    sourceAdapter.sourceName.length > MAX_SOURCE_NAME_LENGTH
  ) {
    return failure("INVALID_SOURCE", `source adapter must declare a non-empty source name of at most ${MAX_SOURCE_NAME_LENGTH} characters`);
  }
  if (typeof sourceAdapter.normalize !== "function") {
    return failure("INVALID_SOURCE", "source adapter must implement normalize()");
  }
  // the signing key is caller input, not adapter output: a structurally bad
  // key is INVALID_INPUT (attest()'s vocabulary), never MALFORMED, which is
  // reserved for adapter-produced content.
  if (!isLowercaseHexOfLength(signingKey, 32)) {
    return failure("INVALID_INPUT", "signingKey must be 32-byte lowercase hex");
  }
  // the native source is the ledger's own proof of work; importing it back
  // in through an external path would let a caller launder native entries or
  // forge "native" evidence. (adversarial review: source boundary is
  // enforced on ingress as well as on attest().)
  if (sourceAdapter.sourceName === NATIVE_SOURCE) {
    return failure("INVALID_SOURCE", `ingest() never accepts the native source, got "${NATIVE_SOURCE}"`);
  }

  // phase 2: the raw record must declare the same source as the adapter, so
  // platform data can never be routed through the wrong adapter and stamped
  // with the wrong source name. (adversarial review: state injection — a
  // crafted raw record claiming to be from another platform is rejected
  // before any adapter logic runs.)
  if (typeof externalAttestation.sourceName !== "string" || externalAttestation.sourceName !== sourceAdapter.sourceName) {
    return failure(
      "MALFORMED_EXTERNAL_ATTESTATION",
      `raw record sourceName does not match the adapter's source ${sourceAdapter.sourceName}`,
    );
  }

  // phase 3: optional external integrity check, recorded as provenance. the
  // verdict can block the ingest but can never authorize one; the agent's
  // own key signs the normalized statement regardless. a throwing or
  // malformed check is fail-closed: EXTERNAL_ATTESTATION_INVALID, never a
  // silent "checked and valid" pass. (adversarial review: an outage in a
  // validating adapter must not degrade to unverified success.)
  let externalVerification: ExternalVerification;
  if (sourceAdapter.validate !== undefined) {
    let verdict: VerificationResult;
    try {
      verdict = sourceAdapter.validate(externalAttestation);
    } catch {
      return failure(
        "EXTERNAL_ATTESTATION_INVALID",
        "external validation threw; failing closed instead of treating the record as checked",
      );
    }
    if (
      verdict === null ||
      typeof verdict !== "object" ||
      typeof verdict.valid !== "boolean" ||
      !(verdict.reason === null || typeof verdict.reason === "string")
    ) {
      return failure("EXTERNAL_ATTESTATION_INVALID", "external validation returned a malformed verdict");
    }
    if (!verdict.valid) {
      return failure("EXTERNAL_ATTESTATION_INVALID", "external validation failed; nothing was ingested");
    }
    externalVerification = { checked: true, valid: true, reason: null };
  } else {
    // no validate() on the adapter means the platform does no cryptographic
    // signing of its records; the truth is recorded honestly as unverified
    // rather than pretending a check ran.
    externalVerification = { checked: false, valid: null, reason: null };
  }

  // phase 4: normalize the raw record into the content subset. the adapter
  // is the only piece that understands the platform's shape, but its output
  // is untrusted: a throwing normalize, a non-object result, or content that
  // fails the ledger's own shape and size validation is
  // MALFORMED_EXTERNAL_ATTESTATION and never reaches the signing core.
  // (adversarial review: a malicious or buggy adapter cannot smuggle fields
  // past the validator or force content through the signed bytes.)
  let normalized: NormalizedExternalAttestation;
  try {
    normalized = sourceAdapter.normalize(externalAttestation);
  } catch {
    return failure("MALFORMED_EXTERNAL_ATTESTATION", "source adapter normalization threw");
  }
  if (normalized === null || typeof normalized !== "object") {
    return failure("MALFORMED_EXTERNAL_ATTESTATION", "source adapter returned no normalized record");
  }
  const checked = validateAttestationContent({
    agentId: normalized.agentId,
    signingKey,
    task: normalized.task,
    output: normalized.output,
    toolsUsed: normalized.toolsUsed,
  });
  if (checked.kind !== "valid") {
    return failure("MALFORMED_EXTERNAL_ATTESTATION", "source adapter returned content that failed ledger validation");
  }
  // the external timestamp is honored as the attestation's timestamp so the
  // record reflects when the work actually happened. it must be a parseable
  // instant: getScore() feeds it straight into Date.parse for the
  // breakdown's lastUpdated, so garbage here would poison scoring.
  if (typeof normalized.timestamp !== "string" || Number.isNaN(Date.parse(normalized.timestamp))) {
    return failure("MALFORMED_EXTERNAL_ATTESTATION", "source adapter returned an unparseable timestamp");
  }

  // phase 5: the shared signing core — identical treatment to attest():
  // defense-in-depth revalidation, revocation gate, key correspondence,
  // idempotency arbitration, signed-bytes invariant, and persistence.
  return signAndPersistAttestation(
    {
      agentId: normalized.agentId,
      task: normalized.task,
      output: normalized.output,
      toolsUsed: checked.toolsUsed,
      source: sourceAdapter.sourceName,
      timestamp: normalized.timestamp,
      idempotencyKey: options.idempotencyKey,
      externalVerification,
    },
    signingKey,
    storage,
  );
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