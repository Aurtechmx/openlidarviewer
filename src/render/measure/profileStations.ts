/**
 * profileStations.ts
 *
 * Pure data layer for civil/survey chainage along a profile section
 * line. Given the two endpoints of a profile measurement and a station
 * interval, returns the ordered list of stations (cumulative distance
 * from the start, plus the 3D world position at that station). Given a
 * sample series (height-vs-distance from `profileSampler`), returns
 * per-segment slope grades between adjacent stations and a min/max/avg
 * summary.
 *
 * v0.3.10 deliverable patch — these two pure functions are the
 * foundation for the Profile-as-Deliverable rendering pass. The chart
 * renderer (renderProfileChart) consumes them to draw station tick
 * marks + labels; the PDF report consumes them to emit a station
 * table + a slope summary block; a future 3D-scene overlay will
 * consume the world positions to drop sphere markers on the cloud at
 * each station. Pure, unit-testable, no DOM, no three.js.
 *
 * Conventions:
 *   - `chainage` is the civil-engineering term for "cumulative
 *     distance along the section line, measured horizontally" — the
 *     same number a surveyor would call out as `0+000`, `0+050`,
 *     `0+100` for 50 m stations. We emit the raw number in metres
 *     here; format.ts turns it into a unit-toggled label.
 *   - Stations are placed at multiples of `intervalM` starting at
 *     chainage 0 and stopping at-or-before the total horizontal
 *     length. The endpoint is always included as the last station
 *     even when it doesn't fall on an interval boundary — a survey
 *     deliverable ALWAYS shows the end of the section.
 *   - Slope grades are computed PER SEGMENT (between adjacent
 *     stations), not per chart bin. This matches how a civil
 *     engineer reads a profile: "this 50 m segment is a 3.2 % grade,
 *     the next one is 5.8 %." Bin-by-bin slopes would be noisy.
 */

import type { Vec3 } from '../navMath';
import type { ProfileChartSample } from './types';

/** One station along the section line. */
export interface ProfileStation {
  /**
   * Cumulative distance from the start of the section, in metres,
   * measured horizontally (XY-plane projection of the line — the same
   * convention `profileSampler` uses for its `distance` field).
   */
  readonly chainage: number;
  /**
   * The 3D world-space position at this chainage. Z is interpolated
   * linearly between the two endpoint Z values — this is intentional
   * (the station marker sits on the straight line between the
   * picked endpoints, not on the cloud surface). A future overlay
   * can drop a sphere here and project it onto the cloud if needed.
   */
  readonly position: Vec3;
  /**
   * `true` when this station is the terminal one — the section's
   * actual endpoint, which may not fall on an `intervalM` boundary.
   * Consumers can render this with a different glyph (a triangle
   * instead of a tick) so the deliverable reads "this is the END,
   * not just another 50 m mark."
   */
  readonly isEndpoint: boolean;
}

/** Inputs to `stationsAlongLine`. */
export interface StationsAlongLineInput {
  /** Start of the section, world space. */
  readonly a: Vec3;
  /** End of the section, world space. */
  readonly b: Vec3;
  /**
   * Station spacing, in metres of horizontal chainage. Typical civil
   * values: 5, 10, 25, 50, 100. Must be > 0.
   */
  readonly intervalM: number;
}

/**
 * Emit station markers along the section line at the given interval.
 *
 * Returns a non-empty list when the horizontal length of the section
 * is > 0. Returns an empty list when the section is degenerate (both
 * endpoints coincide horizontally) — the consumer should suppress
 * the station overlay entirely in that case.
 *
 * NaN-safe: returns `[]` when any input coordinate is non-finite or
 * the interval is non-positive.
 */
export function stationsAlongLine(input: StationsAlongLineInput): ProfileStation[] {
  const { a, b, intervalM } = input;
  if (!Number.isFinite(intervalM) || intervalM <= 0) return [];
  for (const v of [a[0], a[1], a[2], b[0], b[1], b[2]]) {
    if (!Number.isFinite(v)) return [];
  }
  // Horizontal length only — survey chainage is measured in the
  // ground plane, not along the 3D vector. This matches how
  // `profileSampler` emits distances.
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const horizontalLen = Math.hypot(dx, dy);
  if (horizontalLen === 0) return [];

  const stations: ProfileStation[] = [];
  // Walk by interval. Use a tiny epsilon to avoid emitting a station
  // at-or-just-past the endpoint due to float drift.
  const eps = horizontalLen * 1e-9;
  // The unit vector in horizontal XY space — we lerp position along
  // this; Z is interpolated linearly between a.z and b.z based on
  // chainage fraction.
  const ux = dx / horizontalLen;
  const uy = dy / horizontalLen;
  const dz = b[2] - a[2];

  // First station: chainage 0 (the start).
  stations.push({ chainage: 0, position: [a[0], a[1], a[2]], isEndpoint: false });
  let chainage = intervalM;
  while (chainage < horizontalLen - eps) {
    const t = chainage / horizontalLen;
    stations.push({
      chainage,
      position: [a[0] + ux * chainage, a[1] + uy * chainage, a[2] + dz * t],
      isEndpoint: false,
    });
    chainage += intervalM;
  }
  // Terminal station — always emit, even when it lands very close
  // to a regular interval (the duplicate guard above prevents
  // double-emit by stopping the while loop one epsilon before).
  stations.push({
    chainage: horizontalLen,
    position: [b[0], b[1], b[2]],
    isEndpoint: true,
  });
  return stations;
}

/** One slope grade between two adjacent stations. */
export interface SlopeGrade {
  /** Index of the first station in the segment. */
  readonly fromIndex: number;
  /** Index of the second station in the segment. */
  readonly toIndex: number;
  /** Horizontal distance covered by this segment, metres. */
  readonly run: number;
  /** Vertical rise across this segment, metres (positive = uphill from→to). */
  readonly rise: number;
  /** Grade percentage: 100 × rise / run. NaN if run = 0. */
  readonly gradePercent: number;
  /** Grade as an angle from horizontal, degrees. NaN if run = 0. */
  readonly gradeDegrees: number;
}

/** Summary of grades across the whole section. */
export interface SlopeSummary {
  /** Steepest uphill grade encountered, percentage. NaN if no grades. */
  readonly maxGradePercent: number;
  /** Steepest downhill grade encountered, percentage. NaN if no grades. */
  readonly minGradePercent: number;
  /** Mean grade across all segments, percentage. NaN if no grades. */
  readonly avgGradePercent: number;
}

/** Inputs to `slopeGradesPerSegment`. */
export interface SlopeGradesInput {
  /** Stations from `stationsAlongLine`. */
  readonly stations: ReadonlyArray<ProfileStation>;
  /**
   * Optional elevation samples from `profileSampler`. When provided,
   * each station's elevation is taken from the nearest sample
   * (linear interpolation between the two bracketing samples). When
   * absent or empty, falls back to the linear Z interpolation between
   * the section endpoints (which equals zero grade everywhere if the
   * endpoints are at the same elevation — honest for a "no cloud
   * data" state).
   */
  readonly samples?: ReadonlyArray<ProfileChartSample>;
}

/**
 * Compute the per-segment slope grades between adjacent stations.
 *
 * For each consecutive pair of stations, returns the run (horizontal
 * distance), rise (vertical difference), grade percentage, and grade
 * angle in degrees. NaN-safe — a station with an unknown elevation
 * (NaN Z, no nearby cloud points) produces a NaN grade for the segment
 * it bookends; consumers should render those as "—" not as 0%.
 */
export function slopeGradesPerSegment(input: SlopeGradesInput): SlopeGrade[] {
  const { stations, samples } = input;
  if (stations.length < 2) return [];
  // Resolve each station's elevation: from cloud samples when
  // available, else from the linear Z baked into the station's
  // position by `stationsAlongLine`.
  const stationZ = stations.map((s) =>
    samples && samples.length > 0
      ? elevationAtChainage(samples, s.chainage)
      : s.position[2],
  );
  const grades: SlopeGrade[] = [];
  for (let i = 0; i < stations.length - 1; i++) {
    const from = stations[i];
    const to = stations[i + 1];
    const run = to.chainage - from.chainage;
    const fromZ = stationZ[i];
    const toZ = stationZ[i + 1];
    const rise = toZ - fromZ;
    let gradePercent = Number.NaN;
    let gradeDegrees = Number.NaN;
    if (run > 0 && Number.isFinite(rise)) {
      gradePercent = (rise / run) * 100;
      gradeDegrees = (Math.atan2(rise, run) * 180) / Math.PI;
    }
    grades.push({ fromIndex: i, toIndex: i + 1, run, rise, gradePercent, gradeDegrees });
  }
  return grades;
}

/** Min / max / average across a slope-grade list. */
export function summariseSlopes(grades: ReadonlyArray<SlopeGrade>): SlopeSummary {
  if (grades.length === 0) {
    return {
      maxGradePercent: Number.NaN,
      minGradePercent: Number.NaN,
      avgGradePercent: Number.NaN,
    };
  }
  let max = Number.NEGATIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (const g of grades) {
    if (!Number.isFinite(g.gradePercent)) continue;
    if (g.gradePercent > max) max = g.gradePercent;
    if (g.gradePercent < min) min = g.gradePercent;
    sum += g.gradePercent;
    count++;
  }
  if (count === 0) {
    return {
      maxGradePercent: Number.NaN,
      minGradePercent: Number.NaN,
      avgGradePercent: Number.NaN,
    };
  }
  return {
    maxGradePercent: max,
    minGradePercent: min,
    avgGradePercent: sum / count,
  };
}

/**
 * Interpolate the elevation at a target chainage from a sorted
 * sample series. Returns NaN when neither of the bracketing samples
 * carries a finite height (the gap is real — no points were near the
 * section line at that chainage).
 */
function elevationAtChainage(
  samples: ReadonlyArray<ProfileChartSample>,
  chainage: number,
): number {
  if (samples.length === 0) return Number.NaN;
  if (chainage <= samples[0].distance) return samples[0].height;
  if (chainage >= samples[samples.length - 1].distance) {
    return samples[samples.length - 1].height;
  }
  // Linear search — samples are typically 32..256 long; binary
  // search would shave µs but adds branch complexity not worth it
  // here. The chart renderer calls this once per station and there
  // are typically <100 stations.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].distance >= chainage) {
      const lo = samples[i - 1];
      const hi = samples[i];
      const span = hi.distance - lo.distance;
      if (span <= 0) return hi.height;
      const t = (chainage - lo.distance) / span;
      // If either bracketing sample is NaN, prefer the other; if
      // both are NaN, the result is NaN — caller renders "—".
      const loFinite = Number.isFinite(lo.height);
      const hiFinite = Number.isFinite(hi.height);
      if (!loFinite && !hiFinite) return Number.NaN;
      if (!loFinite) return hi.height;
      if (!hiFinite) return lo.height;
      return lo.height + t * (hi.height - lo.height);
    }
  }
  return samples[samples.length - 1].height;
}
