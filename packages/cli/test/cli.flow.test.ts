// full-lifecycle flow tests running the REAL cli in-process via main(). every
// command is exercised against real sqlite storage and a real (injected)
// encrypted-file custody store, so the whole chain create -> attest -> score
// -> resolve -> verify -> revoke -> verify-fails is proven end to end on any
// platform, with keys leaving the test process nowhere except the temp file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { CliContext } from "../src/context.js";
import type { CliEnv } from "../src/config.js";
import { createCustody } from "../src/custody/index.js";
import { createEncryptedFileStore } from "../src/custody/encrypted-file.js";
import { main } from "../src/index.js";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.exitCode = 0;
});

function makeContext(): { ctx: Partial<CliContext>; dbPath: string; logs: string[]; errors: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "openrep-flow-"));
  tmpDirs.push(dir);
  const dbPath = join(dir, "openrep.db");
  const credentialsFile = join(dir, "credentials.enc");

  const cliEnv: CliEnv = {
    dbPath,
    signingKey: undefined,
    ownerKey: undefined,
    keychainPath: undefined,
    credentialsFile,
  };
  const custody = createCustody(cliEnv, {
    stores: [createEncryptedFileStore(credentialsFile, () => Promise.resolve("flow-test-pass"))],
    note: () => {}, // custody downgrade notices are covered in custody.test.ts
  });
  const ctx: Partial<CliContext> = { env: cliEnv, custody };

  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  console.log = (msg?: unknown) => logs.push(String(msg));
  console.error = (msg?: unknown) => errors.push(String(msg));
  (process.stderr.write as unknown as (chunk: string) => boolean) = ((chunk: string) => {
    errors.push(String(chunk));
    return true;
  }) as never;

  return {
    ctx,
    dbPath,
    logs,
    errors,
    restore: () => {
      console.log = origLog;
      console.error = origError;
      process.stderr.write = origStderrWrite as typeof process.stderr.write;
      process.exitCode = 0;
    },
  };
}

// main reads process.exitCode, which fail() may have set in an earlier step;
// reset per invocation so one failure cannot poison a later success.
async function runMain(ctx: Partial<CliContext>, args: string[]): Promise<number> {
  process.exitCode = 0;
  return main(["node", "openrep", ...args], ctx);
}

describe("cli lifecycle", () => {
  it("create -> attest x2 -> score 2 -> resolve -> verify 0 -> revoke -> verify fails", async () => {
    const c = makeContext();
    try {
      // create with --reveal-keys so the test can prove both keys come back
      // AND that the default path hides them (second create below).
      const code0 = await runMain(c.ctx, ["create", "flow-agent.agent", "--reveal-keys"]);
      expect(code0).toBe(0);
      const created = JSON.parse(c.logs[0]) as { publicKey: string; privateKey: string; ownerPrivateKey: string };
      expect(created.publicKey).toMatch(/^[0-9a-f]{64}$/);
      expect(created.privateKey).toMatch(/^[0-9a-f]{64}$/);
      expect(created.ownerPrivateKey).toMatch(/^[0-9a-f]{64}$/);

      // default create (no --reveal-keys) must never print a private key.
      c.logs.length = 0;
      const codeHide = await runMain(c.ctx, ["create", "hidden-agent.agent"]);
      expect(codeHide).toBe(0);
      const hidden = JSON.parse(c.logs[0]) as Record<string, unknown>;
      expect(hidden).not.toHaveProperty("privateKey");
      expect(hidden).not.toHaveProperty("ownerPrivateKey");

      // attest works by resolving the identity key from the encrypted file
      // (no env key, no --owner-key anywhere in this flow).
      c.logs.length = 0;
      const code1 = await runMain(c.ctx, ["attest", "-a", "flow-agent.agent", "-t", "task one", "-o", "output one"]);
      expect(code1).toBe(0);
      const att1 = JSON.parse(c.logs[0]) as { id: string; agentId: string };
      expect(att1.agentId).toBe(created.publicKey);

      // second attestation; then an idempotent retry MUST collapse to the
      // same record instead of double counting.
      c.logs.length = 0;
      const code2 = await runMain(c.ctx, [
        "attest", "-a", "flow-agent.agent", "-t", "task two", "-o", "output two", "--idempotency-key", "dup",
      ]);
      expect(code2).toBe(0);
      const att2 = JSON.parse(c.logs[0]) as { id: string };
      expect(att2.id).not.toBe(att1.id);

      c.logs.length = 0;
      const code2b = await runMain(c.ctx, [
        "attest", "-a", "flow-agent.agent", "-t", "task two", "-o", "output two", "--idempotency-key", "dup",
      ]);
      expect(code2b).toBe(0);
      const att2b = JSON.parse(c.logs[0]) as { id: string };
      expect(att2b.id).toBe(att2.id);

      // score: composite 2 from the native source.
      c.logs.length = 0;
      const codeScore = await runMain(c.ctx, ["score", "flow-agent.agent"]);
      expect(codeScore).toBe(0);
      const scoreOut = c.logs.join("\n");
      expect(scoreOut).toContain("composite:  2");
      expect(scoreOut).toContain("native           value=2 count=2");

      // resolve: manifest + score, not revoked.
      c.logs.length = 0;
      const codeRes = await runMain(c.ctx, ["resolve", "flow-agent.agent"]);
      expect(codeRes).toBe(0);
      const resOut = c.logs.join("\n");
      expect(resOut).toContain(`publicKey:       ${created.publicKey}`);
      expect(resOut).toContain("revokedAt:       -");

      // verify: the ci gate, happy path exits 0.
      c.logs.length = 0;
      const codeVer = await runMain(c.ctx, ["verify", "flow-agent.agent"]);
      expect(codeVer).toBe(0);
      expect(c.logs.join("\n")).toContain("summary: 2/2 attestations valid, manifest valid");

      // revoke via the owner key resolved from custody (no --owner-key).
      c.logs.length = 0;
      const codeRev = await runMain(c.ctx, ["revoke", "-a", "flow-agent.agent"]);
      expect(codeRev).toBe(0);
      expect(c.logs.join("\n")).toContain("revoked agent");

      // double revoke is idempotent and authorized through the same chain.
      c.logs.length = 0;
      const codeRev2 = await runMain(c.ctx, ["revoke", "-a", "flow-agent.agent"]);
      expect(codeRev2).toBe(0);

      // attest after revocation fails AGENT_REVOKED.
      c.logs.length = 0;
      const codeAtt3 = await runMain(c.ctx, ["attest", "-a", "flow-agent.agent", "-t", "task three", "-o", "out"]);
      expect(codeAtt3).toBe(1);
      expect(c.errors.join("\n")).toContain("AGENT_REVOKED");

      // verify after revocation reports the revoked state truthfully and
      // exits non-zero (the sdk fails verification with "key revoked").
      c.logs.length = 0;
      const codeVer2 = await runMain(c.ctx, ["verify", "flow-agent.agent"]);
      expect(codeVer2).toBe(1);
      const verOut = c.logs.join("\n");
      expect(verOut).toContain("key revoked");
      expect(verOut).toContain("summary: verify FAILED");
    } finally {
      c.restore();
    }
  });

  it("help and version exit 0; unknown command exits 1", async () => {
    const c = makeContext();
    try {
      process.exitCode = 0;
      const help = await runMain(c.ctx, ["--help"]);
      expect(help).toBe(0); // help text itself is asserted against the spawned bin in cli.e2e.test.ts

      c.logs.length = 0;
      process.exitCode = 0;
      const version = await runMain(c.ctx, ["--version"]);
      expect(version).toBe(0);

      c.errors.length = 0;
      process.exitCode = 0;
      const bad = await runMain(c.ctx, ["frobnicate"]);
      expect(bad).toBe(1);
      expect(c.errors.join("\n")).toContain("unknown command");
    } finally {
      c.restore();
    }
  });
});