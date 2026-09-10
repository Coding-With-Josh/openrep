// the shared command actions used by BOTH the commander commands and the
// tui. these tests pin the behavior contract the refactor must preserve:
// outcome shapes, the custody chain, dedupe via idempotency keys, and the
// verify audit summary. they run the REAL sqlite store and a real (temp-file)
// custody store, just like the flow tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliContext } from "../src/context.js";
import { buildContext } from "../src/context.js";
import { createCustody } from "../src/custody/index.js";
import { createEncryptedFileStore } from "../src/custody/encrypted-file.js";
import { apiKeyAccount, CustodyError } from "../src/custody/types.js";
import {
  actionOutcomeToCliError,
  isActionOutcomeOk,
  runAttestNative,
  runCreateAgent,
  runRevokeAgent,
  runSetVisibility,
  runVerifyAgent,
} from "../src/commands/actions.js";
import type { AgentRecord } from "@openrepso/sdk";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

function makeContext(): CliContext {
  const dir = mkdtempSync(join(tmpdir(), "openrep-actions-"));
  tmpDirs.push(dir);
  const cliEnv = {
    dbPath: join(dir, "openrep.db"),
    signingKey: undefined,
    ownerKey: undefined,
    keychainPath: undefined,
    credentialsFile: join(dir, "credentials.enc"),
  };
  const custody = createCustody(cliEnv, {
    stores: [createEncryptedFileStore(cliEnv.credentialsFile, () => Promise.resolve("actions-test-pass"))],
    note: () => {},
  });
  return buildContext(process.env, { env: cliEnv, custody });
}

describe("runCreateAgent", () => {
  it("creates an agent and takes custody of its identity key", async () => {
    const ctx = makeContext();
    const outcome = await runCreateAgent(ctx, "test-agent.agent");
    expect(isActionOutcomeOk(outcome)).toBe(true);
    if (!isActionOutcomeOk(outcome)) return;
    expect(outcome.value.publicKey).toMatch(/^[0-9a-f]{64}$/);

    // the identity key must now be resolvable from custody (the chat and
    // attest paths depend on this pairing).
    const resolution = await ctx.custody.resolveIdentityKey(outcome.value.publicKey);
    expect(resolution).not.toBeNull();
    expect(resolution?.key).toBe(outcome.value.privateKey);
  });

  it("surfaces duplicate names as an sdk error outcome", async () => {
    const ctx = makeContext();
    await runCreateAgent(ctx, "dup.agent");
    const outcome = await runCreateAgent(ctx, "dup.agent");
    expect(outcome.kind).toBe("sdk-error");
    if (outcome.kind === "sdk-error") expect(outcome.error.code).toBe("DUPLICATE_NAME");
  });

  it("defaults the stored record to public and honors an explicit private choice", async () => {
    const ctx = makeContext();
    const pub = await runCreateAgent(ctx, "visibility-default.agent");
    expect(isActionOutcomeOk(pub)).toBe(true);
    if (!isActionOutcomeOk(pub)) return;
    expect((await ctx.storage.getAgent(pub.value.publicKey))!.visibility).toBe("public");

    const priv = await runCreateAgent(ctx, "visibility-private.agent", "private");
    expect(isActionOutcomeOk(priv)).toBe(true);
    if (!isActionOutcomeOk(priv)) return;
    expect((await ctx.storage.getAgent(priv.value.publicKey))!.visibility).toBe("private");
  });
});

describe("runSetVisibility", () => {
  it("flips an agent's leaderboard visibility both directions", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "visibility-flip.agent");
    expect(isActionOutcomeOk(created)).toBe(true);
    if (!isActionOutcomeOk(created)) return;
    const record = (await ctx.storage.getAgent(created.value.publicKey))!;
    expect(record.visibility).toBe("public");

    const priv = await runSetVisibility(ctx, record, "private");
    expect(priv.kind).toBe("ok");
    if (priv.kind !== "ok") return;
    expect(priv.value.visibility).toBe("private");
    expect((await ctx.storage.getAgent(created.value.publicKey))!.visibility).toBe("private");

    const pub = await runSetVisibility(ctx, record, "public");
    expect(pub.kind).toBe("ok");
    if (pub.kind !== "ok") return;
    expect((await ctx.storage.getAgent(created.value.publicKey))!.visibility).toBe("public");
  });
});

describe("runAttestNative", () => {
  it("signs and persists a native attestation with a resolvable id", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "attester.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };

    const outcome = await runAttestNative(ctx, record, "do the thing", "did the thing", [{ tool: "calculator", input: { expression: "1+1" } }]);
    expect(isActionOutcomeOk(outcome)).toBe(true);
    if (!isActionOutcomeOk(outcome)) return;
    expect(outcome.value.source).toBe("native");
    expect(outcome.value.toolsUsed).toHaveLength(1);

    const page = await ctx.storage.getAttestations(record.publicKey, {});
    expect(page.items).toHaveLength(1);
  });

  it("dedupes retries sharing an idempotency key", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "retryer.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };

    const first = await runAttestNative(ctx, record, "same work", "same output", undefined, "turn-key-1");
    const second = await runAttestNative(ctx, record, "same work", "same output", undefined, "turn-key-1");
    if (!isActionOutcomeOk(first) || !isActionOutcomeOk(second)) throw new Error("attest failed");
    expect(second.value.id).toBe(first.value.id);

    const page = await ctx.storage.getAttestations(record.publicKey, {});
    expect(page.items).toHaveLength(1);
  });
});

describe("runRevokeAgent", () => {
  it("revokes an agent via its owner key from custody", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "revokee.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };

    const outcome = await runRevokeAgent(ctx, record);
    expect(isActionOutcomeOk(outcome)).toBe(true);
    if (!isActionOutcomeOk(outcome)) return;
    expect(outcome.value.alreadyRevoked).toBe(false);

    const stored = await ctx.storage.getAgent(record.publicKey);
    expect(stored?.revokedAt).not.toBeNull();
  });

  it("reports already-revoked on a second attempt", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "twice.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };

    const first = await runRevokeAgent(ctx, record);
    // the second attempt must observe the REVOKED row, exactly like a
    // second `openrep revoke` invocation re-fetches the agent first.
    const stored = await ctx.storage.getAgent(record.publicKey);
    expect(stored).not.toBeNull();
    const second = stored === null ? await runRevokeAgent(ctx, record) : await runRevokeAgent(ctx, stored);
    if (!isActionOutcomeOk(first) || !isActionOutcomeOk(second)) throw new Error("revoke failed");
    expect(second.value.alreadyRevoked).toBe(true);
  });

  it("rejects a malformed explicit owner key as a code error", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "badkey.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };
    const outcome = await runRevokeAgent(ctx, record, "not-hex");
    const error = actionOutcomeToCliError(outcome);
    expect(error?.code).toBe("INVALID_INPUT");
  });
});

describe("runVerifyAgent", () => {
  it("audits a clean agent as valid with matching summary text", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "audited.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };
    await runAttestNative(ctx, record, "work", "output");

    const lines: string[] = [];
    const summary = await runVerifyAgent(record, ctx.storage, (line) => lines.push(line));
    expect(summary.valid).toBe(true);
    expect(summary.failed).toBe(0);
    expect(lines).toContain("manifest: ok");
    expect(lines[lines.length - 1]).toBe("summary: 1/1 attestations valid, manifest valid");
  });

  it("flags a tampered attestation as invalid (the ci exit-code contract)", async () => {
    const ctx = makeContext();
    const created = await runCreateAgent(ctx, "tampered.agent");
    if (!isActionOutcomeOk(created)) throw new Error("create failed");
    const record: AgentRecord = {
      name: created.value.name,
      publicKey: created.value.publicKey,
      ownerPublicKey: created.value.ownerPublicKey,
      memoryPointer: created.value.memoryPointer,
      permissions: created.value.permissions,
      createdAt: created.value.createdAt,
      manifestVersion: created.value.manifestVersion,
      signature: created.value.signature,
      revokedAt: null,
      visibility: "public",
    };
    await runAttestNative(ctx, record, "work", "output");

    // tamper the raw stored row exactly like the e2e ci gate test does:
    // an update that verification must re-derive and fail closed on.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(ctx.env.dbPath);
    const result = db.prepare("UPDATE attestations SET output = ? WHERE agent_id = ?").run("TAMPERED", record.publicKey);
    if (Number(result.changes) !== 1) throw new Error("tamper update touched no rows; test is invalid");
    db.close();

    const lines: string[] = [];
    const summary = await runVerifyAgent(record, ctx.storage, (line) => lines.push(line));
    expect(summary.valid).toBe(false);
    expect(lines.some((l) => l.startsWith("  FAIL"))).toBe(true);
    expect(lines[lines.length - 1]).toContain("verify FAILED");
  });
});

describe("custody provider api key", () => {
  function makeCustody(): { custody: ReturnType<typeof createCustody>; store: ReturnType<typeof createEncryptedFileStore> } {
    const dir = mkdtempSync(join(tmpdir(), "openrep-apikey-"));
    tmpDirs.push(dir);
    const credentialsFile = join(dir, "credentials.enc");
    const store = createEncryptedFileStore(credentialsFile, () => Promise.resolve("apikey-test-pass"));
    const custody = createCustody(
      { dbPath: "", signingKey: undefined, ownerKey: undefined, keychainPath: undefined, credentialsFile },
      { stores: [store], note: () => {} },
    );
    return { custody, store };
  }

  it("stores and resolves a provider api key from the encrypted file", async () => {
    const { custody } = makeCustody();
    expect(await custody.resolveApiKey("groq")).toBeNull();

    const key = "gsk_testproviderkey123";
    await custody.storeApiKey("groq", key);

    const resolution = await custody.resolveApiKey("groq");
    expect(resolution).not.toBeNull();
    expect(resolution?.key).toBe(key);
    expect(resolution?.source).toBe("encrypted-file");
  });

  it("rejects an empty or oversized key before any store write", async () => {
    const { custody, store } = makeCustody();
    await expect(custody.storeApiKey("groq", "   ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(custody.storeApiKey("groq", "x".repeat(513))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // nothing may have been written by the rejected attempts.
    expect(await custody.resolveApiKey("groq")).toBeNull();
    // the store itself holds no account (direct probe, bypasses validation).
    expect(await store.get("apikey/groq")).toBeNull();
  });

  it("fails closed on a corrupted stored key instead of surfacing it", async () => {
    const { custody, store } = makeCustody();
    // direct write of a shape-invalid secret, simulating a damaged store.
    await store.set("apikey/groq", "   ");
    await expect(custody.resolveApiKey("groq")).rejects.toBeInstanceOf(CustodyError);
    await expect(custody.resolveApiKey("groq")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("refuses traversal-shaped provider names for the account", () => {
    expect(apiKeyAccount("groq")).toBe("apikey/groq");
    expect(() => apiKeyAccount("../evil")).toThrow(TypeError);
    expect(() => apiKeyAccount("")).toThrow(TypeError);
    expect(() => apiKeyAccount("a/b")).toThrow(TypeError);
  });
});