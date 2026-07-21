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
  /**
   * Whether the ground classification was DERIVED by the viewer's heuristic
   * classifier rather than read from the source file. Absent is treated as
   * derived: the Source row must not upgrade unknown provenance into a
   * producer's survey classification.
   */
  readonly groundIsDerived?: boolean;
}

const pct = (frac: number): string => `${Math.round(frac * 100)}%`;

/**
 * Render parts as whole percentages that sum to exactly 100 (largest
 * remainder). Independent rounding lets a row read 33/33/33 or 34/33/34, and
 * a support row whose own numbers do not add up invites the reader to
 * distrust every other number on the panel.
 */
function wholePercents(parts: readonly number[], total: number): number[] {
  if (total <= 0) return parts.map(() => 0);
  const exact = parts.map((p) => (p / total) * 100);
  const floors = exact.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const out = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) out[order[k].i]++;
  return out;
}

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
  // "Covered" means every cell that carries a value, matching
  // `terrainAssessment` and the Analyse panel. This counted only
  // measured + interpolated, so the same grid was reported as two different
  // coverages depending on which panel the reader was looking at.
  const covered = tally.measured + tally.interpolated + tally.lowConfidence + tally.edgeRisk;

  const rows: ReviewRow[] = [];

  // ── Source ──────────────────────────────────────────────────────────────
  // Provenance, not just presence. This row said "Classified ground" whenever
  // a measured cell existed, so a scan with 0% classification coverage — whose
  // ground came from the viewer's geometric filter — presented a derived
  // estimate as a producer's survey classification. Unknown counts as derived:
  // silence must not be upgraded into a claim.
  const groundDerived = input.groundIsDerived !== false;
  rows.push({
    key: 'source',
    label: 'Source',
    value:
      tally.measured === 0 ? 'No ground source'
      : groundDerived ? 'Derived ground (not from the source file)'
      : 'Classified ground',
    rationale: [
      `${tally.measured.toLocaleString()} measured ground cells`,
      `${pct(covered / total)} of the grid is covered`,
      ...(tally.measured > 0 && groundDerived
        ? ['Ground was derived by the viewer’s classifier, not read from the source file. Validate before using it as survey ground.']
        : []),
    ],
    // Derived ground caps at medium however dense it is: density is not
    // provenance, and a confident-looking wrong surface is the failure mode.
    confidence:
      tally.measured === 0 ? 'low'
      : groundDerived ? 'medium'
      : measuredFrac >= 0.5 ? 'high'
      : 'medium',
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
  // Every bucket, always, summing to 100. This row used to print only
  // measured / interpolated / empty out of a five-bucket tally, so a surface
  // that was 64% low-confidence read "0% unsupported" — the reader saw no
  // weakness at all where two thirds of it was weak. Weak cells are the ones
  // a reviewer most needs to see, so they are named rather than folded away.
  const [pMeasured, pInterp, pLow, pEdge, pVoid] = wholePercents(
    [tally.measured, tally.interpolated, tally.lowConfidence, tally.edgeRisk, tally.empty],
    total,
  );
  const weakFrac = (tally.lowConfidence + tally.edgeRisk + tally.empty) / total;
  rows.push({
    key: 'support',
    label: 'Support',
    value:
      `${pMeasured}% measured · ${pInterp}% interpolated · ${pLow}% low confidence · ` +
      `${pEdge}% edge risk · ${pVoid}% void`,
    rationale: [
      'Measured cells are surveyed ground; interpolated cells are modelled from nearby ground.',
      'Low-confidence and edge-risk cells are covered but weakly supported; void cells have no data at all.',
    ],
    // Keyed off everything that is not strong. Keying it off `empty` alone
    // rated a mostly-low-confidence surface 'high' simply because no cell was
    // strictly void.
    confidence: weakFrac < 0.1 ? 'high' : weakFrac < 0.3 ? 'medium' : 'low',
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
