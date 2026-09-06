// integration tests: the real scoring path (getScore/getScore + resolve)
// against the real sqlite storage adapter, with real crypto where the sdk
// demands it. native history is written through the real attest() (real
// content hash, real ed25519 signature); external-source history is written
// through storage.saveAttestation, which is the same dumb write path
// ingest() will use later (no crypto runs at write time). the composite is
// hand-computed from those exact rows, so an off-by-one in weighting or
// counting fails loudly.
import { signAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import {
  attest,
  canonicalize,
  createAgent,
  createSqliteStorage,
  getScore,
  resolve,
  revokeAgent,
} from "../src/index.js";
import type { AttestationRecord } from "../src/index.js";
import { bytesToHex, hexToBytes } from "../src/hex.js";

function latestOf(times: string[]): string {
  return times.reduce((max, t) => (Date.parse(t) > Date.parse(max) ? t : max), times[0]);
}

// a complete persistence record for a source other than native, written the
// same way a future ingest() will write it: direct to storage, no crypto at
// write time. shape only needs to satisfy the storage adapter.
function sourceRecord(agentId: string, idSuffix: string, source: string, timestamp: string): AttestationRecord {
  return {
    rowId: 0, // assigned by the store on insert
    id: `00000000-0000-4000-8000-${idSuffix}`,
    agentId,
    task: `${source} task`,
    output: `${source} output`,
    toolsUsed: [],
    source,
    contentHash: "ab".repeat(32),
    signature: "cd".repeat(64),
    signedBy: "ef".repeat(32),
    timestamp,
    schemaVersion: 1,
  };
}

describe("getScore + sqlite storage integration", () => {
  it("computes an exact hand-computed composite from real rows, paging through the history", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, privateKey } = created.value;

    // 3 native attestations through the real sign-and-verify path
    const nativeTimes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await attest(
        { agentId: publicKey, task: `native task ${i}`, output: `native output ${i}`, toolsUsed: [], source: "native", idempotencyKey: `native-${i}` },
        privateKey,
        storage,
      );
      expect(r.ok).toBe(true);
      if (r.ok) nativeTimes.push(r.value.timestamp);
    }

    // 2 github rows via the dumb write path, with controlled timestamps
    const githubRows = [
      sourceRecord(publicKey, "00000000-0006", "github", "2026-01-02T12:00:00.000Z"),
      sourceRecord(publicKey, "00000000-0007", "github", "2026-01-09T12:00:00.000Z"),
    ];
    for (const row of githubRows) await storage.saveAttestation(row);
    await storage.saveRegisteredSource({ sourceName: "github", registeredAt: "2026-01-01T00:00:00.000Z", trustWeight: 2.0 });

    // thin wrap so the real adapter counts its own reads: proves the
    // traversal genuinely pages (5 rows at pageSize 2 = 3 reads, all rows
    // visited exactly once) instead of collapsing to a single fetch.
    const originalGetAttestations = storage.getAttestations.bind(storage);
    let readCalls = 0;
    storage.getAttestations = async (agentId, pagination) => {
      readCalls += 1;
      return originalGetAttestations(agentId, pagination);
    };

    const result = await getScore(publicKey, storage, { pageSize: 2 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readCalls).toBe(3);
    // composite = 3 * 1.0 (native) + 2 * 2.0 (github) = 7, computed by hand
    // from the rows written above
    expect(result.value.composite).toBe(7);
    expect(result.value.breakdown).toEqual([
      { source: "github", value: 2, count: 2, lastUpdated: "2026-01-09T12:00:00.000Z" },
      { source: "native", value: 3, count: 3, lastUpdated: latestOf(nativeTimes) },
    ]);
  });

  it("scores a real zero-history agent as a valid 0, not an error", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await getScore(created.value.publicKey, storage);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.composite).toBe(0);
    expect(result.value.breakdown).toEqual([]);
  });

  it("keeps scoring a revoked agent from its history and resolve carries revokedAt", async () => {
    const storage = createSqliteStorage(":memory:");
    const created = await createAgent({ storage });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { publicKey, privateKey, ownerPrivateKey, name } = created.value;

    for (let i = 0; i < 2; i++) {
      const r = await attest(
        { agentId: publicKey, task: `before revocation ${i}`, output: "still counts", toolsUsed: [], source: "native", idempotencyKey: `pre-${i}` },
        privateKey,
        storage,
      );
      expect(r.ok).toBe(true);
    }

    const before = await getScore(publicKey, storage);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.composite).toBe(2);

    // real revocation, real owner-key signature over canonicalize({agentId, timestamp})
    const timestamp = new Date().toISOString();
    const signature = bytesToHex(
      await signAsync(
        new TextEncoder().encode(canonicalize({ agentId: publicKey, timestamp })),
        hexToBytes(ownerPrivateKey),
      ),
    );
    const revoked = await revokeAgent({ agentId: publicKey, timestamp, signature }, storage);
    expect(revoked.ok).toBe(true);

    const after = await getScore(publicKey, storage);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    // revocation is NOT a score reset: history remains visible and weighted
    expect(after.value.composite).toBe(2);

    const resolved = await resolve(name, storage);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.manifest.revokedAt).not.toBeNull();
    expect("rowId" in resolved.value.manifest).toBe(false);
    expect(resolved.value.score.composite).toBe(2);
  });

  it("returns AGENT_NOT_FOUND against the real schema for an unknown id", async () => {
    const storage = createSqliteStorage(":memory:");

    const result = await getScore("aa".repeat(32), storage);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("AGENT_NOT_FOUND");
  });
});