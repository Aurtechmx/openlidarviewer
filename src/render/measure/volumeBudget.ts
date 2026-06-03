/**
 * volumeBudget.ts
 *
 * Pure-data adaptive-degradation budget for the volume / lasso volume
 * pipeline. Carryover note: very dense clouds + very large
 * lasso footprints can push the point-walk past the user's frame
 * budget and freeze the canvas mid-measurement. The budget module
 * decides — BEFORE the walk — whether to downsample the candidate set
 * and what stride to use.
 *
 * Why a separate module:
 *   - The volume math (`volume.ts`, `lassoVolume.ts`) stays
 *     deterministic. Sampling decisions are an orthogonal axis, made
 *     once at the call site.
 *   - The thresholds live in one table so the UX team can tune them
 *     against profiling data without touching the math.
 *   - The "sampled" flag travels with the result so the inspector
 *     surfaces "estimated (sampled — coverage 18%)" rather than
 *     pretending the value is exhaustive.
 *
 * Pure: no DOM, no three.js, no performance.now(). Unit tests pass
 * synthetic point counts and expected verdicts.
 */

/** Input shape for the budget decision. */
export interface VolumeWorkload {
  /**
   * Number of points the caller WOULD walk if it ran exhaustively.
   * For polygon volume: positions.length / 3 of the loaded cloud(s).
   * For lasso volume: same, BEFORE applying the lasso projection.
   */
  readonly candidatePointCount: number;
  /**
   * Polygon footprint area in m². Approximate is fine — the budget
   * uses it only to estimate density-driven cost. Pass 0 when the
   * area isn't known yet; the budget falls back to point-count only.
   */
  readonly footprintAreaM2: number;
  /**
   * Optional device-tier hint — phones get a tighter budget than
   * desktops. Defaults to `'desktop'`. The Viewer fills this in from
   * its existing `tierAdaptation` signal so callers don't repeat the
   * detection logic.
   */
  readonly tier?: 'desktop' | 'laptop' | 'phone';
}

/** Structured budget verdict. */
export interface VolumeBudgetDecision {
  /** True when the caller should walk only every `stride`-th point. */
  readonly downsample: boolean;
  /**
   * Stride to use when `downsample` is true. `1` means "walk every
   * point" (no downsample); the caller can blindly use this stride
   * without a special case. Always an integer ≥ 1.
   */
  readonly stride: number;
  /**
   * Estimated number of points the caller WILL walk with this stride.
   * Used by the inspector to surface "estimated (sampled — n points)".
   */
  readonly estimatedWalkedPoints: number;
  /** Coverage ratio — walked / candidate. Always in `(0, 1]`. */
  readonly coverageFraction: number;
  /** Human-readable explanation for the inspector's tooltip. */
  readonly reason: string;
}

/**
 * Per-tier ceilings for the exhaustive point walk. Above the ceiling,
 * the budget chooses a stride that brings the walked count under it.
 * The phone tier is tighter because mobile GPUs share thermal budget
 * with the renderer; the laptop tier sits in between.
 */
const POINT_CEILING: Record<NonNullable<VolumeWorkload['tier']>, number> = {
  desktop: 8_000_000,
  laptop: 4_000_000,
  phone: 1_500_000,
};

/**
 * Density-aware threshold — when point-count is below the ceiling but
 * density (points / m²) is extreme (>= this many points per square
 * metre on a sub-100 m² footprint), the walk still spends real time
 * filtering. Above this density the budget downsamples.
 */
const HIGH_DENSITY_PTS_PER_M2 = 5_000;
const HIGH_DENSITY_AREA_CAP_M2 = 100;

/**
 * Compute the budget verdict for a volume workload.
 *
 *   - Below the tier ceiling AND not pathological density → no
 *     downsample.
 *   - Above the ceiling → stride = ceil(candidates / ceiling).
 *   - Pathological density → stride = ceil(density / threshold).
 *
 * The stride is always an integer ≥ 1; the estimated walked count
 * uses `floor(candidates / stride)` so the inspector copy matches
 * what the math actually consumes.
 */
export function decideVolumeBudget(
  workload: VolumeWorkload,
): VolumeBudgetDecision {
  const tier = workload.tier ?? 'desktop';
  const ceiling = POINT_CEILING[tier];
  const candidates = Math.max(0, Math.floor(workload.candidatePointCount));

  if (candidates === 0) {
    return {
      downsample: false,
      stride: 1,
      estimatedWalkedPoints: 0,
      coverageFraction: 1,
      reason: 'No candidate points — nothing to walk.',
    };
  }

  // Ceiling check — too many points for an exhaustive walk in one tick.
  let stride = 1;
  let reason = '';
  if (candidates > ceiling) {
    stride = Math.ceil(candidates / ceiling);
    reason =
      `Cloud has ${candidates.toLocaleString()} candidate points — above the ` +
      `${tier} ceiling of ${ceiling.toLocaleString()}. Walking every ${stride}-th point.`;
  }

  // Density check — only matters for small footprints where a deep
  // stack of returns would otherwise stall a single tick.
  const area = workload.footprintAreaM2;
  if (
    area > 0 &&
    area <= HIGH_DENSITY_AREA_CAP_M2 &&
    candidates / area >= HIGH_DENSITY_PTS_PER_M2
  ) {
    const densityStride = Math.ceil(
      candidates / area / HIGH_DENSITY_PTS_PER_M2,
    );
    if (densityStride > stride) {
      stride = densityStride;
      reason =
        `Footprint is dense (${Math.round(candidates / area).toLocaleString()} ` +
        `pts/m²). Walking every ${stride}-th point keeps the read fast.`;
    }
  }

  if (stride <= 1) {
    return {
      downsample: false,
      stride: 1,
      estimatedWalkedPoints: candidates,
      coverageFraction: 1,
      reason: 'Workload fits the exhaustive budget — full coverage.',
    };
  }

  const walked = Math.floor(candidates / stride);
  return {
    downsample: true,
    stride,
    estimatedWalkedPoints: walked,
    coverageFraction: walked > 0 ? walked / candidates : 0,
    reason,
  };
}

/**
 * Compact inspector caption for the volume result card. Returns an
 * empty string when the workload was walked exhaustively, so callers
 * can use `if (caption) hud.push(caption)` without a guard.
 */
export function volumeBudgetCaption(
  decision: VolumeBudgetDecision,
): string {
  if (!decision.downsample) return '';
  const pct = (decision.coverageFraction * 100).toFixed(1);
  return `Estimated (sampled — ${pct}% coverage, every ${decision.stride}-th point).`;
}
