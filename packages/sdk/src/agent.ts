import { keygenAsync, signAsync, verifyAsync } from "@noble/ed25519";
import type { AgentId, AgentIdentity, AgentManifest, AgentPermission } from "./types/identity.js";
import type { AgentRecord, StorageAdapter } from "./types/storage.js";
import type { WrapAgentOptions, WrappedRunResult } from "./types/attestation.js";
import type { WrapAgentParams } from "./types/providers.js";
import type { Result, VerificationResult } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import { canonicalize } from "./canonical.js";
import { bytesToHex, hexToBytes, isLowercaseHexOfLength } from "./hex.js";
import { generateName } from "./names.js";
import { createProviderClient } from "./providers/index.js";
import { runAgentLoop, MAX_TURNS, MAX_RUN_MS } from "./run-loop.js";
import { attest, ATTESTATION_LIMITS } from "./attestation.js";

// crypto and encoding decisions, documented here because they are load
// bearing for every signature in the system:
// - ed25519 via @noble/ed25519 v3, async api only (keygenAsync/signAsync/
//   verifyAsync). the sync api in v3 needs a global sha512 signal to be wired
//   by hand, which is a footgun in a library, so we use the async
//   webcrypto backed provider and never mutate module globals.
// - verification uses the strict rfc8032 branch ({ zip215: false }), not the
//   more permissive zip215 default. for a reputation ledger the strict branch
//   is the correct default: it rejects signatures the loose branch accepts.
// - all keys and signatures are lowercase hex strings, confirmed earlier as
//   the codec for the whole sdk.

// schema version for the signed manifest. bumping it is a breaking change to
// the identity format, which is why it lives in exactly one constant. v2
// added the ownerPublicKey field (and a second keypair) to authorize
// revocation; v1 manifests are still verified against their exact original
// six signed fields (see the versioned branch in verifyManifest and its
// pinning test in test/agent.test.ts).
export const MANIFEST_VERSION = 2;

// bounded retries for auto-generated names. the loop exists to ride over
// collisions, never to spin, see the retry handling in createAgent.
export const NAME_GENERATION_MAX_ATTEMPTS = 10;

// the minimal permission set every new agent gets when the caller does not
// specify one. deliberately minimal: grants scopes, empty by choice would
// make a fresh agent inert in a way that confuses later passes.
export const DEFAULT_PERMISSIONS: readonly AgentPermission[] = ["attest:self"];

// the closed set of scopes enforced at validation time. keep this in sync
// with the AgentPermission union in types/identity.ts; both places are the
// guard rail against free-form strings (adversarial review: state injection).
const AGENT_PERMISSIONS: readonly AgentPermission[] = ["attest:self", "ingest:external"];

// generated names are `word-word-word.agent`, all lowercase. caller supplied
// names must match the same shape so resolve() and colliding lookups stay
// predictable. no trailing dots, no double hyphens, no uppercase, and no
// separators other than hyphen, so the name is safe to embed in urls, file
// paths, and logs.
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.agent$/;
const MAX_NAME_LENGTH = 100;

// the fields that are signed for the CURRENT schema version. the signature
// field is excluded, it is added after signing. keeping this as a named type
// means verifyManifest and createAgent cannot drift about what "the manifest
// fields" are. each schema version picks its exact own subset inside
// verifyManifest; new versions extend this type, never mutate the old bytes.
export type ManifestFields = Omit<AgentManifest, "signature">;

// options for createAgent. storage is injected rather than hardcoded so the
// function depends only on the StorageAdapter interface, never on a concrete
// backend, matching the dependency direction the rest of the sdk uses.
export interface CreateAgentOptions {
  storage: StorageAdapter;
  name?: string; // caller supplied name; omitted to auto-generate one
  memoryPointer?: string | null; // ipfs:// or https:// uri, null when unset
  permissions?: AgentPermission[]; // closed union, default is DEFAULT_PERMISSIONS
}

function isValidName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(value);
}

function isValidMemoryPointer(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  return value.startsWith("ipfs://") || value.startsWith("https://");
}

// guard: every value must be a member of the closed permission union and no
// duplicates are allowed. a scope that does not exist yet cannot be granted,
// which closes the path where a crafted manifest self-authorizes something
// the system never defined (adversarial review: state injection).
function isValidPermissions(value: unknown): value is AgentPermission[] {
  if (!Array.isArray(value)) return false;
  if (new Set(value).size !== value.length) return false;
  return value.every((p) => AGENT_PERMISSIONS.includes(p as AgentPermission));
}

// builds the AgentRecord from manifest fields by explicit pick, never by
// spreading an AgentIdentity. the record type structurally cannot carry a
// private key, and this construction keeps it that way even if AgentIdentity
// gains fields later (adversarial review: key custody, no persistence path
// can ever write key material).
function toAgentRecord(manifest: AgentManifest): AgentRecord {
  return {
    name: manifest.name,
    publicKey: manifest.publicKey,
    ownerPublicKey: manifest.ownerPublicKey,
    memoryPointer: manifest.memoryPointer,
    permissions: manifest.permissions,
    createdAt: manifest.createdAt,
    manifestVersion: manifest.manifestVersion,
    signature: manifest.signature,
    // freshly created agents are never revoked; revocation is the only
    // writer of this field, and revokedAt is set at the sdk layer only
    // after the owner-key authorization has passed. null is the honest
    // default, never an omitted property.
    revokedAt: null,
  };
}

// storage contract, see StorageAdapter.saveAgent in types/storage.ts: a name
// constraint violation surfaces as a thrown error with code exactly
// "DUPLICATE_NAME". every other throw is a generic storage failure. the
// classifier must never match on a message string, only on the code, so an
// adapter cannot accidentally masquerade an unrelated failure as a name
// conflict (adversarial review: wrong error classification on retry).
function isDuplicateNameError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "DUPLICATE_NAME";
}

async function saveAgentWithConflictHandling(
  storage: StorageAdapter,
  record: AgentRecord,
): Promise<Result<void>> {
  try {
    await storage.saveAgent(record);
    return ok(undefined);
  } catch (err) {
    if (isDuplicateNameError(err)) {
      return failure("DUPLICATE_NAME", "an agent with this name already exists");
    }
    // fail closed: a generic storage failure is never reported as success or
    // as a name conflict, and the raw error (which may carry stack traces or
    // connection details) never leaks into the public Result.
    return failure("STORAGE_WRITE_FAILED", "failed to persist the agent");
  }
}

async function signManifestFields(fields: ManifestFields, privateKeyHex: string): Promise<AgentManifest> {
  const canonical = canonicalize(fields);
  const signature = await signAsync(new TextEncoder().encode(canonical), hexToBytes(privateKeyHex));
  return { ...fields, signature: bytesToHex(signature) };
}

// every verification outcome is the same Result shape: ok true with a
// VerificationResult. the verifier never throws at the boundary and never
// returns ok false for a tampered manifest, because tampering is an expected
// outcome, not a caller error.
function verified(valid: boolean, reason: string | null): Result<VerificationResult> {
  return ok({ valid, reason });
}

/**
 * Generates a keypair + human-readable name, returns a signed manifest.
 * the returned identity includes the private key and is for internal sdk
 * use only, it must never be exposed to an api route or the browser.
 */
export async function createAgent(options: CreateAgentOptions): Promise<Result<AgentIdentity>> {
  // fail-fast validation of every caller-controlled field, before any
  // entropy, key generation, or storage work happens. an invalid option is
  // a caller bug reported as a typed error, never a crash (adversarial
  // review: state injection, fail closed on bad input).
  const explicitName = options.name === undefined ? null : options.name;
  if (explicitName !== null && !isValidName(explicitName)) {
    return failure("INVALID_INPUT", "name must match word-word-word.agent, lowercase with hyphens, under 100 chars");
  }
  const memoryPointer = options.memoryPointer === undefined ? null : options.memoryPointer;
  if (!isValidMemoryPointer(memoryPointer)) {
    return failure("INVALID_INPUT", "memoryPointer must be null or an ipfs:// or https:// uri");
  }
  const permissions = options.permissions === undefined ? [...DEFAULT_PERMISSIONS] : options.permissions;
  if (!isValidPermissions(permissions)) {
    return failure("INVALID_INPUT", "permissions must come from the closed set and contain no duplicates");
  }

  // TWO keypairs from the webcrypto backed csprng: the identity key for
  // day-to-day attestation signing, and a separate owner key that alone
  // authorizes revocation. the separation is deliberate: the key that signs
  // routine attestations is the most exposed key, so it must never also be
  // the key that can kill the agent (adversarial review: key custody, the
  // daily-use key must not double as the kill switch). only the public
  // halves go into the manifest and the record; the private halves are
  // returned straight to the caller and held nowhere else.
  let identityKeypair: { privateKey: string; publicKey: string };
  let ownerKeypair: { privateKey: string; publicKey: string };
  try {
    const identity = await keygenAsync();
    identityKeypair = { privateKey: bytesToHex(identity.secretKey), publicKey: bytesToHex(identity.publicKey) };
    const owner = await keygenAsync();
    ownerKeypair = { privateKey: bytesToHex(owner.secretKey), publicKey: bytesToHex(owner.publicKey) };
  } catch {
    // entropy unavailable is an environment failure, reported as a typed
    // error because createAgent must never throw out of a public entry
    // (fail-closed default: no identity is minted without real randomness).
    return failure("KEY_GENERATION_FAILED", "failed to generate an ed25519 keypair");
  }
  // the two keys must never coincide: equal private keys would collapse the
  // ownership separation this whole model is built on. a csprng collision is
  // astronomically unlikely, but failing loudly is cheaper than reasoning
  // about what an equal pair would mean downstream.
  if (identityKeypair.privateKey === ownerKeypair.privateKey) {
    return failure("KEY_GENERATION_FAILED", "failed to generate two distinct keypairs");
  }

  const createdAt = new Date().toISOString();
  const manifestVersion = MANIFEST_VERSION;
  const publicKey = identityKeypair.publicKey;
  const ownerPublicKey = ownerKeypair.publicKey;

  // caller supplied name: exactly one save attempt. a collision here is a
  // final answer because retrying with a new name would violate the caller's
  // explicit choice (adversarial review: state injection, no silent rename).
  if (explicitName !== null) {
    const manifest = await signManifestFields(
      { name: explicitName, publicKey, ownerPublicKey, memoryPointer, permissions, createdAt, manifestVersion },
      identityKeypair.privateKey,
    );
    const record = toAgentRecord(manifest);
    const saveResult = await saveAgentWithConflictHandling(options.storage, record);
    if (!saveResult.ok) return saveResult;
    return ok({ ...manifest, privateKey: identityKeypair.privateKey, ownerPrivateKey: ownerKeypair.privateKey });
  }

  // auto-generated name: bounded retry loop.
  // uniqueness safety comes from the storage backend's unique constraint on
  // name, not from the optimistic getAgentByName read below. two concurrent
  // calls can both see "free" and both attempt to save; the constraint is
  // what makes exactly one of them win, and the winner's conflict surfaces
  // as code DUPLICATE_NAME, which triggers a fresh name here. the read is an
  // optimization only (adversarial review: check-then-write race).
  for (let attempt = 0; attempt < NAME_GENERATION_MAX_ATTEMPTS; attempt++) {
    const name = generateName();
    try {
      const existing = await options.storage.getAgentByName(name);
      if (existing !== null) continue; // optimistic skip, optimization only
    } catch {
      // degraded mode: if the name-lookup read fails, treat the name as free
      // and let the authoritative constraint do its job on save. this keeps
      // createAgent working under a flaky read path without losing safety.
    }

    const manifest = await signManifestFields(
      { name, publicKey, ownerPublicKey, memoryPointer, permissions, createdAt, manifestVersion },
      identityKeypair.privateKey,
    );
    const record = toAgentRecord(manifest);
    const saveResult = await saveAgentWithConflictHandling(options.storage, record);
    if (saveResult.ok) return ok({ ...manifest, privateKey: identityKeypair.privateKey, ownerPrivateKey: ownerKeypair.privateKey });
    if (saveResult.error.code === "DUPLICATE_NAME") continue; // constraint fired, retry with a fresh name
    return saveResult; // generic storage failure: no retry, report and stop
  }

  // sustained collisions on every attempt would otherwise loop forever; the
  // retry cap converts that into a typed, actionable error.
  return failure(
    "NAME_GENERATION_EXHAUSTED",
    `could not find a free name after ${NAME_GENERATION_MAX_ATTEMPTS} attempts`,
  );
}

/**
 * Re-hashes the manifest fields, checks the signature against the embedded
 * public key, and gates on the agent's revocation state. returns valid true
 * only when the manifest is intact, the signature is strict rfc8032 valid,
 * and the stored record shows the agent is not revoked, with a specific
 * reason string on every failure.
 *
 * storage is mandatory for the revocation gate (decision D1): the manifest
 * itself is never trusted for revocation state, so a missing record fails
 * closed with "agent not found" rather than verifying. a revoked agent fails
 * BEFORE its signature is even checked, so revocation wins over validity.
 *
 * async because noble v3's zero-config api is async; see the crypto decision
 * note at the top of this file.
 */
export async function verifyManifest(manifest: AgentManifest, storage: StorageAdapter): Promise<Result<VerificationResult>> {
  try {
    // the input is untrusted even though the type says AgentManifest:
    // runtime data does not carry compile-time guarantees, so every field is
    // shape checked and each failure gets its own reason (adversarial
    // review: crafted manifests gain nothing from a malformed field).
    if (!isValidName(manifest.name)) {
      return verified(false, "name is not a valid agent name");
    }
    if (!isLowercaseHexOfLength(manifest.publicKey, 32)) {
      return verified(false, "publicKey is not a 32-byte lowercase hex ed25519 key");
    }
    if (!isLowercaseHexOfLength(manifest.signature, 64)) {
      return verified(false, "signature is not a 64-byte lowercase hex ed25519 signature");
    }
    if (!isValidMemoryPointer(manifest.memoryPointer)) {
      return verified(false, "memoryPointer must be null or an ipfs:// or https:// uri");
    }
    if (!isValidPermissions(manifest.permissions)) {
      return verified(false, "permissions contains a scope outside the closed set or a duplicate");
    }
    if (typeof manifest.createdAt !== "string" || Number.isNaN(Date.parse(manifest.createdAt))) {
      return verified(false, "createdAt is not a valid date");
    }
    if (typeof manifest.manifestVersion !== "number" || !Number.isInteger(manifest.manifestVersion) || manifest.manifestVersion < 1) {
      return verified(false, "manifestVersion must be a positive integer");
    }
    // unknown schema versions fail closed: a manifest claiming a version we
    // cannot canonicalize cannot have a verifiable signature shape.
    if (manifest.manifestVersion !== 1 && manifest.manifestVersion !== 2) {
      return verified(false, "manifestVersion is not a supported schema version");
    }
    // version 2 added ownerPublicKey to the signed set, so a v2 manifest
    // without a well-formed owner key is malformed. v1 never had the field,
    // so it is deliberately not demanded there.
    if (manifest.manifestVersion === 2 && !isLowercaseHexOfLength(manifest.ownerPublicKey, 32)) {
      return verified(false, "ownerPublicKey is not a 32-byte lowercase hex ed25519 key");
    }

    // revocation gate: the storage record is the single source of truth for
    // revocation state, never the manifest. this runs after the shape checks
    // (so the lookup key is a well-formed public key) and before any
    // signature verification (so a revoked agent fails here with a clean
    // reason no matter how valid its signature bytes are).
    let record: AgentRecord | null;
    try {
      record = await storage.getAgent(manifest.publicKey);
    } catch {
      // a failing read must not masquerade as "unrevoked": under a flaky
      // store the verification fails closed instead of proceeding on stale
      // nothing (fail-safe default).
      return verified(false, "agent revocation status could not be checked");
    }
    if (record === null) {
      return verified(false, "agent not found");
    }
    if (record.revokedAt !== null) {
      return verified(false, "key revoked");
    }

    // version-branched canonical. the manifest names its own schema version
    // and that field is itself signed, so this branch is tamper-safe: an
    // attacker cannot relabel a v1 manifest as v2 (or vice versa) without
    // breaking the signature, and extra unsigned properties cannot
    // influence the verdict.
    if (manifest.manifestVersion === 1) {
      // v1 (pre-revocation-pass) manifests carry exactly the original six
      // signed fields. any manifest created before the version bump must
      // still verify against those exact bytes, byte for byte. this branch
      // and its field set are pinned by the "verifies a manifest created
      // under the old v1 schema exactly as before" test, whose fixture
      // signature is computed independently with the legacy six-field
      // canonicalization, so drift here fails loudly.
      const canonical = canonicalize({
        name: manifest.name,
        publicKey: manifest.publicKey,
        memoryPointer: manifest.memoryPointer,
        permissions: manifest.permissions,
        createdAt: manifest.createdAt,
        manifestVersion: manifest.manifestVersion,
      });

      const valid = await verifyAsync(
        hexToBytes(manifest.signature),
        new TextEncoder().encode(canonical),
        hexToBytes(manifest.publicKey),
        { zip215: false },
      );
      return verified(valid, valid ? null : "signature does not match the manifest fields");
    }

    // v2, the current schema. only these seven fields are canonicalized, the
    // signature itself is never part of the signed bytes.
    const canonical = canonicalize({
      name: manifest.name,
      publicKey: manifest.publicKey,
      ownerPublicKey: manifest.ownerPublicKey,
      memoryPointer: manifest.memoryPointer,
      permissions: manifest.permissions,
      createdAt: manifest.createdAt,
      manifestVersion: manifest.manifestVersion,
    });

    const valid = await verifyAsync(
      hexToBytes(manifest.signature),
      new TextEncoder().encode(canonical),
      hexToBytes(manifest.publicKey),
      { zip215: false },
    );
    return verified(valid, valid ? null : "signature does not match the manifest fields");
  } catch {
    // catch-all: anything that still throws after the shape checks (for
    // example a strict verification failure surfaced as an exception) fails
    // as invalid, never throws out of verifyManifest.
    return verified(false, "manifest could not be verified");
  }
}

/**
 * Wraps an agent's run against a real model provider, capturing
 * task/tool calls/output and producing a signed attestation for the run.
 *
 * all dependencies (storage, signing key, provider config, tool
 * implementations, api key) are passed in explicitly. wrapAgent never reads
 * environment variables and never calls loadEnvConfig() itself.
 *
 * the run loop is bounded (MAX_TURNS turns, MAX_RUN_MS wall-clock via an
 * AbortController) and every failure path returns a typed Result. attest()
 * is only ever called once the loop converges on a final text output, so a
 * run that timed out, hit the turn cap, or failed at the provider produces
 * no attestation at all.
 */
export async function wrapAgent(
  params: WrapAgentParams,
): Promise<Result<WrappedRunResult>> {
  // --- perimeter checks: validate before any provider call ---
  if (typeof params.task !== "string") {
    return failure("INVALID_INPUT", "task must be a string");
  }
  if (typeof params.signingKey !== "string" || !isLowercaseHexOfLength(params.signingKey, 32)) {
    return failure("INVALID_INPUT", "signingKey must be 32-byte lowercase hex");
  }
  if (typeof params.apiKey !== "string" || params.apiKey.length === 0) {
    return failure("INVALID_INPUT", "apiKey must be a non-empty string");
  }
  if (!Array.isArray(params.config.tools)) {
    return failure("INVALID_INPUT", "config.tools must be an array");
  }
  if (typeof params.config.model !== "string" || params.config.model.length === 0) {
    return failure("INVALID_INPUT", "config.model must be a non-empty string");
  }

  // attest()-parity size pre-checks: catch oversized input before spending
  // a provider call. attest() stays the authoritative backstop.
  if (params.task.length > ATTESTATION_LIMITS.maxTaskLength) {
    return failure(
      "INPUT_TOO_LARGE",
      `task exceeds ${ATTESTATION_LIMITS.maxTaskLength} characters`,
    );
  }

  // failing to construct the client (unknown provider) is a programming
  // error in the caller, not a runtime provider failure; let it throw.
  const client = createProviderClient(params.config, params.apiKey);

  const loopResult = await runAgentLoop(
    client,
    params.config,
    params.tools,
    params.task,
  );
  if (!loopResult.ok) {
    return loopResult; // TURN_LIMIT_EXCEEDED / RUN_TIMED_OUT / UNREGISTERED_TOOL / TOOL_ARGUMENT_INVALID / PROVIDER_API_FAILURE
  }

  // converged: the loop produced final output plus captured tool calls. this
  // is the ONLY path that calls attest(). a non-converged run never reaches
  // here, so no partial or fabricated attestation is ever signed.
  const { output, toolsUsed, turns } = loopResult.value;
  const options: WrapAgentOptions = params.options ?? {};

  const attestationResult = await attest(
    {
      agentId: params.agentId,
      task: params.task,
      output,
      toolsUsed,
      source: options.source ?? "native",
      idempotencyKey: options.idempotencyKey,
    },
    params.signingKey,
    params.storage,
  );
  if (!attestationResult.ok) {
    return attestationResult; // propagated unchanged, never re-wrapped
  }

  return ok({ output, toolsUsed, turns, attestation: attestationResult.value });
}