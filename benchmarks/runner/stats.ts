/**
 * stats.ts
 *
 * The one implementation of every summary statistic a benchmark suite reports.
 *
 * WHY ONE IMPLEMENTATION. `benchmark:verify` re-derives every published summary
 * from the raw values and fails when the two disagree. That check is only worth
 * running if the verifier and the suites cannot drift: two "median" functions,
 * one averaging the middle pair and one not, would make the verifier certify a
 * number nobody else computes. So both sides call exactly these functions.
 *
 * WHY TYPE-7. There are nine textbook quantile definitions and they disagree on
 * every sample whose size is not 4k+1 — an IQR quoted without naming one is not
 * a reproducible figure. Type 7 is R's default, NumPy's default and the
 * convention the rest of this project already reports with, so a reader
 * recomputing an IQR from `raw.json` in either tool lands on the published
 * number. {@link QUANTILE_CONVENTION} is written into every summary file so the
 * choice travels with the data rather than living only in this comment.
 *
 * WHY NULLS RATHER THAN ZEROS. A sample standard deviation needs n ≥ 2; with a
 * single run there is no dispersion to report, and `0` would read as "perfectly
 * repeatable" — the exact false claim the framework's metric union exists to
 * make impossible. So the dispersion fields are `null` and the reason is carried
 * alongside them in `unavailable`.
 *
 * Pure arithmetic: no clock, no I/O, no `node:` builtins.
 */

/** Named in every emitted summary, so an IQR can be recomputed unambiguously. */
export const QUANTILE_CONVENTION = 'type-7';

/**
 * The type-7 quantile of an ASCENDING-sorted sample.
 *
 * h = (n − 1)·p; the result interpolates linearly between the two neighbouring
 * order statistics. Takes the sorted array rather than sorting internally so a
 * caller computing q1, median and q3 sorts once — and so a caller that hands it
 * unsorted data gets a wrong answer loudly in a test rather than a plausible one
 * in a paper.
 */
export function quantileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error('quantile: empty sample');
  if (!(p >= 0 && p <= 1)) throw new Error(`quantile: p must be in [0, 1], got ${String(p)}`);
  if (sorted.length === 1) return sorted[0];
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** Ascending copy. Numeric comparator — `Array.sort` defaults to string order. */
export function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/**
 * Every statistic a suite publishes for one series, plus the raw values it came
 * from. The raw values ride along on purpose: a summary a reader cannot
 * recompute is a claim, not evidence.
 */
export interface SeriesSummary {
  readonly count: number;
  /** The recorded values, in RUN ORDER — never sorted, never rounded. */
  readonly values: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly q1: number;
  readonly q3: number;
  readonly iqr: number;
  /** Sample (n − 1) standard deviation. Null when n < 2. */
  readonly stdDev: number | null;
  /** stdDev / mean, dimensionless. Null when stdDev is null or mean is 0. */
  readonly cv: number | null;
  /** Why a null field is null, keyed by field name. Empty when all are present. */
  readonly unavailable: Readonly<Record<string, string>>;
}

/**
 * Summarise one series.
 *
 * Rejects a non-finite value outright rather than filtering it out: a NaN
 * duration means the measurement went wrong, and quietly summarising the other
 * nine would publish a mean over a sample the config says has ten members.
 */
export function summariseSeries(values: readonly number[]): SeriesSummary {
  if (values.length === 0) throw new Error('summariseSeries: empty sample');
  for (const [i, v] of values.entries()) {
    if (!Number.isFinite(v)) {
      throw new Error(`summariseSeries: value ${i} is not finite (${String(v)})`);
    }
  }

  const sorted = ascending(values);
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);

  const unavailable: Record<string, string> = {};
  let stdDev: number | null = null;
  if (n < 2) {
    unavailable.stdDev = 'a sample standard deviation needs at least two runs';
  } else {
    const ss = values.reduce((s, v) => s + (v - mean) * (v - mean), 0);
    stdDev = Math.sqrt(ss / (n - 1));
  }

  let cv: number | null = null;
  if (stdDev === null) {
    unavailable.cv = 'the coefficient of variation needs a sample standard deviation';
  } else if (mean === 0) {
    unavailable.cv = 'the coefficient of variation is undefined for a zero mean';
  } else {
    cv = stdDev / mean;
  }

  return {
    count: n,
    values: [...values],
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median: quantileSorted(sorted, 0.5),
    q1,
    q3,
    iqr: q3 - q1,
    stdDev,
    cv,
    unavailable,
  };
}

/**
 * Whether two summaries are bit-identical.
 *
 * Used by `benchmark:verify`, which recomputes a published summary from the
 * published raw values and compares. Exact equality on purpose: both sides run
 * the same code over the same doubles, so any difference means the summary was
 * edited or the raw values were, and either is a reason to fail rather than to
 * tolerate.
 */
export function summariesMatch(a: SeriesSummary, b: SeriesSummary): boolean {
  const keys = ['count', 'min', 'max', 'mean', 'median', 'q1', 'q3', 'iqr', 'stdDev', 'cv'] as const;
  for (const key of keys) {
    if (a[key] !== b[key]) return false;
  }
  if (a.values.length !== b.values.length) return false;
  return a.values.every((v, i) => v === b.values[i]);
}
