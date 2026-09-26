/**
 * quantile.ts
 *
 * THE percentile convention for the project: the "linear" / type-7 quantile
 * (linear interpolation between the two bracketing order statistics), the
 * default of NumPy, R and Excel's PERCENTILE.INC — so every reported
 * percentile is reproducible against standard tools.
 *
 * WHY one shared helper. The v0.5.3 audit found THREE percentile
 * conventions coexisting: nearest-rank (`ceil(q·n)−1`) in holdoutRmse /
 * buildDsm / hillshade vs type-7 in rasterizeDtm / lassoVolume /
 * profileSampler. The two disagree by up to one order-statistic gap — a
 * p95 residual, a p95 slope and a p95 canopy height would each round
 * differently depending on which file computed them. The terrain, validation
 * and diagnostics modules now route through here, and so do the render,
 * validation and perf call sites that used to carry private copies.
 *
 * NAMED VARIANTS. Some call sites deliberately use a different convention,
 * and changing one would move a published or claimed number. Each lives here
 * under a name that says what it is, so a reader can see which convention a
 * site uses without reading its arithmetic:
 *
 *   - {@link quantileSorted} / {@link quantile}: type-7 linear (the default).
 *   - {@link quantileType7InPlace}: type-7 on a Float64Array sorted in place,
 *     written with the (hi − idx) weight the lasso occlusion gate was tuned on.
 *   - {@link quantileNearestRankSorted}: nearest-rank, `ceil(p·n) − 1`, so the
 *     result is always an observed value (validation residuals, bootstrap
 *     endpoints, frame-time percentiles).
 *   - {@link floorRankIndex}: the `floor(p·n)` index pick the colour-range
 *     and RGB-histogram paths use.
 *
 * A future percentile need must import one of these, not re-derive its own.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/**
 * Type-7 quantile of an ASCENDING-sorted, non-empty array at fraction
 * `p` in [0, 1] (clamped). `p = 0` returns the minimum, `p = 1` the
 * maximum, `p = 0.5` the median. The caller guarantees the array is
 * sorted and non-empty — this is the hot-loop form (per-cell / per-bin
 * reductions sort once and query once or twice).
 */
export function quantileSorted(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const frac = Math.min(1, Math.max(0, p));
  const rank = frac * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Type-7 quantile of an UNSORTED array: filters to finite values first
 * (NaN ordering under `Array.prototype.sort` is implementation-defined —
 * the historical silent-failure bug lassoVolume documents), sorts a copy,
 * then delegates to {@link quantileSorted}. Returns NaN when nothing
 * finite survives, so callers can surface the failure instead of "0".
 */
export function quantile(values: ReadonlyArray<number>, p: number): number {
  const finite: number[] = [];
  for (const v of values) if (Number.isFinite(v)) finite.push(v);
  if (finite.length === 0) return Number.NaN;
  finite.sort((a, b) => a - b);
  return quantileSorted(finite, p);
}

/**
 * Type-7 quantile of a Float64Array, SORTING IT IN PLACE first. `p` in [0, 1]
 * (clamped). Algebraically the same estimator as {@link quantileSorted}, but
 * the interpolation is written `v[lo]·(hi − idx) + v[hi]·(idx − lo)`, which
 * can differ from the `(1 − w)` form in the last bit. The lasso occlusion gate
 * compares against this exact value, so it keeps its own spelling. Returns NaN
 * for an empty array.
 */
export function quantileType7InPlace(values: Float64Array, p: number): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  values.sort();
  const idx = Math.max(0, Math.min(1, p)) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return values[lo];
  return values[lo] * (hi - idx) + values[hi] * (idx - lo);
}

/**
 * Nearest-rank quantile over the first `n` entries (default: all) of an
 * ASCENDING array: the smallest value with at least a fraction `p` of samples
 * at or below it, index `ceil(p·n) − 1` clamped into range. Every result is
 * an observed value. The caller guarantees `n ≥ 1`.
 */
export function quantileNearestRankSorted(
  sorted: ArrayLike<number>,
  p: number,
  n: number = sorted.length,
): number {
  const idx = Math.max(0, Math.ceil(p * n) - 1);
  return sorted[Math.min(idx, n - 1)];
}

/**
 * Index of the `floor(p·n)` order statistic, clamped to `[0, n − 1]` — the
 * low-biased pick the colour-range clip and the RGB histogram use.
 */
export function floorRankIndex(n: number, p: number): number {
  return Math.max(0, Math.min(n - 1, Math.floor(p * n)));
}
