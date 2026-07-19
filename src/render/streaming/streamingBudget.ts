/**
 * streamingBudget.ts
 *
 * The pure budget logic for COPC streaming: per-quality, per-device point
 * budgets, and the selection of which scored nodes fit the budget.
 *
 * Pure — no DOM, no three.js — fully unit-tested in Node.
 */

/** The user-facing streaming quality preset. */
export type StreamingQuality = 'low' | 'balanced' | 'high';

/** Resolved budgets for a streaming session. */
export interface StreamingBudgets {
  /** Maximum resident (on-GPU) point count. */
  pointBudget: number;
  /** Maximum concurrent decode requests in flight. */
  maxConcurrentDecodes: number;
  /** Byte budget for the compressed-chunk cache. */
  chunkCacheBytes: number;
}

/** Desktop resident-point budgets per quality preset. */
const DESKTOP_POINT_BUDGET: Record<StreamingQuality, number> = {
  low: 1_500_000,
  // Trimmed from 4M: every resident point is drawn as an instanced quad, so the
  // default budget is the dominant steady-state navigation cost. 2.5M keeps a
  // dense default while cutting ~40% of the per-frame draw work; "high" (8M)
  // stays one click away for full density.
  balanced: 2_500_000,
  high: 8_000_000,
};

/** Mobile resident-point budgets — conservative, to keep the UI stable. */
const MOBILE_POINT_BUDGET: Record<StreamingQuality, number> = {
  low: 600_000,
  balanced: 1_200_000,
  high: 2_000_000,
};

/**
 * Rough GPU bytes per resident streaming point: an instanced position
 * (vec3 f32, 12 B) and an instanced colour (vec3 f32, 12 B) — the same figure
 * the debug overlay uses for static clouds.
 */
export const BYTES_PER_STREAMING_POINT = 24;

/**
 * CPU-side bytes per decoded point — the shape produced by the worker before
 * GPU upload. Summed: positions (3 × f32 = 12 B), intensity (u16 = 2 B),
 * classification (u8 = 1 B), returnNumber (u8 = 1 B), returnCount (u8 = 1 B),
 * gpsTime (f64 = 8 B) → 25 B / point. Used by the three-tier debug-overlay
 * metric (decoded-tier accounting): in this architecture decoded data is transferred to the
 * GPU atomically, so the decoded tier reports a CPU-residency estimate that
 * mirrors the GPU estimate but with the full decoded attribute set.
 */
export const DECODED_BYTES_PER_POINT = 25;

/** Compressed-chunk cache byte budget — smaller on mobile. */
const DESKTOP_CHUNK_CACHE_BYTES = 48 * 1024 * 1024;
const MOBILE_CHUNK_CACHE_BYTES = 16 * 1024 * 1024;

/** Resolve the budgets for a quality preset and device class. */
export function streamingBudgets(
  quality: StreamingQuality,
  isMobile: boolean,
): StreamingBudgets {
  const pointBudget = (isMobile ? MOBILE_POINT_BUDGET : DESKTOP_POINT_BUDGET)[quality];
  return {
    pointBudget,
    maxConcurrentDecodes: isMobile ? 2 : 4,
    chunkCacheBytes: isMobile ? MOBILE_CHUNK_CACHE_BYTES : DESKTOP_CHUNK_CACHE_BYTES,
  };
}

/** A scored node candidate — the minimal shape budget selection needs. */
export interface ScoredCandidate {
  id: string;
  pointCount: number;
  score: number;
}

/** Tuning for the resident-stickiness pass; see {@link selectWithinBudget}. */
export interface BudgetSelectionOptions {
  /** Ids currently resident (already on the GPU). */
  readonly resident?: ReadonlySet<string>;
  /**
   * Ids being REFINED away — a finer descendant of the node is ALSO a candidate
   * this tick. These get NO stickiness, so replacing a coarse node with its
   * children is never blocked. This exemption is what keeps stickiness from
   * freezing LOD (the failure mode that reverted an earlier admission-hysteresis
   * attempt): only nodes with no pending refinement can hold their slot.
   */
  readonly refining?: ReadonlySet<string>;
  /**
   * Fractional score bonus a resident, non-refining candidate keeps to hold its
   * slot against a marginally-higher-scoring newcomer. 0 (the default) disables
   * stickiness and reproduces the plain greedy fill exactly.
   */
  readonly stickyMargin?: number;
}

/**
 * Walk candidates in score order (highest first) and return the ids whose
 * cumulative point count fits `pointBudget`. Candidates with a score of 0
 * (culled or past the depth cap) are never selected. If the single
 * highest-priority node already exceeds the budget it is still selected, so a
 * coarse result always renders.
 *
 * With `stickyMargin > 0` and a `resident` set, an already-shown node keeps a
 * small score bonus so budget-boundary score noise can't bump it out of the
 * selection and force a costly evict → re-decode → re-fade cycle — the "regions
 * pulsing" flicker. A node being refined away (in `refining`) is exempt, so this
 * stabilises what's on screen WITHOUT blocking genuine refinement. With no
 * options it is the plain greedy fill, unchanged.
 *
 * NOTE: the scheduler does NOT yet pass a margin, so this is currently inert in
 * production — the pure anti-thrash behaviour is unit-tested here and ready to
 * enable, but wiring it live must first reconcile the `refining` exemption with
 * the scheduler's ancestor-protection (a refining ancestor stripped of its bonus
 * can go unwanted yet stay resident, stalling eviction) and be verified visually
 * in the browser, since flicker is not observable from Node.
 */
export function selectWithinBudget(
  sortedByScoreDesc: readonly ScoredCandidate[],
  pointBudget: number,
  options: BudgetSelectionOptions = {},
): Set<string> {
  const margin = options.stickyMargin ?? 0;
  const resident = options.resident;
  if (margin > 0 && resident && resident.size > 0) {
    const refining = options.refining;
    // Effective score biases resident (non-refining) nodes upward, then a stable
    // sort keeps the caller's raw-score order on ties. A newcomer must beat a
    // resident node by more than `margin` to take its slot.
    const effective = sortedByScoreDesc.map((c, i) => {
      const sticky = c.score > 0 && resident.has(c.id) && !(refining?.has(c.id) ?? false);
      return { c, i, eff: sticky ? c.score * (1 + margin) : c.score };
    });
    effective.sort((a, b) => b.eff - a.eff || a.i - b.i);
    return greedyFill(effective.map((e) => e.c), pointBudget);
  }
  return greedyFill(sortedByScoreDesc, pointBudget);
}

/** The cumulative point-budget fill over an already score-ordered list. */
function greedyFill(sorted: readonly ScoredCandidate[], pointBudget: number): Set<string> {
  const wanted = new Set<string>();
  let total = 0;
  for (const candidate of sorted) {
    if (candidate.score <= 0) break;
    if (total + candidate.pointCount > pointBudget && wanted.size > 0) break;
    wanted.add(candidate.id);
    total += candidate.pointCount;
  }
  return wanted;
}

/** Estimated GPU bytes for a resident point count. */
export function estimateGpuBytes(residentPointCount: number): number {
  return residentPointCount * BYTES_PER_STREAMING_POINT;
}

/**
 * Estimate CPU-side decoded bytes for a given resident point count — uses
 * the full decoded attribute set (see {@link DECODED_BYTES_PER_POINT}).
 * Powers the decoded tier of the decoded-tier overlay.
 */
export function estimateDecodedBytes(residentPointCount: number): number {
  return residentPointCount * DECODED_BYTES_PER_POINT;
}
