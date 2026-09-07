// integration tests: the real ingest() path against the real sqlite storage
// adapter, with real crypto (real content hash, real ed25519 signature).
// the marketplace fixture is inline and unbranded, same agreement as the
// unit tests: no samples/ module, no sample data file. the proof chain is
// deliberately the demo's story: ingest a completed task from a generic
// marketplace, verify the signature, watch an unregistered source contribute
// 0 to the composite, register it at weight 2.0, watch the composite move.
//
// the legacy database test writes a file with the pre-external_verification
// schema and proves the guarded ALTER upgrades it in place without losing or
// mangling the rows written before the column existed.
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getPublicKeyAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import {
  createAgent,
  createSqliteStorage,
  getScore,
  ingest,
  verifyAttestation,
} from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";
import type { ExternalAttestation, SourceAdapter } from "../src/index.js";

const MARKETPLACE_TIMESTAMP = "2026-03-04T09:30:00.000Z";

// inline, unbranded task-marketplace adapter, duplicated in this file per
// the ingest test agreement (no shared samples module).
function marketplaceAdapter(): SourceAdapter {
  return {
    sourceName: "marketplace",
    normalize(raw) {
      const record = raw as ExternalAttestation & {
        agentId?: unknown;
        taskCompleted?: { id?: unknown; title?: unknown; completedAt?: unknown; rating?: unknown; payoutCents?: unknown; currency?: unknown };
      };
      return {
        agentId: record.agentId as string,
        task: `completed task ${record.taskCompleted?.id}: ${record.taskCompleted?.title}`,
        output: `rating ${record.taskCompleted?.rating}/5, payout ${record.taskCompleted?.payoutCents} ${record.taskCompleted?.currency}`,
        toolsUsed: [],
        timestamp: record.taskCompleted?.completedAt as string,
      };
    },
  };
}

function marketplaceRaw(agentId: string): ExternalAttestation {
  return {
    sourceName: "marketplace",
    agentId,
    taskCompleted: {
      id: "task_01234",
      title: "refactor auth middleware",
      status: "completed",
      completedAt: MARKETPLACE_TIMESTAMP,
      rating: 4.8,
      payoutCents: 2500,
      currency: "usd",
      review: "clean, tested, on time",
    },
  };
}

describe("ingest + sqlite storage integration", () => {
  it("proves the demo chain: real ingest, real signature, weight-0 visibility, then composite moves on registration", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await ingest(marketplaceRaw(created.value.publicKey), marketplaceAdapter(), created.value.privateKey, storage);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ingested = result.value;

    // the ingested record is a genuine signed attestation, verifiable end to end.
    expect(ingested.source).toBe("marketplace");
    expect(ingested.externalVerification).toEqual({ checked: false, valid: null, reason: null });
    const verified = await verifyAttestation(ingested, storage);
    expect(verified.valid).toBe(true);

    // the row round trips through real sqlite json with the provenance intact.
    const page = await storage.getAttestations(created.value.publicKey);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].externalVerification).toEqual({ checked: false, valid: null, reason: null });
    expect(page.items[0].timestamp).toBe(MARKETPLACE_TIMESTAMP);

    // unregistered source: visible in the breakdown at weight 0.
    const before = await getScore(created.value.publicKey, storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.composite).toBe(0);
    expect(before.value.breakdown).toEqual([
      { source: "marketplace", value: 1, count: 1, lastUpdated: MARKETPLACE_TIMESTAMP },
    ]);

    // registration at weight 2.0 moves the composite exactly.
    await storage.saveRegisteredSource({ sourceName: "marketplace", registeredAt: "2026-03-05T00:00:00.000Z", trustWeight: 2.0 });
    const after = await getScore(created.value.publicKey, storage);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.composite).toBe(2);
    expect(after.value.breakdown).toEqual([
      { source: "marketplace", value: 1, count: 1, lastUpdated: MARKETPLACE_TIMESTAMP },
    ]);
  });

  it("deduplicates identical retries through the real composite unique index", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await ingest(marketplaceRaw(created.value.publicKey), marketplaceAdapter(), created.value.privateKey, storage, {
      idempotencyKey: "import-1",
    });
    const second = await ingest(marketplaceRaw(created.value.publicKey), marketplaceAdapter(), created.value.privateKey, storage, {
      idempotencyKey: "import-1",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.id).toBe(first.value.id);

    const page = await storage.getAttestations(created.value.publicKey);
    expect(page.items).toHaveLength(1);
  });

  it("upgrades a legacy database in place: old rows parse, the column appears, new ingests persist", async () => {
    // a database file written with the schema that existed BEFORE the
    // external_verification column: no such column anywhere, but the agent
    // row carries a real keypair so the post-upgrade ingest runs real crypto.
    const dbPath = join(tmpdir(), `openrep-legacy-${randomUUID()}.db`);
    const seed = "bb".repeat(32);
    const agentId = bytesToHex(await getPublicKeyAsync(hexToBytes(seed)));
    try {
      const legacy = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
      legacy.exec(`
        CREATE TABLE agents (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          public_key TEXT NOT NULL UNIQUE,
          owner_public_key TEXT,
          memory_pointer TEXT,
          permissions TEXT NOT NULL,
          created_at TEXT NOT NULL,
          manifest_version INTEGER NOT NULL,
          signature TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE TABLE attestations (
          row_id INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          agent_id TEXT NOT NULL,
          idempotency_key TEXT,
          task TEXT NOT NULL,
          output TEXT NOT NULL,
          tools_used TEXT NOT NULL,
          source TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          signature TEXT NOT NULL,
          signed_by TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          FOREIGN KEY (agent_id) REFERENCES agents(public_key)
        );
      `);
      const legacyAgentId = agentId;
      legacy
        .prepare(`INSERT INTO agents (name, public_key, permissions, created_at, manifest_version, signature)
             VALUES (?, ?, ?, ?, ?, ?)`)
        .run("legacy.agent", legacyAgentId, '["attest:self"]', "2026-01-01T00:00:00.000Z", 1, "legacy-sig");
      legacy
        .prepare(
          `INSERT INTO attestations (id, agent_id, task, output, tools_used, source, content_hash, signature, signed_by, timestamp, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "legacy-att-1",
          legacyAgentId,
          "old task",
          "old output",
          "[]",
          "native",
          "ab".repeat(32),
          "cd".repeat(64),
          legacyAgentId,
          "2026-01-02T00:00:00.000Z",
          1,
        );
      legacy.close();

      // opening through the production path runs the guarded ALTERs.
      const storage = createSqliteStorage(dbPath);

      // the legacy row survives the upgrade and reads back with
      // externalVerification null ("no external check ran").
      const legacyAgent = await storage.getAgent(agentId);
      expect(legacyAgent).not.toBeNull();
      const legacyPage = await storage.getAttestations(agentId);
      expect(legacyPage.items).toHaveLength(1);
      expect(legacyPage.items[0].id).toBe("legacy-att-1");
      expect(legacyPage.items[0].externalVerification).toBeNull();

      // a fresh ingest works on the upgraded file and its provenance persists.
      const result = await ingest(marketplaceRaw(agentId), marketplaceAdapter(), seed, storage);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const afterPage = await storage.getAttestations(agentId);
      expect(afterPage.items).toHaveLength(2);
      const marketplaceRow = afterPage.items.find((row) => row.source === "marketplace");
      expect(marketplaceRow?.externalVerification).toEqual({ checked: false, valid: null, reason: null });
    } finally {
      rmSync(dbPath, { force: true });
    }
  });
});