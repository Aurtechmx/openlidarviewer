/**
 * measurementTrust.ts
 *
 * The per-measurement honesty grade — the brand made tangible. Every web tool
 * hands you a bare number; this attaches a red/yellow/green trust signal to
 * each measurement, computed from REAL signals, plus the reasons behind it
 * ("show me why") and a refusal gate that declines to present a confident
 * number the data can't support.
 *
 * The honest truth about a LiDAR measurement is: a length is only as good as
 * the points under its endpoints. An endpoint snapped to a real return in a
 * dense neighbourhood is trustworthy; one floating in a void is a guess the
 * software shouldn't dress up as a survey figure. We grade on three real
 * signals — did each endpoint land on a measured return, how many returns
 * surround it, and whether the scale is even known (a CRS-less cloud's "metres"
 * are unverified) — and report the worst endpoint, because a measurement is
 * only as trustworthy as its weakest support.
 *
 * Pure data in, pure data out: no DOM, no Viewer, no snap index — the caller
 * gathers the signals, this turns them into a grade. Unit-testable, and the
 * policy can't drift from the UI.
 */

import {
  GEOGRAPHIC_CRS_MEASURE_NOTICE,
} from './format';
import { VERTICAL_NOT_AVAILABLE, geographicRefusesKind } from './types';

// The kind rule lives with the kind union; re-exported for the live grade's callers.
export { geographicRefusesKind };

export type TrustGrade = 'green' | 'yellow' | 'red';

/** Per-endpoint support signals, gathered by the caller from the snap index. */
export interface VertexSupport {
  /** Did this endpoint snap to a real measured return (vs float in space)? */
  readonly snappedToPoint: boolean;
  /**
   * Measured returns within the trust radius of the endpoint. The radius is the
   * caller's choice (a few nominal point spacings); this only compares counts.
   */
  readonly pointsWithinRadius: number;
  /**
   * The endpoint snapped only to a voxel centroid of a reduced display sample
   * (`ProjectSnapIndex.support`). A centroid is not a return, so such an
   * endpoint is at best loosely supported. Absent reads as false.
   */
  readonly onReducedSample?: boolean;
}

export interface MeasurementTrustInput {
  /** Support at each endpoint/vertex of the measurement. */
  readonly vertices: readonly VertexSupport[];
  /** True when the cloud has a known CRS with real linear units (≠ local). */
  readonly crsKnown: boolean;
  /** True when only a streaming subset was resident (the full cloud wasn't measured). */
  readonly residentOnly?: boolean;
  /**
   * True when this measurement's NUMBER is built from geographic (degree)
   * X/Y coordinates — lengths/areas/grades/profiles/volumes on a geographic
   * CRS. Degrees are not a linear unit and Z is, so the figure mixes units
   * and no scalar factor can repair it; that is a REFUSAL condition (grade
   * red, not presentable), stronger than the yellow "unverified scale" of a
   * missing CRS, because the number is not merely uncertified — it is wrong
   * as a distance. The caller scopes this to the affected measurement kinds
   * (a pure-vertical height, for example, is honest metres and is not
   * flagged).
   */
  readonly geographicCrs?: boolean;
  /**
   * True when this measurement's number reads Z as a local elevation on a
   * frame that has none (geocentric, depth-positive-down). A refusal like
   * {@link geographicCrs}; the caller scopes it with `frameRefusalText`.
   */
  readonly verticalRefused?: boolean;
  /**
   * True when the frame is geographic, whatever the kind. Its scale signal is
   * then the vertical unit (the only linear unit a permitted figure, a
   * height, uses), not {@link crsKnown}: a geographic CRS has no linear
   * horizontal unit, yet it is a CRS.
   */
  readonly frameGeographic?: boolean;
  /** The file declares a valid vertical unit. Read with {@link frameGeographic}. */
  readonly verticalUnitKnown?: boolean;
}

export interface MeasurementTrust {
  readonly grade: TrustGrade;
  /** A one-line caption for the badge. */
  readonly caption: string;
  /** The "show me why" detail — every signal that shaped the grade. */
  readonly reasons: readonly string[];
  /**
   * False when the data can't support a confident figure (an endpoint in a
   * void). The UI should present the number as unverified — or decline to —
   * rather than as a survey measurement.
   */
  readonly presentable: boolean;
}

/**
 * Points-within-radius above which an endpoint is "well supported". Below the
 * sparse floor an endpoint is effectively unsupported (a guess in a void).
 */
const DENSE_SUPPORT = 24;
const SPARSE_FLOOR = 4;

type VertexTier = 'strong' | 'weak' | 'void';

/** The reason an endpoint on a voxel centroid gives, in place of "measured return". */
export const VOXEL_CENTROID_REASON =
  'An endpoint snapped to a voxel centroid of the display sample, not a return. The scan was reduced for display.';

function vertexTier(v: VertexSupport): VertexTier {
  if (v.pointsWithinRadius < SPARSE_FLOOR && !v.snappedToPoint) return 'void';
  if (v.snappedToPoint && v.pointsWithinRadius >= DENSE_SUPPORT && v.onReducedSample !== true) return 'strong';
  return 'weak';
}

/** Grade a measurement from its endpoint support and cloud-level caveats. */
export function gradeMeasurement(input: MeasurementTrustInput): MeasurementTrust {
  const reasons: string[] = [];

  if (input.vertices.length === 0) {
    return {
      grade: 'red',
      caption: 'Not measurable',
      reasons: ['No endpoints to measure.'],
      presentable: false,
    };
  }

  // Worst endpoint drives the grade — a measurement is only as good as its
  // weakest support.
  let worst: VertexTier = 'strong';
  let anyVoid = false;
  let snappedCount = 0;
  let onCentroid = false;
  for (const v of input.vertices) {
    const tier = vertexTier(v);
    if (v.snappedToPoint) snappedCount++;
    if (v.snappedToPoint && v.onReducedSample === true) onCentroid = true;
    if (tier === 'void') anyVoid = true;
    if (tier === 'weak' && worst === 'strong') worst = 'weak';
    if (tier === 'void') worst = 'void';
  }

  let grade: TrustGrade;
  if (worst === 'strong') grade = 'green';
  else if (worst === 'weak') grade = 'yellow';
  else grade = 'red';

  // Endpoint reasoning.
  if (anyVoid) {
    reasons.push('An endpoint sits in empty space — no measured returns nearby. The position is interpolated, not observed.');
  } else if (worst === 'weak') {
    if (onCentroid) {
      reasons.push(VOXEL_CENTROID_REASON);
    } else if (snappedCount < input.vertices.length) {
      reasons.push('An endpoint did not land on a measured return.');
    } else {
      reasons.push('Endpoints landed on measured returns, but the surrounding data is sparse, so the position is loosely constrained.');
    }
  } else {
    reasons.push('Every endpoint snapped to a measured return in a dense neighbourhood.');
  }

  // Geographic (degree) frame: the figure mixes degree X/Y with a linear Z,
  // so it is WRONG as a distance, not merely uncertified — a refusal, not a
  // caution. Shares the hint/panel copy so the wording cannot fork.
  const verticalRefusal = input.verticalRefused === true;
  const geographicRefusal = input.geographicCrs === true && !verticalRefusal;

  // Scale: a CRS-less cloud's lengths are in source units, not verified metres.
  // A geographic frame has a CRS but no linear horizontal unit; the figure it
  // permits (a height) is certified by a declared vertical unit alone.
  if (input.frameGeographic === true) {
    if (!geographicRefusal && !verticalRefusal && input.verticalUnitKnown !== true) {
      reasons.push('Geographic CRS with no declared vertical unit. Heights are in the source file’s units, not verified metres.');
      if (grade === 'green') grade = 'yellow';
    }
  } else if (!input.crsKnown) {
    reasons.push('No CRS on this cloud. Lengths are in the source file’s units, not verified metres.');
    if (grade === 'green') grade = 'yellow'; // can’t certify metric → cap at caution
  }
  if (geographicRefusal) {
    reasons.push(GEOGRAPHIC_CRS_MEASURE_NOTICE);
    grade = 'red';
  }
  if (verticalRefusal) {
    reasons.push(`Height ${VERTICAL_NOT_AVAILABLE}.`);
    grade = 'red';
  }

  if (input.residentOnly) {
    reasons.push('Only the loaded subset of a streaming cloud was measured — the full-resolution data may shift this.');
    if (grade === 'green') grade = 'yellow';
  }

  const presentable = !anyVoid && !geographicRefusal && !verticalRefusal;
  let caption: string;
  if (verticalRefusal) caption = 'Unverified — this frame has no local vertical (geocentric or depth-down)';
  else if (geographicRefusal) caption = 'Unverified — degrees are not distances (geographic CRS)';
  else if (grade === 'green') caption = 'Supported — close to measured points';
  else if (grade === 'yellow' && onCentroid) caption = 'Caution: snapped to the reduced display sample, not returns';
  else if (grade === 'yellow') caption = 'Caution — loosely supported or unverified scale';
  else caption = 'Unverified — an endpoint has no points to measure';

  return { grade, caption, reasons, presentable };
}

/** A capsule-level roll-up of measurement trust, for the Evidence Capsule. */
export interface EvidenceSummary {
  /** Number of measurements that carry a trust grade. */
  readonly total: number;
  readonly green: number;
  readonly yellow: number;
  readonly red: number;
  /** One-line breakdown, e.g. "5 measurements — 3 supported, 1 caution, 1 unverified". */
  readonly line: string;
}

/**
 * Roll up the per-measurement grades into one honest evidence headline — what
 * an Evidence Capsule announces when it opens, so the recipient sees the trust
 * picture at a glance, not just a pile of numbers.
 */
export function summarizeMeasurementTrust(
  trusts: readonly (MeasurementTrust | undefined)[],
): EvidenceSummary {
  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const t of trusts) {
    if (!t) continue;
    if (t.grade === 'green') green++;
    else if (t.grade === 'yellow') yellow++;
    else red++;
  }
  const total = green + yellow + red;
  const parts: string[] = [];
  if (green) parts.push(`${green} supported`);
  if (yellow) parts.push(`${yellow} caution`);
  if (red) parts.push(`${red} unverified`);
  let line: string;
  if (total === 0) {
    line = 'No graded measurements';
  } else {
    const plural = total === 1 ? '' : 's';
    line = `${total} measurement${plural} — ${parts.join(', ')}`;
  }
  return { total, green, yellow, red, line };
}
