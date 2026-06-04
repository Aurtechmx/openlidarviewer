/**
 * terrainAssessment.ts
 *
 * A single, plain-language top-level verdict for an analysed scan — the one
 * line a non-specialist should read first, above all the detailed metrics
 * (density, coverage, RMSE, NVA/VVA, readiness, quality score). It answers
 * "can I trust this surface, and what is it good for?" by collapsing the DTM
 * quality gate into three buckets:
 *
 *   Good     — suitable for terrain products and DEM workflows.
 *   Preview  — suitable for inspection and measurement workflows.
 *   Limited  — insufficient data quality for reliable terrain products.
 *
 * Note: the tool measures coverage, interpolation, RMSE and applies a quality
 * gate — it does NOT certify "survey-grade" output. A licensed surveyor,
 * control network, datum validation and regulatory acceptance are out of
 * scope, so this verdict speaks to data quality and fitness-for-use, not to
 * survey certification.
 *
 * Pure-data: derived entirely from the existing quality report + coverage, so
 * it never disagrees with the detailed numbers shown beneath it.
 */

import type { AnalyseContoursResult } from './analyseContours';

export type AssessmentVerdict = 'Good' | 'Preview' | 'Limited';

export interface TerrainAssessment {
  readonly verdict: AssessmentVerdict;
  /** One-line reason, e.g. "38% interpolated, resident-node coverage". */
  readonly reason: string;
  /** What this surface is suitable for. */
  readonly bestFor: string;
  /** What to be careful with, or '' when nothing to caution. */
  readonly caution: string;
}

const pct = (frac: number): number => Math.round(frac * 100);

/** Collapse an analysis result into a single top-level assessment. */
export function terrainAssessment(result: AnalyseContoursResult): TerrainAssessment {
  const q = result.quality;
  const cov = result.dtm.coverage;
  let measured = 0;
  let covered = 0;
  for (let i = 0; i < cov.length; i++) {
    if (cov[i] === 2) { measured++; covered++; }
    else if (cov[i] === 1) covered++;
  }
  const interpPct = covered > 0 ? pct(1 - measured / covered) : 100;

  // The DTM quality gate is the authoritative verdict; map it straight through
  // so the headline can never contradict the export gating below it.
  let verdict: AssessmentVerdict;
  if (q.readiness === 'ready') verdict = 'Good';
  else if (q.readiness === 'previewOnly') verdict = 'Preview';
  else verdict = 'Limited';

  // Prefer the gate's own first reason; fall back to the interpolation read.
  const gateReason = q.reasons.find((r) => r && r.trim().length > 0);
  const reason =
    verdict === 'Good'
      ? `${pct(measured / Math.max(1, covered))}% measured ground · passes the DTM quality gate`
      : (gateReason ?? `${interpPct}% interpolated coverage`);

  const bestFor =
    verdict === 'Good'
      ? 'terrain products, DEM export, measurement & inspection'
      : verdict === 'Preview'
        ? 'profile review, measurement, terrain inspection'
        : 'visual inspection only';
  const caution =
    verdict === 'Good'
      ? ''
      : verdict === 'Preview'
        ? 'terrain products are preliminary — verify before relying on them'
        : 'not suitable for reliable terrain products';

  return { verdict, reason, bestFor, caution };
}
