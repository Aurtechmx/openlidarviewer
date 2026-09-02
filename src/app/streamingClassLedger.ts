/**
 * streamingClassLedger.ts — one classification tally per streaming session,
 * counted once per node.
 *
 * The streaming node lifecycle is deliberately cyclic: a node decodes, becomes
 * resident, is evicted under memory pressure, and decodes again when the camera
 * returns to it. The classification legend folded EVERY arrival into its
 * running total, and the node-ready hook carried no identity, so the
 * accumulator could not tell a first arrival from a reload. Navigating away and
 * back added the same source points a second time, and the displayed totals
 * grew with navigation history until they exceeded the number of distinct
 * points the session had ever decoded.
 *
 * THE STATISTIC THIS KEEPS. Classification counts from the UNIQUE decoded
 * source nodes seen during the current streaming session. A first encounter
 * counts; an eviction keeps the historical count; a reload counts nothing
 * further. That is deliberately NOT a resident-only histogram: that is a
 * different quantity, it would have to subtract on eviction, and the legend
 * caption states the one this ledger actually holds.
 *
 * IDENTITY. The caller passes the streaming node record's own id
 * (`StreamingNodeRecord.id`, the deterministic `"depth-x-y-z"` string), which is
 * what the scheduler, the renderer and the benchmark already key a node by. It
 * survives eviction and reload, unlike array identity, mesh identity, decode
 * order or a hash of the classification bytes. It is unique only WITHIN one
 * source, so {@link StreamingClassLedger.reset} is mandatory whenever the
 * streaming dataset changes; without it, dataset B's node "0-1-2" would be
 * suppressed by dataset A's.
 *
 * DISPLAY ONLY, ONE WAY. The legend and the inspector's "k of M classes" scope
 * stamp are the only readers. Terrain ground filtering, classification fitness,
 * DTM / DSM / CHM, contours, the ground-return ratio, evidence records,
 * passports, method and product digests and every export build their own
 * populations from their own inputs and never consult this. Nothing here is a
 * scientific quantity.
 *
 * Pure app state — no DOM, no three.js, no viewer — so the whole contract is
 * unit-tested in Node.
 */

import { countClasses } from '../render/class/classHistogram';

/** The per-session, count-each-node-once classification tally. */
export interface StreamingClassLedger {
  /**
   * Fold one decoded node's classification into the session tally.
   *
   * Returns that node's OWN per-class histogram the first time `nodeId` is
   * seen, and null for every later arrival of the same id, so the caller can
   * use the return value directly as the legend's delta. A repeat arrival costs
   * one set lookup and no pass over the points.
   *
   * NODES WITH NO CLASSIFICATION CHANNEL never reach here, and that is the
   * deliberate choice: `buildSchedulerCallbacks` skips the hook when a decoded
   * chunk carries no `classification` array. Folding zeros in would put the
   * node's whole point count under class 0, stating that every one of its
   * points is "never classified" — a claim about the source, where the truth is
   * that the source makes no claim at all. Such a node is in neither the tally
   * nor its denominator. An EMPTY buffer is a different thing: it is a
   * classification population of zero points, so it is recorded as seen and
   * contributes nothing.
   */
  record(nodeId: string, classification: Uint8Array): Map<number, number> | null;
  /** The session tally, summed over every unique node recorded. A fresh copy. */
  aggregate(): Map<number, number>;
  /** How many unique nodes have been counted this session. */
  size(): number;
  /**
   * Drop every id and the tally. MANDATORY whenever the streaming dataset
   * changes — scan closed, new scan opened, streaming session replaced, source
   * detached — because a node id is unique only within its own source.
   * Idempotent, so every teardown path may call it.
   */
  reset(): void;
}

export function createStreamingClassLedger(): StreamingClassLedger {
  /**
   * Node ids counted so far. Ids, not histograms: a per-node histogram has no
   * further reader once its counts are in `totals`, and holding the decoded
   * arrays would keep a streaming session's whole classification in memory.
   */
  const seen = new Set<string>();
  const totals = new Map<number, number>();

  return {
    record(nodeId: string, classification: Uint8Array): Map<number, number> | null {
      if (seen.has(nodeId)) return null;
      // Count BEFORE marking the node seen. A decode that failed earlier never
      // reaches this hook at all, and if the population cannot be walked here
      // the throw leaves the id unrecorded, so a later successful decode of the
      // same node still counts exactly once rather than being suppressed by a
      // failure that contributed nothing.
      const histogram = countClasses(classification);
      seen.add(nodeId);
      for (const [code, n] of histogram) totals.set(code, (totals.get(code) ?? 0) + n);
      return histogram;
    },
    aggregate: (): Map<number, number> => new Map(totals),
    size: (): number => seen.size,
    reset(): void {
      seen.clear();
      totals.clear();
    },
  };
}
