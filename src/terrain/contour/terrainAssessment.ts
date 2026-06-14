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
 * TWO INDEPENDENT AXES (deliberately separated):
 *   - SURFACE QUALITY (`status`) — is the terrain surface internally valid?
 *     Derived from surface metrics only (coverage, interpolation, edge risk,
 *     density, ground visibility, RMSE). It is INDEPENDENT of CRS / vertical
 *     datum: a dense, clean, well-covered scan with an unknown datum can still
 *     read as Good.
 *   - EXPORT READINESS (`exportReadiness`) — is it georeferenced enough to hand
 *     off? = the surface verdict, further gated by a known CRS + vertical datum.
 *     An unknown CRS or datum caps export to Preview (with `exportReason`), even
 *     when surface quality is Good.
 *
 * Four surface statuses, never collapsed:
 *   Good     — surface is internally valid; suitable for terrain workflows.
 *   Preview  — suitable for inspection and measurement; additional validation
 *              recommended before deliverable use.
 *   Limited  — insufficient data quality for reliable terrain products.
 *   Blocked  — the quality gate blocked it, or there is no usable DTM at all.
 *
 * Three export-readiness verdicts (derived by quality/readinessEngine — the
 * single source of the verdict — and copied here verbatim):
 *   Ready    — surface is Good AND CRS + vertical datum are known.
 *   Preview  — surface is below Good, OR the surface is Good but CRS / datum is
 *              unknown (the reason names which).
 *   Blocked  — the surface is Blocked.
 *
 * Honesty contract (non-negotiable):
 *   - We NEVER claim "survey-grade", "certified", "guaranteed", or
 *     "professional accuracy" positively. The voice is fitness-for-use: the
 *     tool measures coverage, interpolation and RMSE and applies a gate — it
 *     does not certify a deliverable. A licensed surveyor, a control network,
 *     datum validation and regulatory acceptance are out of scope.
 *   - Unknown CRS or vertical datum does NOT reduce surface quality, but it
 *     DOES cap EXPORT READINESS to Preview (with a reason) — a georeferenced
 *     hand-off needs a known frame + datum. Nothing claims survey-grade.
 *   - High interpolation, resident-only / sampled coverage, and low ground
 *     visibility / density each cap the surface status below Good and stay
 *     visible in the supporting metrics.
 *   - Where a value is unknown we show "unknown" with rating 'unknown' — we
 *     never fabricate a figure.
 *
 * Pure-data: derived entirely from the existing quality report, quality score,
 * cell metrics, accuracy standards and coverage — so it never disagrees with
 * the detailed numbers shown beneath it.
 */

import type { AnalyseContoursResult } from './analyseContours';
import {
  deriveReadiness,
  joinReasons,
  type SurfaceTier,
  type ReadinessTier,
} from '../quality/readinessEngine';

/**
 * Surface-quality tier. The vocabulary lives in the readiness engine (the
 * single source of the verdict grammar); this alias keeps the historical
 * name every consumer imports.
 */
export type TerrainStatus = SurfaceTier;

/** Export-readiness verdict — the surface verdict gated by georeferencing. */
export type ExportReadinessStatus = ReadinessTier;

/** A single supporting metric: a plain label, a formatted value, and a colour-only rating. */
export interface SupportingMetric {
  readonly label: string;
  readonly value: string;
  /** Drives colour only — 'unknown' for genuinely missing values (never fabricated). */
  readonly rating: 'good' | 'fair' | 'poor' | 'unknown';
}

export interface TerrainAssessment {
  /** SURFACE QUALITY — internal validity of the surface (CRS/datum-independent). */
  readonly status: TerrainStatus;
  /**
   * EXPORT READINESS — the surface verdict gated by a known CRS + vertical
   * datum. Ready only when the surface is Good AND both are known; otherwise
   * Preview (with `exportReason`), or Blocked when the surface is Blocked.
   */
  readonly exportReadiness: ExportReadinessStatus;
  /**
   * Why export readiness sits below "Ready" — names the georeferencing gap
   * (e.g. "vertical datum unknown") or the surface limitation. '' when Ready.
   */
  readonly exportReason: string;
  /** 0..100, folded in from the composite quality score (single source of truth). */
  readonly score: number;
  /**
   * Whether `score` is a real, assessed figure. When false the composite score
   * was absent/non-finite and `score` is a 0 placeholder for the type only —
   * consumers must render it as "unknown", never as "0/100" (no fabrication).
   */
  readonly scoreKnown: boolean;
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

// ── 'Limited' tier thresholds ───────────────────────────────────────────
// 'Limited' is the "weak but not gate-blocked" tier: a surface the gate let
// through (ready / previewOnly) that is nonetheless too deficient for reliable
// terrain products. It only ever LOWERS an already Preview-capped status — it
// can never raise Blocked and an all-green surface can never reach it.
/** Composite score below which the surface is too weak to read above Limited. */
const LIMITED_SCORE_FLOOR = 40;
/** Count of 'poor'-rated supporting metrics at/above which the surface is Limited. */
const LIMITED_POOR_METRIC_COUNT = 2;
/** Interpolation/empty-cell fraction above which the grid is severely deficient. */
const SEVERE_GAP_FRACTION = 0.6;

function describeCoverage(mode: string): { value: string; rating: SupportingMetric['rating'] } {
  if (mode === 'full') return { value: 'full', rating: 'good' };
  if (mode === 'resident-only') return { value: 'resident-only', rating: 'fair' };
  if (mode === 'sampled') return { value: 'sampled', rating: 'fair' };
  return { value: 'unknown', rating: 'unknown' };
}

/**
 * Collapse an analysis result into a single top-level assessment with TWO axes.
 *
 * SURFACE QUALITY (`status`) is derived in two passes: first the gate's surface
 * readiness gives a baseline (ready→Good, previewOnly→Preview, blocked→Blocked),
 * then a set of SURFACE caps from interpolation, coverage mode, edge risk and
 * ground visibility pull it down so no single weakness can read as Good. CRS /
 * vertical datum do NOT enter this axis. A surface with no usable DTM is Blocked.
 *
 * EXPORT READINESS (`exportReadiness`) then takes the surface verdict and gates
 * it on georeferencing: Blocked surface → Blocked; otherwise Ready only when the
 * surface is Good AND CRS + vertical datum are known, else Preview (with a reason
 * naming the gap). Export availability downstream keys off THIS axis.
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

  // The composite score is the single source of truth, but it can be genuinely
  // absent. When missing we keep a numeric `score` of 0 for the type, but track
  // its absence so the supporting metric can read "unknown" (never "0/100") and
  // status gating below can ignore it (gating is readiness-driven, not score-
  // driven). Honesty rule: a missing figure is never fabricated as a real one.
  const scoreKnown = qs != null && Number.isFinite(qs.score);
  const score = scoreKnown ? qs.score : 0;

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

  // ── SURFACE caps (each weakness pulls the ceiling down; never below gate) ──
  // CRS / vertical datum deliberately do NOT cap surface quality — they belong
  // to export readiness, computed separately below.
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
      value: scoreKnown ? `${score}/100` : 'unknown',
      rating: !scoreKnown ? 'unknown' : score >= 70 ? 'good' : score >= 45 ? 'fair' : 'poor',
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
      // cellMetrics.edgeRiskRatio — measured cells near the data boundary
      // (least neighbour support). DISTINCT from the gate's 'edgeRisk' cell
      // status (interpolated cells far from any measurement); the reason
      // sentence below words each truthfully.
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

  // ── 'Limited' cap (weak but not blocked) ──────────────────────────────
  // Applied after the Preview caps and computed from the real metrics above,
  // this further lowers an already preview-capped surface to 'Limited' when it
  // is seriously deficient. It only ever LOWERS (capStatus): Blocked stays
  // Blocked, and a surface that is still 'Good' here was all-green so it can
  // never be pulled down. A surface is Limited when ANY of:
  //   - the composite score is known and below LIMITED_SCORE_FLOOR, OR
  //   - LIMITED_POOR_METRIC_COUNT or more supporting metrics are rated 'poor', OR
  //   - interpolation or empty-cell fraction is above SEVERE_GAP_FRACTION.
  const poorMetricCount = supportingMetrics.filter((m) => m.rating === 'poor').length;
  const seriouslyDeficient =
    (scoreKnown && score < LIMITED_SCORE_FLOOR) ||
    poorMetricCount >= LIMITED_POOR_METRIC_COUNT ||
    interpFrac > SEVERE_GAP_FRACTION ||
    emptyFrac > SEVERE_GAP_FRACTION;
  // A 'resident-only' analysis is a PARTIAL stream — only the streamed-in octree
  // nodes were walked, typically a coarse overview far sparser than the full
  // cloud. Its interpolation / edge / density figures reflect how little has
  // loaded, not a final judgment of the scan, so a streaming scan that is
  // actually fine reads as 'Limited' with alarming "100% at the edge" reasons.
  // Don't render that definitive downgrade on incomplete data: hold the verdict
  // at the gate's 'Preview' (preliminary) and let a re-run on the fully-streamed
  // cloud (coverageMode 'full') give the real grade. A genuinely unusable
  // surface is still caught by the gate's Blocked path above, which is not
  // gated here.
  const partialStream = coverageMode === 'resident-only';
  if (seriouslyDeficient && !partialStream) status = capStatus(status, 'Limited');

  // ── reason (one plain line) ───────────────────────────────────────────
  const gateReason = q.reasons?.find((r) => r && r.trim().length > 0);
  let reason: string;
  if (status === 'Blocked') {
    reason = noUsableDtm
      ? 'No usable bare-earth surface — too little measured ground to contour.'
      : (gateReason ?? 'The quality gate blocked this surface for terrain products.');
  } else if (status === 'Good') {
    reason = `${pctStr(1 - interpFrac)} measured ground — the surface passes the quality gate.`;
  } else {
    // Preview / Limited: surface reason only (CRS/datum live on export, below).
    const caps: string[] = [];
    if (coverageMode === 'resident-only') caps.push('only resident streaming nodes were walked');
    else if (coverageMode === 'sampled') caps.push('the cloud was sampled, not fully walked');
    if (interpFrac > HIGH_INTERP_FRACTION) caps.push(`${pctStr(interpFrac)} of the surface is interpolated`);
    if (emptyFrac > HIGH_EMPTY_FRACTION) caps.push(`${pctStr(emptyFrac)} of the grid has no data`);
    // `edgeFrac` is cellMetrics.edgeRiskRatio: the fraction of MEASURED cells
    // that sit within a couple of cells of the data boundary. Those cells HAVE
    // real returns — they are just least supported by neighbours. The old
    // wording here ("a long interpolation from real returns") described the
    // OTHER edge metric (the gate's tally of interpolated cells far from any
    // measurement, dtmCellStatus 'edgeRisk') and was untrue for this one.
    if (edgeFrac > HIGH_EDGE_FRACTION) caps.push(`${pctStr(edgeFrac)} of measured cells sit at the edge of the data, where the surface is least supported`);
    if (density < LOW_DENSITY_PER_M2) caps.push('ground returns are sparse');
    if (coverageMode === 'resident-only') {
      // PARTIAL STREAM: lead with the honest "only part has loaded" framing, not
      // the sparse interpolation / edge figures (which are streaming artefacts
      // that firm up as more nodes arrive). The full breakdown still lives in
      // the supporting metrics + the "Why?" details for anyone who wants it.
      reason =
        'Preliminary — only the streamed-in part of the scan has been analysed so far. Let the full cloud stream in, then re-run for a final assessment.';
    } else if (status === 'Limited') {
      // The surface was downgraded BELOW the gate's preview tier, so do NOT
      // reuse the gate's "Preview only: …" wording — it would contradict the
      // Limited headline. State the Limited framing from the strongest caps.
      reason =
        caps.length > 0
          ? `Insufficient quality for reliable terrain products — ${joinReasons(caps)}.`
          : 'Insufficient data quality for reliable terrain products.';
    } else {
      // Preview: the gate's own "Preview only: …" wording matches this tier.
      reason = gateReason ?? (caps.length > 0 ? capitalise(joinReasons(caps)) + '.' : 'Usable for inspection, not for final terrain products.');
    }
  }

  // ── EXPORT READINESS (surface verdict gated by georeferencing) ────────
  // Derived by THE readiness engine — the single source of the verdict — and
  // copied onto the assessment verbatim. The tier/reason rules (Blocked
  // surface ⇒ Blocked; Ready only when Good + CRS + datum; otherwise Preview
  // with a reason naming the gap) live in deriveReadiness, nowhere else.
  const verdict = deriveReadiness({
    surfaceTier: status,
    surfaceReason: reason,
    crsKnown,
    datumKnown,
  });
  const exportReadiness: ExportReadinessStatus = verdict.tier;
  const exportReason: string = verdict.reason;

  // ── bestFor / useCaution / notRecommendedFor (surface inspection verdict) ──
  // bestFor speaks to what the SURFACE supports. For a Good surface we only
  // advertise georeferenced DEM export when export readiness actually allows it
  // (known CRS + datum); otherwise we point at measurement/inspection and the
  // export recommendation is carried separately by exportReason.
  const bestFor =
    status === 'Good'
      ? exportReadiness === 'Ready'
        ? 'terrain products, DEM export, measurement and inspection'
        : 'measurement, inspection and terrain analysis'
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

  return {
    status,
    exportReadiness,
    exportReason,
    score,
    scoreKnown,
    reason,
    bestFor,
    useCaution,
    notRecommendedFor,
    supportingMetrics,
  };
}

function capitalise(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}
