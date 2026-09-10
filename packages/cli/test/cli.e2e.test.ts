// end-to-end tests that spawn the REAL built binary (dist/bin.js) as a
// child process, asserting exit codes and stdout/stderr contracts exactly as
// a shell user would see them. the test script builds before running, so
// dist is always current.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { attest, createAgent, createSqliteStorage, type AgentIdentity } from "@openrepso/sdk";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// hermetic spawned environment: the developer's real OPENREP_* vars must
// never leak into a child process, only the explicitly listed overrides do.
function cliEnvFor(dir: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENREP_SIGNING_KEY;
  delete env.OPENREP_OWNER_KEY;
  delete env.OPENREP_KEYCHAIN_PATH;
  delete env.OPENREP_CREDENTIALS_FILE;
  env.OPENREP_DB_PATH = join(dir, "openrep.db");
  return { ...env, ...overrides };
}

interface TempCtx {
  dir: string;
  env: NodeJS.ProcessEnv;
  dispose(): void;
}
function tempCtx(overrides: Record<string, string> = {}): TempCtx {
  const dir = mkdtempSync(join(tmpdir(), "openrep-e2e-"));
  const env = cliEnvFor(dir, overrides);
  let disposed = false;
  return {
    dir,
    env,
    dispose: () => {
      if (!disposed) rmSync(dir, { recursive: true, force: true });
      disposed = true;
    },
  };
}
const contexts: TempCtx[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
});

// seed an agent + one attestation directly through the sdk, returning the
// identity (whose private key becomes the OPENREP_SIGNING_KEY for children)
// plus an env whose OPENREP_DB_PATH points at the SAME seeded database file.
async function seedAgentAndAttestation(dbPath: string): Promise<{ identity: AgentIdentity; env: NodeJS.ProcessEnv; attestationId: string }> {
  const storage = createSqliteStorage(dbPath);
  // createAgent is async: it awaits the optimistic name-collision check.
  const created = await createAgent({ storage, name: "seeded-agent.agent" });
  if (!created.ok) throw new Error(`seed create failed: ${created.error.message}`);
  const identity = created.value;
  const attResult = await attest(
    { agentId: identity.publicKey, task: "seeded task", output: "seeded output", source: "native" },
    identity.privateKey,
    storage,
  );
  if (!attResult.ok) throw new Error(`seed attest failed: ${attResult.error.message}`);
  const attestationId = attResult.value.id;
  // cliEnvFor takes the PARENT DIR and re-joins openrep.db so the child
  // process reads exactly the database the seed just wrote.
  const env = cliEnvFor(dirname(dbPath), { OPENREP_SIGNING_KEY: identity.privateKey });
  return { identity, env, attestationId };
}

describe("spawned binary", () => {
  it("bare openrep refuses the interactive tui on a non-tty and exits 0", async () => {
    // the child's stdout is a pipe (not a tty), so the tui must be refused
    // with a one-line stderr message and exit 0, which is also the historical
    // bare-openrep exit code (help used to print and exit 0). the interactive
    // tui itself is exercised by the renderToString smoke tests; full-keyboard
    // flows need a pty harness and are intentionally not part of vitest.
    const c = tempCtx();
    const result = await runCli([], c.env);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("interactive session requires a terminal");
    expect(result.stderr).toContain("openrep --help");
    // the tui must not have rendered anything to a pipe.
    expect(result.stdout).not.toContain("platform-agnostic reputation layer");
  });

  it("create stores keys in a throwaway keychain; private keys print only with --reveal-keys", async (ctx) => {
    if (process.platform !== "darwin") ctx.skip(); // security is a macos tool
    const dir = mkdtempSync(join(tmpdir(), "openrep-e2e-kc-"));
    contexts.push({ dir, env: cliEnvFor(dir), dispose: () => rmSync(dir, { recursive: true, force: true }) });
    const keychainPath = join(dir, "test.keychain-db");
    execFileSync("security", ["create-keychain", "-p", "testpass", keychainPath], { stdio: "ignore" });
    execFileSync("security", ["unlock-keychain", "-p", "testpass", keychainPath], { stdio: "ignore" });
    const env = { ...cliEnvFor(dir), OPENREP_KEYCHAIN_PATH: keychainPath };

    const hidden = await runCli(["create", "kc-agent.agent"], env);
    expect(hidden.code).toBe(0);
    const hiddenOut = JSON.parse(hidden.stdout) as Record<string, unknown>;
    expect(hiddenOut).not.toHaveProperty("privateKey");
    expect(hiddenOut).not.toHaveProperty("ownerPrivateKey");
    expect(hidden.stderr).not.toContain("note:"); // keychain accepted the write, no fallback notice

    const revealed = await runCli(["create", "kc-agent-2.agent", "--reveal-keys"], env);
    expect(revealed.code).toBe(0);
    const revealedOut = JSON.parse(revealed.stdout) as Record<string, string>;
    expect(revealedOut.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(revealedOut.ownerPrivateKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verify exits 0 on healthy data and 1 after the stored row is tampered with", async () => {
    const c = tempCtx();
    const { identity, env } = await seedAgentAndAttestation(c.env.OPENREP_DB_PATH as string);

    const good = await runCli(["verify", identity.publicKey], env);
    expect(good.code).toBe(0);
    expect(good.stdout).toContain("summary: 1/1 attestations valid, manifest valid");

    // tamper: rewrite the stored output column directly at the storage layer;
    // verify must re-derive the content hash and fail closed on the mismatch.
    const db = new DatabaseSync(c.env.OPENREP_DB_PATH as string);
    const tamper = db.prepare("UPDATE attestations SET output = ? WHERE agent_id = ?");
    const result = tamper.run("TAMPERED", identity.publicKey);
    if (Number(result.changes) !== 1) throw new Error("tamper update touched no rows; test is invalid");
    db.close();

    const bad = await runCli(["verify", identity.publicKey], env);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("FAIL");
    expect(bad.stdout).toContain("summary: verify FAILED");
  });

  it("attest with an env key signs for the seeded agent and verify accepts it", async () => {
    const c = tempCtx();
    const { identity, env } = await seedAgentAndAttestation(c.env.OPENREP_DB_PATH as string);

    const att = await runCli(["attest", "-a", "seeded-agent.agent", "-t", "cli task", "-o", "cli output"], env);
    expect(att.code).toBe(0);
    const record = JSON.parse(att.stdout) as { agentId: string; source: string };
    expect(record.agentId).toBe(identity.publicKey);
    expect(record.source).toBe("native");

    const ver = await runCli(["verify", "seeded-agent.agent"], env);
    expect(ver.code).toBe(0);
    expect(ver.stdout).toContain("summary: 2/2 attestations valid, manifest valid");
  });

  it("invalid --tools json is rejected before any signing work", async () => {
    const c = tempCtx();
    const { env } = await seedAgentAndAttestation(c.env.OPENREP_DB_PATH as string);

    const bad = await runCli(
      ["attest", "-a", "seeded-agent.agent", "-t", "t", "-o", "o", "--tools", "not-json"],
      env,
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--tools must be valid json");
  });

  it("a wrong env key cannot sign for an agent (KEY_MISMATCH)", async () => {
    const c = tempCtx();
    const { identity } = await seedAgentAndAttestation(c.env.OPENREP_DB_PATH as string);
    const wrongEnv = cliEnvFor(c.dir, { OPENREP_SIGNING_KEY: "ab".repeat(32) });

    const bad = await runCli(["attest", "-a", identity.publicKey, "-t", "t", "-o", "o"], wrongEnv);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("KEY_MISMATCH");
  });

  it("ingest fails honestly: no adapter registered for the source", async () => {
    const c = tempCtx();
    const { env } = await seedAgentAndAttestation(c.env.OPENREP_DB_PATH as string);

    const bad = await runCli(["ingest", "-f", join(c.dir, "nope.json"), "-s", "marketplace", "-a", "seeded-agent.agent"], env);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('no adapter registered for source "marketplace"');
  });

  it("help lists every command; version prints; both exit 0", async () => {
    const c = tempCtx();

    const help = await runCli(["--help"], c.env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: openrep");
    for (const cmd of ["create", "attest", "ingest", "score", "resolve", "revoke", "verify"]) {
      expect(help.stdout).toContain(cmd);
    }

    const version = await runCli(["--version"], c.env);
    expect(version.code).toBe(0);
    expect(version.stdout).toContain("0.1.0");
  });

  it("missing required options and unknown commands exit 1, not 0", async () => {
    const c = tempCtx();

    const missing = await runCli(["attest"], c.env);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("required option");

    const unknown = await runCli(["frobnicate"], c.env);
    expect(unknown.code).toBe(1);
  });
});