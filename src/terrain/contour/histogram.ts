/**
 * histogram.ts
 *
 * Pure-data histogram binning for value distributions — e.g. the bare-earth
 * DTM elevation distribution surfaced in the Analyse panel. Deterministic,
 * no DOM, no I/O, so it is unit-testable in isolation.
 */

export interface Histogram {
  /** Count of finite values in each bin; `counts.length === binCount`. */
  readonly counts: number[];
  /** Lower edge of the first bin (the minimum finite value), NaN if empty. */
  readonly min: number;
  /** Upper edge of the last bin (the maximum finite value), NaN if empty. */
  readonly max: number;
  /** Width of each bin in value units (0 when all values are equal/empty). */
  readonly binWidth: number;
  /** Total finite values counted. */
  readonly total: number;
  /** Largest single-bin count — convenient for scaling bars to full height. */
  readonly peak: number;
}

/**
 * Bin `values` into `binCount` equal-width buckets between the min and max of
 * the finite entries. Non-finite values (NaN/±Infinity) are skipped. The
 * maximum value lands in the last bin (half-open bins, closed at the top).
 */
export function histogramBins(values: ArrayLike<number>, binCount: number): Histogram {
  const bins = Math.max(1, Math.floor(binCount));
  let min = Infinity;
  let max = -Infinity;
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    total++;
  }

  const counts = new Array<number>(bins).fill(0);

  // Empty, or a degenerate single-value spread: everything in bin 0, width 0.
  if (total === 0 || !(max > min)) {
    if (total > 0) counts[0] = total;
    return {
      counts,
      min: total ? min : Number.NaN,
      max: total ? max : Number.NaN,
      binWidth: 0,
      total,
      peak: total ? counts[0] : 0,
    };
  }

  const span = max - min;
  const binWidth = span / bins;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let idx = Math.floor(((v - min) / span) * bins);
    if (idx >= bins) idx = bins - 1; // the max value closes the last bin
    if (idx < 0) idx = 0;
    counts[idx]++;
  }

  let peak = 0;
  for (const c of counts) if (c > peak) peak = c;
  return { counts, min, max, binWidth, total, peak };
}
