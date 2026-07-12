/**
 * elevationRange.ts
 *
 * Percentile-clipped range computation for the scalar colour modes.
 * Born as the "Color by: Height" fix — replacing the naïve min/max
 * scan the v0.3.7-initial path used, where one tall outlier (a tree,
 * a power-line pole, a flag-mast) was enough to compress an entire
 * field of points into a single colour stop because true-max Z sat
 * 20-30 m above where 99 % of the cloud's points actually live.
 * The same failure applies to ANY per-point scalar (intensity spikes,
 * a stray GPS-time outlier), so the core is generic: `computeScalarRange`
 * works on a flat per-point array — the gpsTime colour mode ranges
 * through it in both the static and streaming pipelines — and
 * `computeElevationRange` remains as a thin wrapper that reads the
 * up-axis out of interleaved positions. Not every scalar mode wants the
 * clip: returnNumber deliberately ranges on raw finite min/max (small
 * ordinals with no outlier failure mode — see its `colorForMode` case).
 *
 * The standard mitigation, used by CloudCompare, Potree, and the
 * Entwine viewer: pick the [P, 100 - P] percentile band (defaults to
 * the 5th / 95th percentile) and map the colour ramp across that
 * band. Points above the upper percentile clamp to the top colour;
 * points below the lower percentile clamp to the bottom colour. The
 * points in between get the FULL dynamic range of the palette —
 * exactly what an analyst expects.
 *
 * Pure data — no DOM, no three.js — so the helper ships through the
 * same module-graph seam every Stream A leaf uses.
 */

/** A clipped scalar range, ready to feed `colorByScalar`. */
export interface ScalarRange {
  /** Low end of the colour ramp. */
  readonly min: number;
  /** High end of the colour ramp. */
  readonly max: number;
  /** True minimum in the sample. Always ≤ `min`. */
  readonly trueMin: number;
  /** True maximum in the sample. Always ≥ `max`. */
  readonly trueMax: number;
  /** Sample count actually examined. */
  readonly sampleCount: number;
}

/** Options for `computeScalarRange`. */
export interface ScalarRangeOptions {
  /** Value count to walk — defaults to `values.length`. */
  count?: number;
  /**
   * Lower percentile to clip to (0..50). Default 5.
   * `colorByScalar` will treat any value below this as the bottom colour.
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
   * `colorByScalar` will treat any value above this as the top colour.
   */
  upperPercentile?: number;
  /**
   * Sampling stride. The analyser walks one value every `stride`,
   * so a stride of 64 gives 1 / 64 the cloud's points. Defaults to a
   * stride that yields ~50 000 samples on the input — fast on a
   * 10 M-point cloud, statistically stable on smaller ones.
   */
  stride?: number;
}

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
  /** Lower percentile to clip to (0..50). Default 5 — see `ScalarRangeOptions`. */
  lowerPercentile?: number;
  /** Upper percentile to clip to (50..100). Default 95 — see `ScalarRangeOptions`. */
  upperPercentile?: number;
  /** Sampling stride — see `ScalarRangeOptions`. */
  stride?: number;
  /**
   * Which interleaved component is "up": 2 = Z (LAS/LAZ/E57 surveys), 1 = Y
   * (phone-scan PLY/OBJ/GLB). Defaults to Z. The `minZ`/`maxZ` field names are
   * historical — they hold the range of whichever axis is up.
   */
  upAxis?: 0 | 1 | 2;
}

/**
 * Compute a percentile-clipped range over a flat per-point scalar array.
 *
 * Returns the full true-min / true-max alongside the clipped range so
 * the caller can show "showing 5 % – 95 % range (38.4 – 41.7 m), with
 * outliers at 42.9 m on top and 38.1 m on bottom" if they want to.
 *
 * Handles the degenerate "every value identical" case — both `min` and
 * `max` come back equal in that case so the caller can skip the ramp.
 */
export function computeScalarRange(
  values: ArrayLike<number>,
  options: ScalarRangeOptions = {},
): ScalarRange {
  return percentileRangeCore(
    values,
    options.count ?? values.length,
    options.lowerPercentile,
    options.upperPercentile,
    options.stride,
    1,
    0,
  );
}

/**
 * Compute a percentile-clipped elevation range — the up-axis of interleaved
 * positions fed through the generic scalar core. Kept as the historical
 * entry point so every "Color by: Height" call site (static recolour, trim
 * slider, streaming reseed) reads through one seam.
 */
export function computeElevationRange(
  input: ElevationRangeInput,
): ElevationRange {
  const r = percentileRangeCore(
    input.positions,
    input.pointCount ?? input.positions.length / 3,
    input.lowerPercentile,
    input.upperPercentile,
    input.stride,
    3,
    input.upAxis ?? 2,
  );
  return {
    minZ: r.min,
    maxZ: r.max,
    trueMinZ: r.trueMin,
    trueMaxZ: r.trueMax,
    sampleCount: r.sampleCount,
  };
}

/**
 * The shared percentile-band algorithm. `elemStride` / `elemOffset` let the
 * elevation wrapper read one component out of interleaved xyz triplets
 * (stride 3, offset = up-axis) while the flat scalar path reads every value
 * (stride 1, offset 0) — one implementation, so the two entry points can
 * never drift on percentile-pick or degenerate-input semantics.
 */
function percentileRangeCore(
  values: ArrayLike<number>,
  total: number,
  lowerPercentile: number | undefined,
  upperPercentile: number | undefined,
  strideOption: number | undefined,
  elemStride: number,
  elemOffset: number,
): ScalarRange {
  if (total === 0) {
    return { min: 0, max: 0, trueMin: 0, trueMax: 0, sampleCount: 0 };
  }
  const lowerPct = Math.max(0, Math.min(50, lowerPercentile ?? 5));
  const upperPct = Math.max(50, Math.min(100, upperPercentile ?? 95));
  const targetSamples = 50_000;
  const stride = Math.max(1, strideOption ?? Math.max(1, Math.floor(total / targetSamples)));

  // First pass — track true min/max and copy the samples into a typed
  // array we can sort. The strided walk keeps the allocation bounded
  // even on 100 M-point streaming chunks. The buffer is Float64 because
  // GPS time is a Float64 with ~3e8 s absolute values — a Float32 copy
  // quantises those to ~32 s steps and collapses a whole flight line's
  // band into a handful of values.
  const sampleCap = Math.min(targetSamples, Math.ceil(total / stride));
  const sample = new Float64Array(sampleCap);
  let trueMin = Number.POSITIVE_INFINITY;
  let trueMax = Number.NEGATIVE_INFINITY;
  let idx = 0;
  for (let i = 0; i < total && idx < sampleCap; i += stride) {
    const v = values[i * elemStride + elemOffset];
    // Skip non-finite values: a malformed binary loader can hand us
    // NaN/Infinity, and letting them into the sorted sample lets a NaN land
    // on the percentile index, making the max NaN and rendering the whole
    // ramp-coloured cloud solid black (range = NaN → every t = NaN → 0).
    if (!Number.isFinite(v)) continue;
    sample[idx++] = v;
    if (v < trueMin) trueMin = v;
    if (v > trueMax) trueMax = v;
  }

  // Trim the sample to the actual length we filled. Sort then pick
  // percentiles. The sort is a single pass — the ~50 000-sample cap
  // makes the worst case ~3 ms.
  const used = idx;
  if (used === 0) {
    return { min: 0, max: 0, trueMin: 0, trueMax: 0, sampleCount: 0 };
  }
  if (used === 1) {
    const v = sample[0];
    return { min: v, max: v, trueMin: v, trueMax: v, sampleCount: 1 };
  }
  const sorted = sample.subarray(0, used).slice();
  sorted.sort();

  // Percentile pick — `Math.floor` so a low percentile picks a low index.
  // We clamp the upper to the last valid index so the 100th percentile
  // returns the largest value rather than reading past the end.
  const loIdx = Math.max(0, Math.min(used - 1, Math.floor((lowerPct / 100) * used)));
  const hiIdx = Math.max(0, Math.min(used - 1, Math.floor((upperPct / 100) * used)));
  let min = sorted[loIdx];
  let max = sorted[hiIdx];

  // Guard against a degenerate flat distribution — every percentile maps
  // to the same value. In that case fall back to the true range so the
  // caller still receives a non-zero span (`colorByScalar` then gives
  // every point the bottom colour, which is correct).
  if (min === max) {
    min = trueMin;
    max = trueMax;
  }

  return {
    min,
    max,
    trueMin,
    trueMax,
    sampleCount: used,
  };
}
