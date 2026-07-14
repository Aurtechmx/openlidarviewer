/**
 * contourReviewSummary.ts
 *
 * The review-bar model (v0.5.9 spec §7.1) — the recommendations the pipeline
 * already produced, surfaced with their rationale so nothing is a black box
 * (§22.5). Pure: it reads an `AnalyseContoursResult` + the current studio state
 * + the launch/frame facts and returns structured rows. No recommendation is
 * minted here; each value comes from the analysis (grid, interval gate, cell
 * tally, validation) and each carries the reason the engine gave.
 *
 * Reuses the PR3 unit-safe interval so the interval row can never present a
 * source-unit number as metres.
 */

import type { AnalyseContoursResult } from '../contour/analyseContours';
import type { ContourStudioState } from './contourStudioState';
import type { ContourStudioLaunchState } from './contourStudioLaunchState';
import {
  buildContourLevelDefinition,
  formatContourInterval,
  contourUnitClaim,
} from './contourLevelDefinition';
import type { LinearUnitScale } from '../../units/units';

export interface ReviewRow {
  readonly key: 'source' | 'grid' | 'interval' | 'support' | 'validation' | 'output' | 'evidence';
  readonly label: string;
  readonly value: string;
  readonly rationale: readonly string[];
  readonly confidence: 'high' | 'medium' | 'low';
}

export interface ContourReviewSummary {
  readonly rows: readonly ReviewRow[];
}

export interface ContourReviewInput {
  readonly launch: ContourStudioLaunchState;
  readonly state: ContourStudioState;
  readonly verticalUnit: LinearUnitScale;
  readonly sourceUnitLabel: string;
  readonly crsProjected: boolean;
}

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;

function num(n: number): string {
  return Number.parseFloat(n.toFixed(3)).toString();
}

/** Build the review-bar rows from a completed analysis result. Pure. */
export function buildContourReviewSummary(
  result: AnalyseContoursResult,
  input: ContourReviewInput,
): ContourReviewSummary {
  const tally = result.cellStatusTally;
  const total = tally.total > 0 ? tally.total : 1;
  const measuredFrac = tally.measured / total;
  const interpFrac = tally.interpolated / total;
  const unsupportedFrac = tally.empty / total;
  const covered = tally.measured + tally.interpolated;

  const rows: ReviewRow[] = [];

  // ── Source ──────────────────────────────────────────────────────────────
  rows.push({
    key: 'source',
    label: 'Source',
    value: tally.measured > 0 ? 'Classified ground' : 'No ground source',
    rationale: [
      `${tally.measured.toLocaleString()} measured ground cells`,
      `${pct(covered / total)} of the grid is covered`,
    ],
    confidence: measuredFrac >= 0.5 ? 'high' : measuredFrac > 0 ? 'medium' : 'low',
  });

  // ── Grid ────────────────────────────────────────────────────────────────
  const grid = result.gridRecommendation;
  rows.push({
    key: 'grid',
    label: 'Grid',
    value: `${num(grid.cellSizeM)} m · recommended`,
    rationale: grid.reasons.length > 0 ? grid.reasons : ['Recommended from ground spacing and memory budget.'],
    confidence: 'high',
  });

  // ── Interval (unit-safe, PR3) ─────────────────────────────────────────────
  const recommendedIntervalSource = result.gate.recommendedM ?? grid.contourIntervalM;
  if (recommendedIntervalSource != null && Number.isFinite(recommendedIntervalSource) && recommendedIntervalSource > 0) {
    const def = buildContourLevelDefinition({
      intervalSource: recommendedIntervalSource,
      baseSource: 0,
      verticalUnit: input.verticalUnit,
      sourceUnitLabel: input.sourceUnitLabel,
    });
    const claim = contourUnitClaim(def, { crsProjected: input.crsProjected });
    // The interval gate must have approved a metric interval for support to be
    // claimed. When gate.recommendedM is null we fell back to the grid's
    // geometry-only suggestion, which the gate did not endorse — so even on a
    // known-unit projected frame the interval is cartographic-only, never
    // "supported (internal)". Gating the label on gate approval keeps the
    // review from overstating support the interval gate refused.
    const gateRecommended = result.gate.recommendedM;
    const gateApprovedInterval =
      gateRecommended != null && Number.isFinite(gateRecommended) && gateRecommended > 0;
    const supported = claim === 'metric-supported' && gateApprovedInterval;
    const rmse = result.validation.rmse;
    const rationale: string[] = [];
    if (Number.isFinite(rmse)) rationale.push(`Internal vertical RMSE ${num(rmse)} m.`);
    rationale.push(
      supported
        ? 'Recommended for the current scale and internal terrain evidence.'
        : 'Cartographic recommendation only (no metric support claimed).',
    );
    for (const w of result.gate.warnings) rationale.push(w);
    rows.push({
      key: 'interval',
      label: 'Interval',
      value: `${formatContourInterval(def)} · ${supported ? 'supported (internal)' : 'cartographic-only'}`,
      rationale,
      confidence: supported ? 'high' : 'medium',
    });
  } else {
    rows.push({
      key: 'interval',
      label: 'Interval',
      value: 'none supportable',
      rationale: result.gate.warnings.length > 0 ? result.gate.warnings : ['No interval is supportable for this surface.'],
      confidence: 'low',
    });
  }

  // ── Support ───────────────────────────────────────────────────────────────
  rows.push({
    key: 'support',
    label: 'Support',
    value: `${pct(measuredFrac)} measured · ${pct(interpFrac)} interpolated · ${pct(unsupportedFrac)} unsupported`,
    rationale: ['Measured cells are surveyed ground; interpolated cells are modelled; unsupported cells are void.'],
    confidence: unsupportedFrac < 0.1 ? 'high' : unsupportedFrac < 0.3 ? 'medium' : 'low',
  });

  // ── Validation ────────────────────────────────────────────────────────────
  const rmse = result.validation.rmse;
  rows.push({
    key: 'validation',
    label: 'Validation',
    value: Number.isFinite(rmse) ? `Spatial internal · RMSE ${num(rmse)} m` : 'Spatial internal',
    rationale: ['Internal hold-out validation only — no independent checkpoints were provided.'],
    confidence: 'medium',
  });

  // ── Output ────────────────────────────────────────────────────────────────
  const geom = [input.state.contour.analytical ? 'analytical' : null, input.state.contour.cartographic ? 'cartographic' : null]
    .filter(Boolean)
    .join(' + ') || 'none';
  rows.push({
    key: 'output',
    label: 'Output',
    value: geom,
    rationale: ['Analytical geometry is exact (GIS); cartographic geometry is generalized (PDF).'],
    confidence: 'high',
  });

  // ── Evidence (from the launch state — the real claim) ─────────────────────
  const evidenceValue =
    input.launch.status === 'available'
      ? 'Supported (internal validation only)'
      : input.launch.status === 'exploratory'
        ? 'Exploratory'
        : 'Blocked';
  rows.push({
    key: 'evidence',
    label: 'Evidence',
    value: evidenceValue,
    rationale:
      input.launch.status === 'unavailable' || input.launch.status === 'exploratory'
        ? [...input.launch.reasons]
        : ['Internal spatial validation; not survey-grade.'],
    confidence: input.launch.status === 'available' ? 'high' : 'low',
  });

  return { rows };
}
