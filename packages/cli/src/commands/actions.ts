// shared command logic, used by BOTH the commander handlers (src/commands/*)
// and the interactive tui (src/ui/*). every non-interactive command keeps
// its exact observable behavior (same stderr strings, same exit codes, same
// stdout json); the tui renders the same outcomes inline instead.
//
// each action returns a plain outcome object rather than printing, so the
// two surfaces choose their own output sinks. custody hard failures throw
// CustodyError exactly as the command files always let them (the commander
// handers normalize via handleCustodyError; the tui catches and renders).

import { createAgent, attest, canonicalize, revokeAgent, setVisibility, verifyAttestation, verifyManifest, type AgentRecord, type AgentManifest, type AgentVisibility, type Attestation, type OpenRepError, type StorageAdapter, type ToolCall } from "@openrepso/sdk";
import { signAsync } from "@noble/ed25519";

import { SCORE_PAGE_LIMIT } from "@openrepso/sdk";
import type { CliContext } from "../context.js";
import { bytesToHex, hexToBytes, isEd25519PrivateKeyHex } from "../hex.js";
import { CustodyError } from "../custody/types.js";

// outcome vocabulary shared by every action below.
export type ActionOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "sdk-error"; error: OpenRepError }
  | { kind: "code-error"; code: string; message: string };

export function isActionOutcomeOk<T>(outcome: ActionOutcome<T>): outcome is { kind: "ok"; value: T } {
  return outcome.kind === "ok";
}

// shared helper: the tui and the commander wrappers both render sdk failures
// via the cli's "<CODE>: <message>" contract. the tui prints it inline; the
// commander wrappers call fail() to set exitCode 1 the same way as before.
export function actionOutcomeToCliError<T>(outcome: ActionOutcome<T>): { code: string; message: string } | null {
  switch (outcome.kind) {
    case "ok":
      return null;
    case "sdk-error":
      return { code: outcome.error.code, message: outcome.error.message };
    case "code-error":
      return { code: outcome.code, message: outcome.message };
  }
}

function codeError(code: string, message: string): ActionOutcome<never> {
  return { kind: "code-error", code, message };
}

// --- create ----------------------------------------------------------------
// creates the agent, then takes custody of both keys. CustodyError (no store
// accepted the keys) propagates as a throw so the caller can decide how to
// surface it; the agent row is NOT rolled back, matching today's command
// behavior exactly (the created row stays, the keys just are not recoverable).
export async function runCreateAgent(
  ctx: CliContext,
  name: string | undefined,
  visibility: AgentVisibility = "public",
): Promise<ActionOutcome<import("@openrepso/sdk").AgentIdentity>> {
  // visibility arrives already narrowed to {public, private} by the command
  // layer's mutually-exclusive flag parsing; the sdk validates it again as
  // the last line of defense against any future caller passing raw input.
  const result = await createAgent({ storage: ctx.storage, name, visibility });
  if (!result.ok) return { kind: "sdk-error", error: result.error };
  await ctx.custody.storeAgentKeys(result.value); // throws CustodyError on total failure
  return { kind: "ok", value: result.value };
}

// --- attest ----------------------------------------------------------------
// resolves the identity key for an agent record and signs a native
// attestation. mirrors the attest command's flow: custody resolution
// (throwing CustodyError on a malformed stored key), then the sdk attests.
// source is deliberately closed to "native" here, matching the command.
export async function runAttestNative(
  ctx: CliContext,
  record: AgentRecord,
  task: string,
  output: string,
  toolsUsed?: ToolCall[],
  idempotencyKey?: string,
): Promise<ActionOutcome<Attestation>> {
  const resolution = await ctx.custody.resolveIdentityKey(record.publicKey); // throws CustodyError
  if (resolution === null) {
    return codeError(
      "KEYCHAIN_UNAVAILABLE",
      `no identity signing key available for agent ${record.publicKey}; set OPENREP_SIGNING_KEY or run "openrep create" for this agent first`,
    );
  }
  const result = await attest(
    {
      agentId: record.publicKey,
      task,
      output,
      toolsUsed,
      source: "native",
      idempotencyKey,
    },
    resolution.key,
    ctx.storage,
  );
  if (!result.ok) return { kind: "sdk-error", error: result.error };
  return { kind: "ok", value: result.value };
}

// --- revoke ----------------------------------------------------------------
// resolves the owner key (explicit hex from --owner-key, or custody) and
// issues the revocation request. the sdk re-derives the public key and
// verifies the signature against the STORED owner key, so custody here is
// only key supply, never the authorization decision. custody hard failures
// throw CustodyError; the owner key shape check is a code-error to match the
// command's INVALID_INPUT wording.
export async function runRevokeAgent(
  ctx: CliContext,
  record: AgentRecord,
  ownerKeyHex?: string,
): Promise<ActionOutcome<{ alreadyRevoked: boolean }>> {
  let ownerKey: string;
  if (ownerKeyHex !== undefined) {
    if (!isEd25519PrivateKeyHex(ownerKeyHex)) {
      return codeError("INVALID_INPUT", "--owner-key must be a 64-char lowercase hex ed25519 private key");
    }
    ownerKey = ownerKeyHex;
  } else {
    const resolution = await ctx.custody.resolveOwnerKey(record.publicKey); // throws CustodyError
    if (resolution === null) {
      return codeError(
        "KEYCHAIN_UNAVAILABLE",
        `no owner key available for agent ${record.publicKey}; use --owner-key or set OPENREP_OWNER_KEY`,
      );
    }
    ownerKey = resolution.key;
  }

  // the revocation request signs exactly the canonicalized { agentId,
  // timestamp }, matching the sdk's request contract.
  const timestamp = new Date().toISOString();
  const canonical = canonicalize({ agentId: record.publicKey, timestamp });
  const signature = bytesToHex(await signAsync(new TextEncoder().encode(canonical), hexToBytes(ownerKey)));

  const result = await revokeAgent({ agentId: record.publicKey, timestamp, signature }, ctx.storage);
  if (!result.ok) return { kind: "sdk-error", error: result.error };
  return { kind: "ok", value: { alreadyRevoked: record.revokedAt !== null } };
}

// --- visibility ------------------------------------------------------------
// changes the agent's leaderboard visibility. this is deliberately NOT an
// ownership-separated operation in the sdk: the sdk treats it as a dumb
// storage write, and authorization lives where the surface decides it (the
// cli owns its local db; the web route gates ownership before calling the
// sdk). the sdk itself still refuses unknown ids and malformed values.
export async function runSetVisibility(
  ctx: CliContext,
  record: AgentRecord,
  visibility: AgentVisibility,
): Promise<ActionOutcome<{ visibility: AgentVisibility }>> {
  const result = await setVisibility(record.publicKey, visibility, ctx.storage);
  if (!result.ok) return { kind: "sdk-error", error: result.error };
  return { kind: "ok", value: { visibility } };
}

// --- verify ----------------------------------------------------------------
// the ci gate, extracted from the verify command so the tui's "v" key runs
// the exact same audit without forking a child process. emit receives each
// rendered line (the command passes console.log, the tui passes a buffer).
// returns the audit summary. NOTE: this does NOT set process.exitCode; the
// commander wrapper does that so the non-interactive gate keeps its zero /
// non-zero contract while the tui renders the same result inline.
export async function runVerifyAgent(
  record: AgentRecord,
  storage: StorageAdapter,
  emit: (line: string) => void,
): Promise<{ valid: boolean; checked: number; failed: number }> {
  let valid = true;

  // the stored row is untrusted input to the verifier: the boundary cast is
  // deliberate (AgentRecord widens ownerPublicKey to null) and verifyManifest
  // shape-checks every field itself.
  const manifestResult = await verifyManifest(record as unknown as AgentManifest, storage);
  if (!manifestResult.ok) {
    emit(`manifest: FAIL (${manifestResult.error.message})`);
    valid = false;
  } else if (manifestResult.value.valid) {
    emit("manifest: ok");
  } else {
    emit(`manifest: FAIL (${manifestResult.value.reason ?? "invalid"})`);
    valid = false;
  }

  let checked = 0;
  let failed = 0;
  let cursor: string | undefined;
  for (;;) {
    const page = await storage.getAttestations(record.publicKey, { cursor, limit: SCORE_PAGE_LIMIT });
    for (const attestation of page.items) {
      checked += 1;
      const verdict = await verifyAttestation(attestation, storage);
      if (verdict.valid) {
        emit(`  ok    ${attestation.id}  ${attestation.timestamp}`);
      } else {
        emit(`  FAIL  ${attestation.id}  ${verdict.reason ?? "invalid"}`);
        failed += 1;
      }
    }
    if (page.nextCursor === null || page.items.length === 0) break;
    cursor = page.nextCursor;
  }

  const okCount = checked - failed;
  // the ci contract: the audit passes only when the manifest is valid AND
  // every attestation verifies. a manifest that passes with failed rows is
  // still a failed audit (the return value feeds both the command's exit
  // code and the tui's red badge).
  const passed = valid && failed === 0;
  if (passed) {
    emit(`summary: ${okCount}/${checked} attestations valid, manifest valid`);
  } else {
    emit(`summary: verify FAILED (${okCount}/${checked} attestations valid, manifest ${valid ? "valid" : "invalid"})`);
  }
  return { valid: passed, checked, failed };
}