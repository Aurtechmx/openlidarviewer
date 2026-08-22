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
import {
  buildProfileFrame,
  positionAtProfileChainage,
  DEFAULT_PROFILE_UP,
  DEGENERATE_HORIZONTAL_LENGTH,
} from './profileGeometry';

/** One station along the section line. */
export interface ProfileStation {
  /**
   * Cumulative distance from the start of the section, in metres, measured in
   * the plane perpendicular to the scene `up` axis. Same convention and same
   * frame as `profileSampler`'s `distance` field.
   */
  readonly chainage: number;
  /**
   * The 3D world-space position at this chainage: `a + t * (b - a)` for
   * `t = chainage / horizontalLength`. The marker sits on the straight line
   * between the picked endpoints, not on the cloud surface. A future overlay
   * can drop a sphere here and project it onto the cloud if needed.
   */
  readonly position: Vec3;
  /**
   * Height at this station, measured along the scene `up` axis. Present on
   * every station `stationsAlongLine` emits. Optional so hand-built station
   * records stay valid; `slopeGradesPerSegment` falls back to `position[2]`
   * when it is absent, which is only correct for a Z-up scene.
   */
  readonly height?: number;
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
  /**
   * Scene up axis. Chainage is measured in the plane perpendicular to it and
   * height along it, matching `sampleProfile`. Defaults to `[0, 0, 1]`.
   */
  readonly up?: Vec3;
}

/**
 * Emit station markers along the section line at the given interval.
 *
 * Returns a non-empty list when the section has plan extent. Returns an empty
 * list when the section is degenerate (the endpoints coincide in the plane
 * perpendicular to `up`, so the horizontal length is below
 * `DEGENERATE_HORIZONTAL_LENGTH`). The consumer should suppress the station
 * overlay entirely in that case.
 *
 * NaN-safe: returns `[]` when any input coordinate is non-finite or
 * the interval is non-positive.
 */
export function stationsAlongLine(input: StationsAlongLineInput): ProfileStation[] {
  const { a, b, intervalM } = input;
  const up = input.up ?? DEFAULT_PROFILE_UP;
  if (!Number.isFinite(intervalM) || intervalM <= 0) return [];
  for (const v of [a[0], a[1], a[2], b[0], b[1], b[2], up[0], up[1], up[2]]) {
    if (!Number.isFinite(v)) return [];
  }
  // Horizontal length only: survey chainage is measured in the plane
  // perpendicular to `up`, not along the 3D vector. The frame is the one
  // `sampleProfile` walks, so the chainages here index the same x-axis.
  const frame = buildProfileFrame(a, b, up);
  const horizontalLen = frame.horizontalLength;
  // Same degeneracy call `sampleProfile` makes, so a section the sampler
  // refuses to walk carries no stations either.
  if (!(horizontalLen >= DEGENERATE_HORIZONTAL_LENGTH)) return [];

  const aHeight = a[0] * frame.up[0] + a[1] * frame.up[1] + a[2] * frame.up[2];
  const stations: ProfileStation[] = [];
  // Walk by interval. Use a tiny epsilon to avoid emitting a station
  // at-or-just-past the endpoint due to float drift.
  const eps = horizontalLen * 1e-9;

  // First station: chainage 0 (the start).
  stations.push({
    chainage: 0,
    position: [a[0], a[1], a[2]],
    height: aHeight,
    isEndpoint: false,
  });
  let chainage = intervalM;
  while (chainage < horizontalLen - eps) {
    stations.push({
      chainage,
      position: positionAtProfileChainage(frame, chainage),
      height: aHeight + (chainage / horizontalLen) * frame.verticalDelta,
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
    height: b[0] * frame.up[0] + b[1] * frame.up[1] + b[2] * frame.up[2],
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
   * Optional elevation samples from `profileSampler`. When provided, each
   * station's elevation comes from linear interpolation between the two
   * bracketing samples, and is NaN where either bracket is a coverage gap.
   * When absent or empty, falls back to the station's own up-axis height,
   * linearly interpolated between the section endpoints (zero grade
   * everywhere if the endpoints share an elevation, honest for a "no cloud
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
  // Resolve each station's elevation: from cloud samples when available, else
  // from the up-axis height `stationsAlongLine` recorded. `position[2]` is the
  // fallback for hand-built station records that carry no `height`.
  const stationZ = stations.map((s) =>
    samples && samples.length > 0
      ? elevationAtChainage(samples, s.chainage)
      : (s.height ?? s.position[2]),
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
 * Interpolate the elevation at a target chainage from a sorted sample series.
 *
 * Gap rule, the same one `profileSummary` and `civilProfileStats` apply: a
 * chainage that lands exactly on a sample takes that sample's height, gap or
 * not; a chainage strictly between two samples interpolates only when BOTH
 * brackets are finite, and returns NaN otherwise. A single finite bracket is
 * never spread across the gap beside it, so a station inside a no-coverage
 * span reads as unknown rather than as a measured elevation.
 */
function elevationAtChainage(
  samples: ReadonlyArray<ProfileChartSample>,
  chainage: number,
): number {
  const last = samples.at(-1);
  if (last === undefined) return Number.NaN;
  if (chainage <= samples[0].distance) return samples[0].height;
  if (chainage >= last.distance) {
    return last.height;
  }
  // Linear search — samples are typically 32..256 long; binary
  // search would shave µs but adds branch complexity not worth it
  // here. The chart renderer calls this once per station and there
  // are typically <100 stations.
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].distance >= chainage) {
      const lo = samples[i - 1];
      const hi = samples[i];
      // Exact hit on the upper bracket: that sample IS the station's reading.
      if (chainage === hi.distance) return hi.height;
      const span = hi.distance - lo.distance;
      if (span <= 0) return hi.height;
      if (!Number.isFinite(lo.height) || !Number.isFinite(hi.height)) return Number.NaN;
      const t = (chainage - lo.distance) / span;
      return lo.height + t * (hi.height - lo.height);
    }
  }
  return last.height;
}
