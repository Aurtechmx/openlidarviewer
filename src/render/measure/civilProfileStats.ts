/**
 * civilProfileStats.ts
 *
 * Pure, unit-testable civil/topographic statistics over a sampled
 * height-vs-distance profile — the numbers an engineer needs to do real
 * work off the section: stationing, per-segment grade, relief, and the
 * overall slope. No DOM, no three.js, no I/O.
 *
 * Honesty contract (inherited from the sampler): a `null` elevation is a
 * no-coverage gap, never an interpolated value. Grades are only computed
 * between two adjacent stations that both have real elevations; a segment
 * touching a gap reports a `null` grade rather than inventing one.
 *
 * Grade convention: rise / run as a signed fraction (positive = uphill in
 * the direction of increasing chainage). Helpers convert to percent,
 * 1:n ratio, and degrees — the three forms civil drawings use.
 */

import type { ProfileChartSample } from './types';

/** One station along the profile, in civil terms. */
export interface ProfileStation {
  /** 0-based station index along the transect. */
  readonly index: number;
  /** Distance from the start, metres (the "chainage"). */
  readonly chainage: number;
  /** Elevation in metres, or null where the bin had no coverage. */
  readonly elevation: number | null;
  /**
   * Signed grade (rise/run, fraction) from this station to the next one,
   * or null when either end is a gap or this is the last station.
   */
  readonly gradeToNext: number | null;
}

/** Civil summary of a profile. */
export interface CivilProfileStats {
  /** Horizontal length of the transect, metres. */
  readonly length: number;
  /** Number of samples (stations) along the line. */
  readonly sampleCount: number;
  /** Fraction of stations with real coverage (0..1). */
  readonly coverage: number;
  /** Lowest covered elevation, or null if no coverage. */
  readonly minElevation: number | null;
  /** Highest covered elevation, or null if no coverage. */
  readonly maxElevation: number | null;
  /** maxElevation − minElevation (relief), or null if no coverage. */
  readonly reliefSpan: number | null;
  /**
   * Net grade across the section: (last covered elevation − first
   * covered elevation) / (chainage between those two covered stations).
   * null when fewer than two stations are covered.
   */
  readonly meanGrade: number | null;
  /** Largest |grade| over any adjacent covered pair, or null. */
  readonly maxGrade: number | null;
  /** Every station, in order. */
  readonly stations: ProfileStation[];
}

const finite = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n);

/** Compute the civil statistics for a profile sample series. */
export function computeCivilProfileStats(
  samples: ReadonlyArray<ProfileChartSample>,
): CivilProfileStats {
  const n = samples.length;
  const stations: ProfileStation[] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let hits = 0;
  let firstHit = -1;
  let lastHit = -1;
  let maxGrade: number | null = null;

  for (let i = 0; i < n; i++) {
    const h = samples[i].height;
    const el = finite(h) ? h : null;
    if (el != null) {
      hits++;
      if (firstHit < 0) firstHit = i;
      lastHit = i;
      if (el < min) min = el;
      if (el > max) max = el;
    }
    stations.push({ index: i, chainage: samples[i].distance, elevation: el, gradeToNext: null });
  }

  // Per-segment grade to the next station (both ends must be covered).
  for (let i = 0; i < n - 1; i++) {
    const a = stations[i];
    const b = stations[i + 1];
    if (a.elevation == null || b.elevation == null) continue;
    const run = b.chainage - a.chainage;
    if (Math.abs(run) < 1e-9) continue;
    const grade = (b.elevation - a.elevation) / run;
    // stations is mutable here before we freeze it into the result.
    (stations[i] as { gradeToNext: number | null }).gradeToNext = grade;
    const mag = Math.abs(grade);
    if (maxGrade == null || mag > maxGrade) maxGrade = mag;
  }

  const length = n > 0 ? samples[n - 1].distance - samples[0].distance : 0;
  const minElevation = hits > 0 ? min : null;
  const maxElevation = hits > 0 ? max : null;
  const reliefSpan =
    minElevation != null && maxElevation != null ? maxElevation - minElevation : null;

  let meanGrade: number | null = null;
  if (firstHit >= 0 && lastHit > firstHit) {
    const run = stations[lastHit].chainage - stations[firstHit].chainage;
    if (Math.abs(run) > 1e-9) {
      meanGrade =
        ((stations[lastHit].elevation as number) - (stations[firstHit].elevation as number)) / run;
    }
  }

  return {
    length,
    sampleCount: n,
    coverage: n > 0 ? hits / n : 0,
    minElevation,
    maxElevation,
    reliefSpan,
    meanGrade,
    maxGrade,
    stations,
  };
}

/**
 * Format a chainage in metric civil stationing: `km+metres`, e.g.
 * 1234.5 → "1+234.50". Matches the convention on metric road/rail
 * drawings (station unit = 1000 m).
 */
export function formatStationing(chainageM: number): string {
  if (!Number.isFinite(chainageM)) return '—';
  const sign = chainageM < 0 ? '-' : '';
  const m = Math.abs(chainageM);
  const km = Math.floor(m / 1000);
  const rem = m - km * 1000;
  return `${sign}${km}+${rem.toFixed(2).padStart(6, '0')}`;
}

/** Grade as a percentage string, e.g. 0.024 → "2.40%". */
export function formatGradePercent(grade: number | null): string {
  if (grade == null || !Number.isFinite(grade)) return '—';
  return `${(grade * 100).toFixed(2)}%`;
}

/** Grade as a 1:n ratio string, e.g. 0.02 → "1:50". Flat → "level". */
export function formatGradeRatio(grade: number | null): string {
  if (grade == null || !Number.isFinite(grade)) return '—';
  const mag = Math.abs(grade);
  if (mag < 1e-6) return 'level';
  return `1:${(1 / mag).toFixed(mag >= 0.1 ? 1 : 0)}`;
}

/** Grade as an angle in degrees, e.g. 0.0268 → "1.5°". */
export function formatGradeDegrees(grade: number | null): string {
  if (grade == null || !Number.isFinite(grade)) return '—';
  return `${((Math.atan(grade) * 180) / Math.PI).toFixed(1)}°`;
}
