// scoring: computes an agent's reputation score entirely from its persisted
// attestation history. no hardcoded values, no caching, no decay in this
// pass. every number returned here traces to real rows read through the
// StorageAdapter.
//
// the composite formula, documented in technical.md next to the types:
//   composite = sum over sources of ( value_source * trustWeight_source )
//   value_source = count_source = number of attestations from that source
// native is always treated as trust weight 1.0 without requiring a row in
// registered_sources; a registered source uses its stored trustWeight; an
// unregistered non-native source counts toward history (visible in the
// breakdown) but contributes 0 to the composite until formally registered.

import type { AgentId } from "./types/identity.js";
import type { AgentScore, ScoreBreakdown } from "./types/score.js";
import type { Result } from "./types/errors.js";
import { failure, ok } from "./types/errors.js";
import type { StorageAdapter } from "./types/storage.js";

// hard cap on the total number of attestations processed in a single
// getScore() call. when hit, getScore fails with SCORE_COMPUTATION_LIMIT_EXCEEDED
// instead of returning a truncated score: for a reputation system, a wrong
// number with no indication it is wrong is the worst possible failure mode,
// and an explicit "too much history to compute inline" error is honest.
export const SCORE_MAX_ATTESTATIONS = 50_000;

// page size getScore uses when traversing the attestation history. 1000 is
// the storage adapter's maximum allowed limit, so the traversal minimizes
// round trips while staying inside the storage contract.
export const SCORE_PAGE_LIMIT = 1000;

// the system's own directly-verified proof of work. native is special cased
// to trust weight 1.0 and never requires (and cannot be overridden by) a
// registered_sources row: requiring the ledger's own records to be
// "registered" the same way an external platform is would be backwards.
const NATIVE_SOURCE = "native";

export interface GetScoreOptions {
  // overrides SCORE_PAGE_LIMIT; tests pass a small page size to genuinely
  // exercise multi-page traversal without inserting a thousand rows.
  pageSize?: number;
  // overrides SCORE_MAX_ATTESTATIONS; tests pass a low cap to exercise the
  // SCORE_COMPUTATION_LIMIT_EXCEEDED path without inserting fifty thousand.
  maxAttestations?: number;
}

/**
 * Returns composite reputation score, broken down by source, weighted by
 * each registered source's trust weight. computed on demand from the full
 * persisted attestation history, which is paged until exhausted. an agent
 * with zero attestations is a valid score of 0, not an error; a nonexistent
 * agent is AGENT_NOT_FOUND.
 */
export async function getScore(
  agentId: AgentId,
  storage: StorageAdapter,
  options: GetScoreOptions = {},
): Promise<Result<AgentScore>> {
  const pageSize = options.pageSize ?? SCORE_PAGE_LIMIT;
  const maxAttestations = options.maxAttestations ?? SCORE_MAX_ATTESTATIONS;

  // existence check: a nonexistent agent must be AGENT_NOT_FOUND, never a
  // phantom zero score. an existing agent with no history is a normal state.
  const agent = await storage.getAgent(agentId);
  if (agent === null) {
    return failure("AGENT_NOT_FOUND", `no agent with id ${agentId}`);
  }

  // page through the entire history. rows are immutable and the cursor is a
  // strictly decreasing row_id, so rows inserted mid-traversal cannot shift
  // or duplicate an already returned page; a concurrent insert is either in
  // this computation or simply in the next one.
  const perSource = new Map<string, { count: number; latest: string | null }>();
  let cursor: string | undefined;
  let processed = 0;

  while (true) {
    const page = await storage.getAttestations(agentId, { cursor, limit: pageSize });
    for (const record of page.items) {
      processed += 1;
      // cap is checked per record, never silently truncating at a page
      // boundary: reaching the cap means the computation fails closed with
      // an explicit error, not a partial score.
      if (processed > maxAttestations) {
        return failure(
          "SCORE_COMPUTATION_LIMIT_EXCEEDED",
          `attestation history exceeds ${maxAttestations} entries; computing inline needs a different strategy`,
        );
      }
      const entry = perSource.get(record.source) ?? { count: 0, latest: null };
      entry.count += 1;
      if (entry.latest === null || Date.parse(record.timestamp) > Date.parse(entry.latest)) {
        entry.latest = record.timestamp;
      }
      perSource.set(record.source, entry);
    }
    // nextCursor is non-null exactly when the page filled the limit, so a
    // full page must be followed by one more read to confirm exhaustion. the
    // empty-page guard also protects against a degenerate adapter that
    // returns a non-null cursor with no rows.
    if (page.nextCursor === null || page.items.length === 0) break;
    cursor = page.nextCursor;
  }

  // weight map: native is always pinned to 1.0 without requiring a row in
  // registered_sources, so a history with no non-native source does not even
  // consult the registered-sources table. when non-native sources exist,
  // registered ones carry their stored trustWeight and anything else
  // (unregistered) is 0, keeping the record visible in the breakdown while
  // contributing nothing until the source is formally registered.
  // non-finite or negative weights from the storage rows are clamped to 0 so
  // undefined math can never reach the composite.
  const hasNonNative = [...perSource.keys()].some((source) => source !== NATIVE_SOURCE);
  const weightBySource = new Map<string, number>();
  if (hasNonNative) {
    const registered = await storage.getRegisteredSources();
    for (const source of registered) {
      const w = source.trustWeight;
      weightBySource.set(source.sourceName, Number.isFinite(w) && w >= 0 ? w : 0);
    }
  }

  const breakdown: ScoreBreakdown[] = [];
  let composite = 0;
  for (const [source, entry] of perSource) {
    let weight: number;
    if (source === NATIVE_SOURCE) {
      weight = 1.0;
    } else {
      weight = weightBySource.get(source) ?? 0;
    }
    const value = entry.count;
    composite += value * weight;
    breakdown.push({ source, value, count: entry.count, lastUpdated: entry.latest ?? "" });
  }
  // deterministic output order for callers and tests.
  breakdown.sort((a, b) => a.source.localeCompare(b.source));

  return ok({
    agentId,
    composite,
    breakdown,
    computedAt: new Date().toISOString(),
  });
}