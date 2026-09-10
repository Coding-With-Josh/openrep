// cross-process concurrency hardening test. proves the file-backed sqlite
// adapter is safe under real concurrent web traffic: readers never block
// writers (the WAL property) and multiple writer processes serialize through
// the write mutex instead of surfacing database is locked.
//
// structure: the parent test process holds a long-lived adapter connection on
// the file and an explicit raw read transaction open, while two real child
// node processes (the cli / server-worker analogue) open the SAME file through
// the shipped adapter and write agents plus attestations. in delete journal
// mode a held read lock blocks every writer; in WAL mode it does not. the
// children must complete with zero surfaced lock errors and every write must
// be visible to the parent afterwards.
//
// the children import the COMPILED adapter, and this suite compiles it itself
// into a private temp outDir (tsc -p src --outDir <tmp>): the child script is
// a plain node process and cannot run ts directly, but the outDir is private
// to this test process so a concurrent pnpm -r build writing the shared dist/
// can never race it. the temp outDir is cleaned up in afterAll.
// the negative control (same harness, delete mode, expect database is locked)
// is a deliberate one-off dev-loop spike, not a committed test, so this suite
// stays deterministic and fast while still proving the harness is non-vacuous.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSqliteStorage, type AgentRecord } from "../src/index.js";

// the sdk package directory, resolved from this test file (test/ -> package).
const PKG = fileURLToPath(new URL("../", import.meta.url));

// the child process body: never sees OPENREP_* secrets, only the explicit
// DB_PATH / SDK_ADAPTER_URL / WRITE_COUNT / PREFIX env the test injects. each
// write is one saveAgent plus one saveAttestation on that agent, so the
// foreign key and the composite idempotency index both get exercised from a
// second process against the file the parent holds open.
const CHILD_SCRIPT = `
(async () => {
  const results = [];
  const names = [];
  try {
    const { createSqliteStorage } = await import(process.env.SDK_ADAPTER_URL);
    const storage = createSqliteStorage(process.env.DB_PATH);
    const count = Number(process.env.WRITE_COUNT) || 5;
    const prefix = process.env.PREFIX;
    for (let i = 0; i < count; i++) {
      const publicKey = prefix + "-pk-" + i + "-" + "a".repeat(16);
      const name = prefix + "-agent-" + i + ".agent";
      names.push(name);
      try {
        await storage.saveAgent({
          name,
          publicKey,
          ownerPublicKey: "d0".repeat(32),
          memoryPointer: null,
          permissions: ["attest:self"],
          createdAt: new Date().toISOString(),
          manifestVersion: 2,
          signature: "sig",
          revokedAt: null,
        });
        await storage.saveAttestation({
          rowId: 0,
          id: prefix + "-att-" + i,
          agentId: publicKey,
          idempotencyKey: prefix + "-ik-" + i,
          task: "concurrent write",
          output: "done",
          toolsUsed: [],
          source: "native",
          contentHash: "cd".repeat(32),
          signature: "sig",
          signedBy: publicKey,
          timestamp: new Date().toISOString(),
          schemaVersion: 1,
          externalVerification: null,
        });
        results.push("ok:" + i);
      } catch (err) {
        results.push("ERR:" + (err && err.code ? err.code : String(err && err.message)));
      }
    }
    process.stdout.write(JSON.stringify({ results, names }));
  } catch (err) {
    process.stdout.write(JSON.stringify({ results: ["FATAL:" + String(err && err.message)], names: [] }));
  }
})().then(() => process.exit(0));
`;

const WRITE_COUNT = 5;
const CHILD_TIMEOUT_MS = 30_000;

interface ChildOutcome {
  results: string[];
  names: string[];
  stderr: string;
}

function runChild(prefix: string, dbPath: string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    // hermetic env: the developer's real OPENREP_* and TURSO_* secrets must
    // never reach a spawned child, only the explicit adapter contract vars.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.OPENREP_SIGNING_KEY;
    delete env.OPENREP_OWNER_KEY;
    delete env.OPENREP_KEYCHAIN_PATH;
    delete env.OPENREP_CREDENTIALS_FILE;
    delete env.OPENREP_MASTER_ENCRYPTION_KEY;
    delete env.TURSO_DATABASE_URL;
    delete env.TURSO_AUTH_TOKEN;
    delete env.OPENREP_DB_PATH;
    env.DB_PATH = dbPath;
    env.SDK_ADAPTER_URL = adapterUrl;
    env.WRITE_COUNT = String(WRITE_COUNT);
    env.PREFIX = prefix;

    const child = spawn(process.execPath, ["--input-type", "module", "--eval", CHILD_SCRIPT], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let raw = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (raw += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child process ${prefix} timed out after ${CHILD_TIMEOUT_MS}ms`));
    }, CHILD_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(raw) as { results?: string[]; names?: string[] };
        resolve({ results: parsed.results ?? [], names: parsed.names ?? [], stderr });
      } catch {
        reject(new Error(`child process ${prefix} produced unparseable output: ${raw} (stderr: ${stderr})`));
      }
    });
  });
}

// the fixture pieces, one temp dir per test run so the built sdk dist (shared
// with whatever else runs) never sees a partially checked temp database.
const dir = mkdtempSync(join(tmpdir(), "openrep-concurrency-"));
const dbPath = join(dir, "openrep.db");
// private compiled copy of the adapter the children import, isolated from the
// shared dist/ so it cannot race a concurrent pnpm -r build (a write race in
// dist/ surfaced exactly this fragility on first run).
const buildDir = mkdtempSync(join(tmpdir(), "openrep-concurrency-build-"));
let adapterUrl = "";

beforeAll(() => {
  // compile the sdk sources into the private build dir (tsc only, never runs
  // tests, so this cannot recurse). fails the suite loudly if the build
  // breaks. the emitted layout preserves rootDir = src, so the adapter entry
  // lands at <buildDir>/storage/sqlite.js. the default 10s hook timeout is a
  // flake source on loaded machines (a cold full-sdk tsc build takes ~5-6s
  // and can double under worker contention), so the hook gets a real budget.
  execFileSync(
    "pnpm",
    ["exec", "tsc", "-p", "tsconfig.json", "--outDir", buildDir],
    { cwd: PKG, stdio: "pipe", timeout: 60_000 },
  );
  adapterUrl = pathToFileURL(join(buildDir, "storage", "sqlite.js")).href;
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
});

describe("cross-process concurrency hardening", () => {
  it("persists WAL journal mode in the file for any later connection, cli style", () => {
    // the cli opens a fresh connection per invocation (context.ts), and the
    // web app memoizes one per process. journal_mode is a persistent file
    // property, so a third-party / cli connection created later must find
    // the file already in WAL even though synchronous (per-connection) is
    // not persistent. this is the guarantee that a second process is never
    // silently dropped back to delete-mode locking.
    const storage = createSqliteStorage(dbPath);
    expect(storage).toBeDefined();
    const raw = new DatabaseSync(dbPath);
    const mode = raw.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown };
    raw.close();
    expect(mode.journal_mode).toBe("wal");
  });

  it("lets writers proceed while another connection holds a read lock, across processes", async () => {
    // the parent's long-lived server connection, held open for the whole
    // test exactly like the memoized web server connection.
    const server = createSqliteStorage(dbPath);

    // a second connection in the SAME process holds an explicit read
    // transaction on the file. in delete mode this shared lock would block
    // every writer until rollback; in WAL it is the exact scenario the
    // hardening exists for.
    const lock = new DatabaseSync(dbPath);
    lock.exec("BEGIN");
    lock.prepare("SELECT count(*) AS c FROM agents").get();

    try {
      const [childA, childB] = await Promise.all([
        runChild("wal-child-a", dbPath),
        runChild("wal-child-b", dbPath),
      ]);

      // every write in both children succeeded without a surfaced lock
      // error. any SQLITE_BUSY / database is locked surfaces here as ERR:
      // with an unexpected code string, never as "ok".
      for (const [label, outcome] of [
        ["A", childA],
        ["B", childB],
      ] as const) {
        expect(outcome.results.length).toBe(WRITE_COUNT);
        for (const r of outcome.results) {
          expect(r, `child ${label} stderr: ${outcome.stderr}`).toMatch(/^ok:/);
        }
      }

      // every write is visible to the parent afterwards, through the WAL.
      const expected = [...childA.names, ...childB.names];
      expect(expected.length).toBe(2 * WRITE_COUNT);
      for (const name of expected) {
        const agent: AgentRecord | null = await server.getAgentByName(name);
        expect(agent).not.toBeNull();
        expect(agent!.name).toBe(name);
        const attestations = await server.getAttestations(agent!.publicKey);
        expect(attestations.items.length).toBe(1);
      }
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
  });
});