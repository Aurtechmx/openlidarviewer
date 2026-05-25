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
  balanced: 4_000_000,
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
 * the v0.2.9 debug overlay uses for static clouds.
 */
export const BYTES_PER_STREAMING_POINT = 24;

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

/**
 * Walk candidates in score order (highest first) and return the ids whose
 * cumulative point count fits `pointBudget`. Candidates with a score of 0
 * (culled or past the depth cap) are never selected. If the single
 * highest-priority node already exceeds the budget it is still selected, so a
 * coarse result always renders.
 */
export function selectWithinBudget(
  sortedByScoreDesc: readonly ScoredCandidate[],
  pointBudget: number,
): Set<string> {
  const wanted = new Set<string>();
  let total = 0;
  for (const candidate of sortedByScoreDesc) {
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
