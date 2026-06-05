/**
 * terrainAssessment.ts
 *
 * The single, plain-language top-level verdict for an analysed scan — the line
 * a non-specialist should read first, above all the detailed metrics (density,
 * coverage, RMSE, NVA/VVA, readiness, quality score). It answers "can I trust
 * this surface, and what is it good for?" by combining the honest signals that
 * already exist on the result into one status, one folded 0–100 score, and a
 * short list of supporting metrics that each carry their own plain rating.
 *
 * Four statuses, never collapsed:
 *   Good     — suitable for terrain products and DEM workflows.
 *   Preview  — suitable for inspection and measurement, not final deliverables.
 *   Limited  — insufficient data quality for reliable terrain products.
 *   Blocked  — the quality gate blocked it, or there is no usable DTM at all.
 *
 * Honesty contract (non-negotiable):
 *   - We NEVER claim "survey-grade", "certified", "guaranteed", or
 *     "professional accuracy" positively. The voice is fitness-for-use: the
 *     tool measures coverage, interpolation and RMSE and applies a gate — it
 *     does not certify a deliverable. A licensed surveyor, a control network,
 *     datum validation and regulatory acceptance are out of scope.
 *   - Unknown CRS or vertical datum REDUCES confidence: such a dataset cannot
 *     read as Good (capped at Preview), and the reason/metrics say so.
 *   - High interpolation, resident-only / sampled coverage, and low ground
 *     visibility / density each cap the status below Good and stay visible in
 *     the supporting metrics.
 *   - Where a value is unknown we show "unknown" with rating 'unknown' — we
 *     never fabricate a figure.
 *
 * Pure-data: derived entirely from the existing quality report, quality score,
 * cell metrics, accuracy standards and coverage — so it never disagrees with
 * the detailed numbers shown beneath it.
 */

import type { AnalyseContoursResult } from './analyseContours';

export type TerrainStatus = 'Good' | 'Preview' | 'Limited' | 'Blocked';

/** A single supporting metric: a plain label, a formatted value, and a colour-only rating. */
export interface SupportingMetric {
  readonly label: string;
  readonly value: string;
  /** Drives colour only — 'unknown' for genuinely missing values (never fabricated). */
  readonly rating: 'good' | 'fair' | 'poor' | 'unknown';
}

export interface TerrainAssessment {
  readonly status: TerrainStatus;
  /** 0..100, folded in from the composite quality score (single source of truth). */
  readonly score: number;
  /** One-line, plain-language reason. */
  readonly reason: string;
  /** What this surface is suitable for. */
  readonly bestFor: string;
  /** What to be careful with, or '' when there is nothing to caution. */
  readonly useCaution: string;
  /** What this surface is honestly not suitable for, given its status. */
  readonly notRecommendedFor: string;
  /** Real values behind the verdict, each with a plain label + rating. */
  readonly supportingMetrics: ReadonlyArray<SupportingMetric>;
}

/** Status ordering for capping (Good is best). */
const RANK: Record<TerrainStatus, number> = { Good: 3, Preview: 2, Limited: 1, Blocked: 0 };

/** Cap a status so it can never exceed `ceiling`. */
function capStatus(status: TerrainStatus, ceiling: TerrainStatus): TerrainStatus {
  return RANK[status] <= RANK[ceiling] ? status : ceiling;
}

const pctStr = (frac: number): string => `${Math.round(frac * 100)}%`;

/** Interpolation fraction above which terrain products are no longer reliable. */
const HIGH_INTERP_FRACTION = 0.4;
/** Empty-cell fraction above which the grid is too gappy to read as Good. */
const HIGH_EMPTY_FRACTION = 0.4;
/** Edge-risk fraction above which too much surface is a long reach from data. */
const HIGH_EDGE_FRACTION = 0.15;
/** Ground returns / m² below which ground visibility is too thin to trust fully. */
const LOW_DENSITY_PER_M2 = 1.0;
/** Ground-return ratio below which the classifier saw too little bare earth. */
const LOW_GROUND_RATIO = 0.1;

function describeCoverage(mode: string): { value: string; rating: SupportingMetric['rating'] } {
  if (mode === 'full') return { value: 'full', rating: 'good' };
  if (mode === 'resident-only') return { value: 'resident-only', rating: 'fair' };
  if (mode === 'sampled') return { value: 'sampled', rating: 'fair' };
  return { value: 'unknown', rating: 'unknown' };
}

/**
 * Collapse an analysis result into a single top-level assessment.
 *
 * Status is derived in two passes: first the gate's readiness gives a baseline
 * (ready→Good, previewOnly→Preview, blocked→Blocked), then a set of caps from
 * CRS, vertical datum, interpolation, coverage mode and ground visibility pull
 * it down so no single weakness can read as Good. A surface with no usable DTM
 * is Blocked outright.
 */
export function terrainAssessment(result: AnalyseContoursResult): TerrainAssessment {
  const q = result.quality;
  const qs = result.qualityScore;
  const cm = result.cellMetrics;
  const acc = result.accuracyStandards;
  const tally = result.cellStatusTally;
  const crs = result.dtm.crs;
  const datum = result.dtm.verticalDatum;
  const coverageMode = result.dtm.coverageMode;

  const score = qs && Number.isFinite(qs.score) ? qs.score : 0;

  // ── derived fractions ─────────────────────────────────────────────────
  const coveredCells =
    tally.measured + tally.interpolated + tally.lowConfidence + tally.edgeRisk;
  const interpFrac =
    coveredCells > 0 ? 1 - tally.measured / coveredCells : 1;
  const gridTotal = tally.total > 0 ? tally.total : 1;
  const emptyFrac = tally.empty / gridTotal;
  const edgeFrac = Number.isFinite(cm?.edgeRiskRatio) ? cm.edgeRiskRatio : 0;
  const density = Number.isFinite(cm?.meanDensity) ? cm.meanDensity : 0;
  const groundRatio = Number.isFinite(q.groundPointRatio) ? q.groundPointRatio : NaN;
  const crsKnown = crs != null;
  const datumKnown = datum != null;
  const rmse = acc?.rmseZM;
  const rmseKnown = rmse != null && Number.isFinite(rmse);
  const noUsableDtm = coveredCells === 0;

  // ── baseline status from the gate ─────────────────────────────────────
  let status: TerrainStatus;
  if (q.readiness === 'blocked' || noUsableDtm) status = 'Blocked';
  else if (q.readiness === 'previewOnly') status = 'Preview';
  else status = 'Good';

  // ── caps (each weakness pulls the ceiling down; never below the gate) ──
  if (!crsKnown || !datumKnown) status = capStatus(status, 'Preview');
  if (interpFrac > HIGH_INTERP_FRACTION) status = capStatus(status, 'Preview');
  if (emptyFrac > HIGH_EMPTY_FRACTION) status = capStatus(status, 'Preview');
  if (edgeFrac > HIGH_EDGE_FRACTION) status = capStatus(status, 'Preview');
  if (coverageMode !== 'full') status = capStatus(status, 'Preview');
  if (density < LOW_DENSITY_PER_M2) status = capStatus(status, 'Preview');
  if (Number.isFinite(groundRatio) && groundRatio < LOW_GROUND_RATIO) {
    status = capStatus(status, 'Preview');
  }

  // ── supporting metrics (real values, each with a plain rating) ────────
  const cov = describeCoverage(coverageMode);
  const supportingMetrics: SupportingMetric[] = [
    { label: 'Coverage', value: cov.value, rating: cov.rating },
    {
      label: 'Ground density',
      value: density > 0 ? `${density.toFixed(1)} pts/m²` : 'unknown',
      rating:
        density <= 0
          ? 'unknown'
          : density >= 2
            ? 'good'
            : density >= LOW_DENSITY_PER_M2
              ? 'fair'
              : 'poor',
    },
    {
      label: 'DTM quality',
      value: `${score}/100`,
      rating: score >= 70 ? 'good' : score >= 45 ? 'fair' : 'poor',
    },
    {
      label: 'Interpolation',
      value: coveredCells > 0 ? pctStr(interpFrac) : 'unknown',
      rating:
        coveredCells === 0
          ? 'unknown'
          : interpFrac <= 0.2
            ? 'good'
            : interpFrac <= HIGH_INTERP_FRACTION
              ? 'fair'
              : 'poor',
    },
    {
      label: 'Empty cells',
      value: pctStr(emptyFrac),
      rating: emptyFrac <= 0.2 ? 'good' : emptyFrac <= HIGH_EMPTY_FRACTION ? 'fair' : 'poor',
    },
    {
      label: 'Edge risk',
      value: pctStr(edgeFrac),
      rating: edgeFrac <= 0.05 ? 'good' : edgeFrac <= HIGH_EDGE_FRACTION ? 'fair' : 'poor',
    },
    {
      label: 'Vertical RMSE',
      value: rmseKnown ? `${(rmse as number).toFixed(2)} m` : 'unknown',
      rating: !rmseKnown
        ? 'unknown'
        : (rmse as number) <= 0.1
          ? 'good'
          : (rmse as number) <= 0.25
            ? 'fair'
            : 'poor',
    },
    {
      label: 'CRS',
      value: crsKnown ? (crs as string) : 'unknown',
      rating: crsKnown ? 'good' : 'unknown',
    },
    {
      label: 'Vertical datum',
      value: datumKnown ? (datum as string) : 'unknown',
      rating: datumKnown ? 'good' : 'unknown',
    },
  ];

  // ── reason (one plain line) ───────────────────────────────────────────
  const gateReason = q.reasons?.find((r) => r && r.trim().length > 0);
  let reason: string;
  if (status === 'Blocked') {
    reason = noUsableDtm
      ? 'No usable bare-earth surface — too little measured ground to contour.'
      : (gateReason ?? 'The quality gate blocked this surface for terrain products.');
  } else if (status === 'Good') {
    reason = `${pctStr(1 - interpFrac)} measured ground, georeferenced — passes the quality gate.`;
  } else {
    // Preview / Limited: prefer the gate's own words, else name the strongest cap.
    const caps: string[] = [];
    if (!crsKnown) caps.push('the coordinate system is unknown');
    if (!datumKnown) caps.push('the vertical datum is unknown');
    if (coverageMode === 'resident-only') caps.push('only resident streaming nodes were walked');
    else if (coverageMode === 'sampled') caps.push('the cloud was sampled, not fully walked');
    if (interpFrac > HIGH_INTERP_FRACTION) caps.push(`${pctStr(interpFrac)} of the surface is interpolated`);
    if (density < LOW_DENSITY_PER_M2) caps.push('ground returns are sparse');
    reason = gateReason ?? (caps.length > 0 ? capitalise(joinReasons(caps)) + '.' : 'Usable for inspection, not for final terrain products.');
  }

  // ── bestFor / useCaution / notRecommendedFor ──────────────────────────
  const bestFor =
    status === 'Good'
      ? 'terrain products, DEM export, measurement and inspection'
      : status === 'Preview'
        ? 'profile review, measurement and terrain inspection'
        : status === 'Limited'
          ? 'visual inspection only'
          : 'reviewing the point cloud; this scan has no usable terrain surface';

  const useCaution =
    status === 'Good'
      ? ''
      : status === 'Preview'
        ? 'terrain products are preliminary — validate independently before relying on them'
        : status === 'Limited'
          ? 'the surface is too incomplete for reliable terrain products'
          : 'do not build terrain products from this scan';

  const notRecommendedFor =
    status === 'Good'
      ? 'uses that legally require certified survey data'
      : status === 'Preview'
        ? 'final deliverables without independent validation'
        : 'terrain products, DEM export, contour generation';

  return { status, score, reason, bestFor, useCaution, notRecommendedFor, supportingMetrics };
}

/** Join reason fragments into one sentence: "a, b and c". */
function joinReasons(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
