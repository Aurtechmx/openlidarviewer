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

/** The first field on which two summaries disagree, with both sides' values. */
export interface SummaryDifference {
  readonly key: string;
  readonly published: number | null;
  readonly recomputed: number | null;
}

/**
 * The first way two summaries differ, or null when they are bit-identical.
 *
 * Returns the FIELD, not a boolean. `benchmark:verify` prints this straight
 * into its failure message, and a message that always names the median is
 * actively misleading when the median is the one field that did not change: an
 * operator reading "published median 830.206, recomputed 830.206" concludes the
 * verifier is broken rather than that `min` was edited.
 *
 * Exact equality on purpose: both sides run the same code over the same
 * doubles, so any difference at all means the summary was edited or the raw
 * values were, and either is a reason to fail rather than to tolerate.
 */
export function firstSummaryDifference(
  a: SeriesSummary,
  b: SeriesSummary,
): SummaryDifference | null {
  const keys = ['count', 'min', 'max', 'mean', 'median', 'q1', 'q3', 'iqr', 'stdDev', 'cv'] as const;
  for (const key of keys) {
    if (a[key] !== b[key]) return { key, published: a[key], recomputed: b[key] };
  }
  if (a.values.length !== b.values.length) {
    return { key: 'values.length', published: a.values.length, recomputed: b.values.length };
  }
  for (const [i, v] of a.values.entries()) {
    if (v !== b.values[i]) return { key: `values[${i}]`, published: v, recomputed: b.values[i] };
  }
  return null;
}

/** Whether two summaries are bit-identical. See {@link firstSummaryDifference}. */
export function summariesMatch(a: SeriesSummary, b: SeriesSummary): boolean {
  return firstSummaryDifference(a, b) === null;
}

/** Half-widths of the robust band, in IQRs and as a fraction. See {@link checkFirstRun}. */
export const FIRST_RUN_BAND_IQRS = 3;
export const FIRST_RUN_BAND_FRACTION = 0.05;

/** Below this many comparison runs the band is too wide to mean anything. */
export const FIRST_RUN_MIN_COMPARISON_RUNS = 5;

/**
 * Where the FIRST recorded run sits relative to the rest.
 *
 * The question is whether the warm-up finished warming up. A residual JIT or
 * first-touch transient shows up as run 1 sitting systematically above
 * everything that follows, and it does not read as noise — it inflates the
 * published coefficient of variation while the pipeline itself is steady. With
 * one warm-up the first recorded runs came in about 11 % slow and the CV
 * overstated instability by roughly 2.4x.
 *
 * WHY THE CONDITION IS A ROBUST BAND AND NOT AN ORDER STATISTIC. The obvious
 * checks are order statistics — "run 1 is inside the rest's IQR", "inside their
 * min-max range" — and both are unusable as gates, because under a perfectly
 * stationary process they fail on a coin flip. IQR membership holds about half
 * the time by construction; range membership fails with probability 2/n, which
 * is a 20 % false-failure rate over ten runs. A gate that red-lights one run in
 * five teaches everyone to ignore it.
 *
 * So the condition is a distribution-free band around the rest's MEDIAN:
 *
 *     |run₁ − median(rest)| ≤ max(3 · IQR(rest), 0.05 · |median(rest)|)
 *
 * Both terms earn their place. The IQR term is what makes it a statistical
 * statement — three interquartile ranges from the median is far outside
 * ordinary run-to-run spread, so a real transient trips it (the 11 % case sits
 * about four IQRs out). The fractional floor is what stops it firing on a
 * workload so steady that its IQR is near zero, where three IQRs would be a
 * band of microseconds and every run would look anomalous. Together they fire
 * only when run 1 is both statistically far out AND materially different.
 *
 * WHY NOTHING GATES ON THIS, INCLUDING THE BAND. The transient does not go away
 * with more warm-ups, and it is not a property of the code. Measured on one
 * machine: one warm-up left the first two recorded runs ~11 % slow; three left
 * ~8 %; six left ~9 % on a loaded machine and a fresh child process still spiked
 * 28 % on its first recorded run. It tracks machine load and allocator state, so
 * a hard failure would red-light a correct pipeline because something else was
 * running — the same objection that rules out the order statistics above, and
 * the fastest way to teach everyone to ignore a red benchmark.
 *
 * What replaces the gate is measurement. {@link FirstRunCheck} carries the
 * dispersion of the series WITH run 1 and WITHOUT it, both are published side
 * by side, and the difference between them IS the contamination. A reader
 * quoting a repeatability figure can then quote the one that excludes the
 * transient and say so, instead of quoting a number that silently contains it.
 *
 * Both order statistics are also REPORTED, as diagnostics, because a reader
 * comparing two result sets wants them.
 */
export interface FirstRunCheck {
  readonly firstValue: number;
  readonly restCount: number;
  readonly restMin: number;
  readonly restMax: number;
  readonly restMedian: number;
  readonly restQ1: number;
  readonly restQ3: number;
  readonly restIqr: number;
  /** Half-width of the band, after the fractional floor. Null below the minimum. */
  readonly bandHalfWidth: number | null;
  /** Whether run 1 sits inside that band. Null when the band is not meaningful. */
  readonly withinRobustBand: boolean | null;
  /** Why there is no band, or null when there is one. */
  readonly bandUnavailableReason: string | null;
  /**
   * The dispersion of the series INCLUDING run 1 and EXCLUDING it.
   *
   * The pair is the point. Published together, the difference between them is
   * the size of the residual transient, stated in the same units as the
   * headline figure — so a reader can quote the repeatability of the pipeline
   * rather than the repeatability of the pipeline plus one cold start, and can
   * see exactly how much the choice was worth.
   */
  readonly cvAllRuns: number | null;
  readonly cvExcludingFirstRun: number | null;
  /** Diagnostic only — fails on a coin flip under a stationary process. */
  readonly withinRestRange: boolean;
  /** Diagnostic only — holds about half the time under a stationary process. */
  readonly withinRestIqr: boolean;
  /** > 1 means run 1 was slower than the typical later run. */
  readonly ratioToRestMedian: number | null;
}

export function checkFirstRun(values: readonly number[]): FirstRunCheck | null {
  // Needs a first run plus at least two others: with one comparison value there
  // is no spread to place run 1 against, and any verdict would be arbitrary.
  if (values.length < 3) return null;
  const [first, ...rest] = values;
  const s = summariseSeries(rest);
  const all = summariseSeries(values);
  const enough = rest.length >= FIRST_RUN_MIN_COMPARISON_RUNS;
  const bandHalfWidth = enough
    ? Math.max(FIRST_RUN_BAND_IQRS * s.iqr, FIRST_RUN_BAND_FRACTION * Math.abs(s.median))
    : null;
  return {
    firstValue: first,
    restCount: rest.length,
    restMin: s.min,
    restMax: s.max,
    restMedian: s.median,
    restQ1: s.q1,
    restQ3: s.q3,
    restIqr: s.iqr,
    bandHalfWidth,
    withinRobustBand: bandHalfWidth === null ? null : Math.abs(first - s.median) <= bandHalfWidth,
    bandUnavailableReason: enough
      ? null
      : `only ${rest.length} comparison runs; the band's width comes from their IQR, which needs at least ` +
        `${FIRST_RUN_MIN_COMPARISON_RUNS} points before a single slow run can be told apart from a transient`,
    cvAllRuns: all.cv,
    cvExcludingFirstRun: s.cv,
    withinRestRange: first >= s.min && first <= s.max,
    withinRestIqr: first >= s.q1 && first <= s.q3,
    ratioToRestMedian: s.median === 0 ? null : first / s.median,
  };
}
