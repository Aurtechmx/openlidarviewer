/**
 * elevationHistogram.ts
 *
 * The distribution strip drawn above the elevation legend's ramp: how the
 * points used for colouring spread across the colour window, and how many
 * fall outside it.
 *
 * It reads the SAME strided sample `computeElevationRange` takes its
 * percentiles from (one value every `floor(n / 50 000)` points, at most
 * 50 000 finite values), so the strip and the window describe one set of
 * points. Nothing here feeds colouring: it is a read-only summary for the
 * legend, recomputed only when the window or the sample changes.
 *
 * Pure data and string math; no DOM, no three.js.
 */

/** The heights the elevation window was computed over. */
export interface ElevationSample {
  /** Number of points. */
  readonly count: number;
  /** Height of point `i` in the legend's world/source units. */
  value(i: number): number;
}

export interface ElevationHistogram {
  /** Window the bins span, in display units. */
  readonly min: number;
  readonly max: number;
  /** Point counts per bin across [min, max]. */
  readonly bins: Uint32Array;
  /** Sampled values below `min` and above `max`. */
  readonly below: number;
  readonly above: number;
  /** Sampled values in total (inside + outside the window). */
  readonly total: number;
  /** The sample, ascending, for percentile lookups. */
  readonly sorted: Float64Array;
}

/** Same cap as `computeElevationRange`, so both read the same sample. */
const TARGET_SAMPLES = 50_000;

/** Bin a sample across the window. Null when there is nothing to bin. */
export function buildElevationHistogram(
  sample: ElevationSample,
  min: number,
  max: number,
  binCount = 56,
): ElevationHistogram | null {
  const n = sample.count;
  if (!(n > 0) || !(max > min) || !Number.isFinite(min) || !Number.isFinite(max)) return null;
  const stride = Math.max(1, Math.floor(n / TARGET_SAMPLES));
  const cap = Math.min(TARGET_SAMPLES, Math.ceil(n / stride));
  const values = new Float64Array(cap);
  let used = 0;
  for (let i = 0; i < n && used < cap; i += stride) {
    const v = sample.value(i);
    if (Number.isFinite(v)) values[used++] = v;
  }
  if (used === 0) return null;
  const sorted = values.subarray(0, used).slice().sort();
  const bins = new Uint32Array(binCount);
  const span = max - min;
  let below = 0;
  let above = 0;
  for (let i = 0; i < used; i++) {
    const v = sorted[i];
    if (v < min) below++;
    else if (v > max) above++;
    else bins[Math.min(binCount - 1, Math.floor(((v - min) / span) * binCount))]++;
  }
  return { min, max, bins, below, above, total: used, sorted };
}

/** Share of the sample below / above the window, in percent. */
export function clipShares(h: ElevationHistogram): { below: number; above: number } {
  return { below: (h.below / h.total) * 100, above: (h.above / h.total) * 100 };
}

/** Percent of the sample at or below `v` (0–100). */
export function percentileOf(h: ElevationHistogram, v: number): number {
  const s = h.sorted;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (s[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return (lo / s.length) * 100;
}

/** Value at percent `p` of the sample (floor rank, as the window uses). */
function valueAt(h: ElevationHistogram, p: number): number {
  const s = h.sorted;
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * s.length)))];
}

/** "1st", "22nd", "71st", "100th". */
export function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/** Whole-percent share with a "<1" floor so a few outliers never read as 0. */
export function formatShare(p: number): string {
  if (p === 0) return '0%';
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/**
 * The strip's text alternative: where the middle half of the sample sits and
 * how much lies outside the window.
 */
export function describeHistogram(
  h: ElevationHistogram,
  fmt: (v: number) => string,
  unit: string,
): string {
  const c = clipShares(h);
  return (
    `Half the sampled points lie between ${fmt(valueAt(h, 25))} and ${fmt(valueAt(h, 75))} ${unit}; ` +
    `${formatShare(c.below)} below ${fmt(h.min)}, ${formatShare(c.above)} above ${fmt(h.max)}.`
  );
}
