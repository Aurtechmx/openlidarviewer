/**
 * dtmQualityGate.ts
 *
 * Pure-data leaf — the gate that decides, BEFORE contour generation and
 * export, whether a DTM is good enough to (a) draw at all, (b) preview
 * for exploration, or (c) is ready for terrain-product generation under
 * the current quality gate.
 *
 * It exists so the UI never offers a survey-looking export over a surface
 * that is mostly guessed, ungeoreferenced, or unvalidated. Every
 * `blocked` or `previewOnly` verdict carries human-readable reasons.
 *
 * Verdicts:
 *   blocked     — too little measured ground, or no reliable interval:
 *                 contour generation/export should be disabled.
 *   previewOnly — suitable for visual inspection and exploratory analysis only
 *                 (high interpolation, unvalidated RMSE, or unknown
 *                 CRS / vertical datum).
 *   ready       — enough measured cells, acceptable validated error, low
 *                 interpolation, and a known CRS + vertical datum.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. Thresholds are
 * named constants here so they can be argued with, not hidden.
 */

import type { TerrainCoverageMode } from '../TerrainContracts';
import type { CellStatusTally } from './dtmCellStatus';

/** Overall readiness verdict. */
export type DtmReadiness = 'ready' | 'previewOnly' | 'blocked';
/** Export-specific verdict (export is stricter — needs CRS + datum). */
export type ExportReadiness = 'available' | 'previewOnly' | 'blocked';

/** Tunable thresholds (documented; deterministic). */
export const DTM_QUALITY_THRESHOLDS = {
  /** Below this measured-of-covered fraction → blocked (mostly guessed). */
  blockMeasuredOfCovered: 0.15,
  /** At/above this measured-of-covered fraction → eligible for ready. */
  readyMeasuredOfCovered: 0.6,
  /** Above this empty fraction → not ready. */
  readyMaxEmptyRatio: 0.4,
  /** Above this edge-risk fraction → not ready. */
  readyMaxEdgeRiskRatio: 0.15,
  /** Below this mean confidence (0..100) → not ready. */
  readyMinMeanConfidence: 55,
} as const;

/** Inputs to {@link evaluateDtmQuality}. */
export interface DtmQualityInput {
  readonly tally: CellStatusTally;
  /** Mean confidence over covered cells, 0..100. */
  readonly meanCellConfidence: number;
  /** Hold-out RMSE in source linear units; NaN when not measurable. */
  readonly holdoutRmseM: number;
  /** Ground returns / total returns from the classifier, 0..1. NaN if unknown. */
  readonly groundPointRatio: number;
  /** Coverage mode of the underlying analysis. */
  readonly coverageMode: TerrainCoverageMode;
  /** Horizontal CRS string, or null when unknown. */
  readonly crs: string | null;
  /** Vertical datum string, or null when unknown. */
  readonly verticalDatum: string | null;
  /** Recommended contour interval (m), or null when none is reliable. */
  readonly recommendedIntervalM: number | null;
}

/** The full quality report. */
export interface DtmQualityReport {
  readonly readiness: DtmReadiness;
  readonly exportReadiness: ExportReadiness;
  // ── metrics ──────────────────────────────────────────────────────────
  readonly measuredCellRatio: number;
  readonly interpolatedCellRatio: number;
  readonly emptyCellRatio: number;
  readonly edgeRiskRatio: number;
  readonly meanCellConfidence: number;
  readonly holdoutRmseM: number;
  readonly groundPointRatio: number;
  readonly coverageMode: TerrainCoverageMode;
  readonly crsKnown: boolean;
  readonly datumKnown: boolean;
  /** Human-readable reasons for the verdict (always populated for non-ready). */
  readonly reasons: string[];
}

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;

/** Evaluate the DTM quality gate. Deterministic. */
export function evaluateDtmQuality(input: DtmQualityInput): DtmQualityReport {
  const t = input.tally;
  const total = t.total > 0 ? t.total : 1;
  const interpolatedLike = t.interpolated + t.lowConfidence + t.edgeRisk;
  const covered = t.measured + interpolatedLike;

  const measuredCellRatio = t.measured / total;
  const interpolatedCellRatio = interpolatedLike / total;
  const emptyCellRatio = t.empty / total;
  const edgeRiskRatio = t.edgeRisk / total;
  const measuredOfCovered = covered > 0 ? t.measured / covered : 0;

  const crsKnown = input.crs != null;
  const datumKnown = input.verticalDatum != null;
  const hasInterval = input.recommendedIntervalM != null;
  const rmseOk = Number.isFinite(input.holdoutRmseM);

  const T = DTM_QUALITY_THRESHOLDS;
  const reasons: string[] = [];

  // ── blocked checks (hard stops) ──────────────────────────────────────
  let readiness: DtmReadiness;
  if (covered === 0) {
    reasons.push('No measured or interpolated ground cells — no surface to contour.');
    readiness = 'blocked';
  } else if (measuredOfCovered < T.blockMeasuredOfCovered) {
    reasons.push(
      `Only ${pct(measuredOfCovered)} of the surface is measured ground — too little to contour honestly.`,
    );
    readiness = 'blocked';
  } else if (!hasInterval) {
    reasons.push('No contour interval is reliable for this scan (too sparse or vertical error too high).');
    readiness = 'blocked';
  } else {
    // ── ready vs previewOnly ───────────────────────────────────────────
    const readyChecks: Array<[boolean, string]> = [
      [measuredOfCovered >= T.readyMeasuredOfCovered, `${pct(interpolatedCellRatio)} of cells are interpolated`],
      [emptyCellRatio <= T.readyMaxEmptyRatio, `${pct(emptyCellRatio)} of the grid has no data`],
      [edgeRiskRatio <= T.readyMaxEdgeRiskRatio, `${pct(edgeRiskRatio)} of cells are a long interpolation from real returns`],
      [rmseOk, 'vertical accuracy could not be validated'],
      [input.meanCellConfidence >= T.readyMinMeanConfidence, 'mean confidence is low'],
      [crsKnown, 'CRS is unknown'],
      [datumKnown, 'vertical datum is unknown'],
    ];
    const failed = readyChecks.filter(([ok]) => !ok).map(([, why]) => why);
    if (failed.length === 0) {
      readiness = 'ready';
    } else {
      readiness = 'previewOnly';
      reasons.push(`Preview only: ${joinReasons(failed)}.`);
    }
  }

  // Export is the strict gate: blocked stays blocked; anything short of a
  // fully-ready, georeferenced surface is preview-only for export.
  let exportReadiness: ExportReadiness;
  if (readiness === 'blocked') exportReadiness = 'blocked';
  else if (readiness === 'ready') exportReadiness = 'available';
  else exportReadiness = 'previewOnly';

  return {
    readiness,
    exportReadiness,
    measuredCellRatio,
    interpolatedCellRatio,
    emptyCellRatio,
    edgeRiskRatio,
    meanCellConfidence: input.meanCellConfidence,
    holdoutRmseM: input.holdoutRmseM,
    groundPointRatio: input.groundPointRatio,
    coverageMode: input.coverageMode,
    crsKnown,
    datumKnown,
    reasons,
  };
}

/** Join reason fragments into one sentence: "a, b and c". */
function joinReasons(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}
