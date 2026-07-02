/**
 * quantile.ts
 *
 * THE percentile convention for the project: the "linear" / type-7 quantile
 * (linear interpolation between the two bracketing order statistics), the
 * default of NumPy, R and Excel's PERCENTILE.INC — so every reported
 * percentile is reproducible against standard tools.
 *
 * WHY one shared helper. The v0.4.3 audit found THREE percentile
 * conventions coexisting: nearest-rank (`ceil(q·n)−1`) in holdoutRmse /
 * buildDsm / hillshade vs type-7 in rasterizeDtm / lassoVolume /
 * profileSampler. The two disagree by up to one order-statistic gap — a
 * p95 residual, a p95 slope and a p95 canopy height would each round
 * differently depending on which file computed them. Everything now
 * routes through here; a future percentile need must import this, not
 * re-derive its own.
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
  const frac = p < 0 ? 0 : p > 1 ? 1 : p;
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
