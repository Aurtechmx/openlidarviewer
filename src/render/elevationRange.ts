/**
 * elevationRange.ts
 *
 * Percentile-clipped Z-range computation for the "Color by: Height"
 * mode. Replaces the naïve min/max scan that the v0.3.7-initial path
 * used — one tall outlier (a tree, a power-line pole, a flag-mast)
 * was enough to compress an entire field of points into a single
 * colour stop because true-max Z sat 20-30 m above where 99 % of
 * the cloud's points actually live.
 *
 * The standard mitigation, used by CloudCompare, Potree, and the
 * Entwine viewer: pick the [P, 100 - P] percentile band (defaults to
 * the 2nd / 98th percentile) and map the colour ramp across that
 * band. Points above the upper percentile clamp to the top colour;
 * points below the lower percentile clamp to the bottom colour. The
 * 96 % of points in between get the FULL dynamic range of the
 * palette — exactly what an analyst expects.
 *
 * Pure data — no DOM, no three.js — so the helper ships through the
 * same module-graph seam every Stream A leaf uses.
 */

/** A clipped elevation range, ready to feed `colorByElevation`. */
export interface ElevationRange {
  /** Low end of the colour ramp, m. */
  readonly minZ: number;
  /** High end of the colour ramp, m. */
  readonly maxZ: number;
  /** True minimum Z in the sample, m. Always ≤ `minZ`. */
  readonly trueMinZ: number;
  /** True maximum Z in the sample, m. Always ≥ `maxZ`. */
  readonly trueMaxZ: number;
  /** Sample count actually examined. */
  readonly sampleCount: number;
}

/** Inputs to `computeElevationRange`. */
export interface ElevationRangeInput {
  /** Interleaved xyz positions, length 3·N. */
  positions: Float32Array;
  /** Point count to walk — defaults to `positions.length / 3`. */
  pointCount?: number;
  /**
   * Lower percentile to clip to (0..50). Default 5.
   * `colorByElevation` will treat any Z below this as the bottom colour.
   *
   * v0.3.7 final-polish: tightened from 2 → 5 so field-only scans
   * (no big trees) and field-plus-canopy scans both get a more
   * dramatic colour gradient on the actual ground variation. Trees
   * still clamp to the top colour; the field now uses 90 % of the
   * palette instead of 96 %.
   */
  lowerPercentile?: number;
  /**
   * Upper percentile to clip to (50..100). Default 95.
   * `colorByElevation` will treat any Z above this as the top colour.
   */
  upperPercentile?: number;
  /**
   * Sampling stride. The analyser walks one point every `stride`,
   * so a stride of 64 gives 1 / 64 the cloud's pixels. Defaults to a
   * stride that yields ~50 000 samples on the input — fast on a
   * 10 M-point cloud, statistically stable on smaller ones.
   */
  stride?: number;
}

/**
 * Compute a percentile-clipped elevation range.
 *
 * Returns the full true-min / true-max alongside the clipped range so
 * the caller can show "showing 2 % – 98 % range (38.4 – 41.7 m), with
 * outliers at 42.9 m on top and 38.1 m on bottom" if they want to.
 *
 * Handles the degenerate "every point at the same Z" case — both
 * `minZ` and `maxZ` come back equal in that case so the caller can
 * skip the colour ramp.
 */
export function computeElevationRange(
  input: ElevationRangeInput,
): ElevationRange {
  const total = input.pointCount ?? input.positions.length / 3;
  if (total === 0) {
    return { minZ: 0, maxZ: 0, trueMinZ: 0, trueMaxZ: 0, sampleCount: 0 };
  }
  const lowerPct = Math.max(0, Math.min(50, input.lowerPercentile ?? 5));
  const upperPct = Math.max(50, Math.min(100, input.upperPercentile ?? 95));
  const targetSamples = 50_000;
  const stride = Math.max(1, input.stride ?? Math.max(1, Math.floor(total / targetSamples)));

  // First pass — track true min/max and copy the Z samples into a
  // typed array we can sort. The strided walk keeps the allocation
  // bounded even on 100 M-point streaming chunks.
  const sampleCap = Math.min(targetSamples, Math.ceil(total / stride));
  const sample = new Float32Array(sampleCap);
  let trueMin = Number.POSITIVE_INFINITY;
  let trueMax = Number.NEGATIVE_INFINITY;
  let idx = 0;
  for (let i = 0; i < total && idx < sampleCap; i += stride) {
    const z = input.positions[i * 3 + 2];
    sample[idx++] = z;
    if (z < trueMin) trueMin = z;
    if (z > trueMax) trueMax = z;
  }

  // Trim the sample to the actual length we filled. Sort then pick
  // percentiles. The sort is a single pass — the ~50 000-sample cap
  // makes the worst case ~3 ms.
  const used = idx;
  if (used === 0) {
    return { minZ: 0, maxZ: 0, trueMinZ: 0, trueMaxZ: 0, sampleCount: 0 };
  }
  if (used === 1) {
    const z = sample[0];
    return { minZ: z, maxZ: z, trueMinZ: z, trueMaxZ: z, sampleCount: 1 };
  }
  const sorted = sample.subarray(0, used).slice();
  sorted.sort();

  // Percentile pick — `Math.floor` so a low percentile picks a low index.
  // We clamp the upper to the last valid index so the 100th percentile
  // returns the largest value rather than reading past the end.
  const loIdx = Math.max(0, Math.min(used - 1, Math.floor((lowerPct / 100) * used)));
  const hiIdx = Math.max(0, Math.min(used - 1, Math.floor((upperPct / 100) * used)));
  let minZ = sorted[loIdx];
  let maxZ = sorted[hiIdx];

  // Guard against a degenerate flat cloud — every percentile maps to
  // the same value. In that case fall back to the true range so the
  // caller still receives a non-zero span (`colorByElevation` then
  // gives every point the bottom colour, which is correct).
  if (minZ === maxZ) {
    minZ = trueMin;
    maxZ = trueMax;
  }

  return {
    minZ,
    maxZ,
    trueMinZ: trueMin,
    trueMaxZ: trueMax,
    sampleCount: used,
  };
}
