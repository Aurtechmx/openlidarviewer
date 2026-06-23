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
}

export interface MeasurementTrustInput {
  /** Support at each endpoint/vertex of the measurement. */
  readonly vertices: readonly VertexSupport[];
  /** True when the cloud has a known CRS with real linear units (≠ local). */
  readonly crsKnown: boolean;
  /** True when only a streaming subset was resident (the full cloud wasn't measured). */
  readonly residentOnly?: boolean;
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

function vertexTier(v: VertexSupport): VertexTier {
  if (v.pointsWithinRadius < SPARSE_FLOOR && !v.snappedToPoint) return 'void';
  if (v.snappedToPoint && v.pointsWithinRadius >= DENSE_SUPPORT) return 'strong';
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
  for (const v of input.vertices) {
    const tier = vertexTier(v);
    if (v.snappedToPoint) snappedCount++;
    if (tier === 'void') anyVoid = true;
    if (tier === 'weak' && worst === 'strong') worst = 'weak';
    if (tier === 'void') worst = 'void';
  }

  let grade: TrustGrade = worst === 'strong' ? 'green' : worst === 'weak' ? 'yellow' : 'red';

  // Endpoint reasoning.
  if (anyVoid) {
    reasons.push('An endpoint sits in empty space — no measured returns nearby. The position is interpolated, not observed.');
  } else if (worst === 'weak') {
    if (snappedCount < input.vertices.length) {
      reasons.push('An endpoint did not snap to a measured return — it was placed in a sparse area.');
    } else {
      reasons.push('Endpoints snapped to real returns, but the neighbourhood is sparse, so the position is loosely constrained.');
    }
  } else {
    reasons.push('Every endpoint snapped to a measured return in a dense neighbourhood.');
  }

  // Scale: a CRS-less cloud's lengths are in source units, not verified metres.
  if (!input.crsKnown) {
    reasons.push('No CRS on this cloud — lengths are in the source file’s units and can’t be certified as metres.');
    if (grade === 'green') grade = 'yellow'; // can’t certify metric → cap at caution
  }

  if (input.residentOnly) {
    reasons.push('Only the loaded subset of a streaming cloud was measured — the full-resolution data may shift this.');
    if (grade === 'green') grade = 'yellow';
  }

  const presentable = !anyVoid;
  const caption = grade === 'green'
    ? 'Verified — well supported by measured points'
    : grade === 'yellow'
      ? 'Caution — loosely supported or unverified scale'
      : 'Unverified — an endpoint has no points to measure';

  return { grade, caption, reasons, presentable };
}

/** A capsule-level roll-up of measurement trust, for the Evidence Capsule. */
export interface EvidenceSummary {
  /** Number of measurements that carry a trust grade. */
  readonly total: number;
  readonly green: number;
  readonly yellow: number;
  readonly red: number;
  /** One-line breakdown, e.g. "5 measurements — 3 verified, 1 caution, 1 unverified". */
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
  if (green) parts.push(`${green} verified`);
  if (yellow) parts.push(`${yellow} caution`);
  if (red) parts.push(`${red} unverified`);
  const line =
    total === 0
      ? 'No graded measurements'
      : `${total} measurement${total === 1 ? '' : 's'} — ${parts.join(', ')}`;
  return { total, green, yellow, red, line };
}
