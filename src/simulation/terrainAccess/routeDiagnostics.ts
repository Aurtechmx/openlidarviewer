/**
 * routeDiagnostics.ts — what a found route actually crossed, per §12.9 of the
 * governing prompt.
 *
 * A route that only reports "FOUND, cost 41.2" tells a reader nothing about
 * where the risk in it sits. This walks the path cell-by-cell and reports the
 * worst conditions along it — the whole point being that a route diagnostic
 * is inspectable, not a single opaque number.
 *
 * `fraction low-confidence/edge-risk cells` is computed from `grid.coverage`
 * and `grid.confidence` alone (measured cells always count as measured,
 * mirroring `dtmCellStatus.ts`'s precedence; a covered cell below the
 * project's shared `dashed` confidence threshold counts toward this bucket).
 * It does not reproduce `dtmCellStatus.ts`'s separate `edgeRisk` state, which
 * needs the DTM's `interpDistanceCells` — a field this module's grid does not
 * carry, by the same "know only what routing needs" discipline
 * `flowPulse/flowTypes.ts` documents. The governing prompt's own §12.9 list
 * groups "low-confidence/edge-risk" as one bucket, which is exactly what is
 * reported here; `basis.coverage` from the caller's `SimulationInputBasis`
 * says more about resident/sampled sources if the reader needs it.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { EVIDENCE_THRESHOLDS } from '../../terrain/ground/cellConfidence';
import { quantile } from '../../terrain/quantile';
import { edgeGeometry, utilization, type CostWeights, type TerrainAccessFeatures } from './traversabilityCost';
import type { TerrainAccessGrid } from './terrainAccessTypes';

const MEASURED = 2;

/** A named cost term and how much of the route's total soft cost it explains. */
export interface CostContributor {
  readonly term: 'longitudinal-grade' | 'cross-slope' | 'ruggedness' | 'step' | 'support';
  /** Sum, over every edge in the route, of this term's weighted utilization. */
  readonly total: number;
}

/** Everything §12.9 asks a completed route to disclose. */
export interface RouteDiagnostics {
  readonly cellCount: number;
  readonly horizontalLengthM: number;
  readonly length3dM: number;
  readonly totalAscentM: number;
  readonly totalDescentM: number;
  readonly maxLongitudinalGrade: number;
  readonly p95LongitudinalGrade: number;
  readonly maxCrossSlope: number;
  readonly p95CrossSlope: number;
  /**
   * The largest adjacent-cell elevation jump actually crossed along the
   * route (`edgeStep`/`evalr.stepM` in `traversabilityCost.ts`) — the exact
   * quantity `maxStepHeight` gates a move against. This is the figure a
   * reader should compare to their declared step limit.
   */
  readonly maxEdgeStepM: number;
  /**
   * The largest windowed-footprint relief (`features.localStep`, the worst
   * discontinuity in a route cell's whole 3x3 neighbourhood, whether or not
   * the route crosses it) touched by the route. NOT the quantity the step
   * limit applies to — a route can pass near a discontinuity it never
   * crosses — so this is reported separately and never compared to
   * `maxStepHeight` by name.
   */
  readonly maxLocalReliefM: number;
  readonly maxVrm: number;
  readonly minTerrainConfidence: number;
  /** Null when `grid.coverage` was not supplied. */
  readonly fractionMeasured: number | null;
  readonly fractionInterpolated: number | null;
  readonly fractionLowConfidenceOrEdgeRisk: number | null;
  /** Ordered, largest contributor first. */
  readonly dominantCostContributors: readonly CostContributor[];
}

/** Compute {@link RouteDiagnostics} for a found path (start..goal inclusive). */
export function computeRouteDiagnostics(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  path: readonly number[],
  weights: CostWeights,
  profile: {
    readonly maxLongitudinalGrade: number;
    readonly maxCrossSlope: number;
    readonly maxStepHeight: number;
    readonly maxRuggedness: number | null;
  },
): RouteDiagnostics {
  if (path.length === 0) {
    return {
      cellCount: 0, horizontalLengthM: 0, length3dM: 0, totalAscentM: 0, totalDescentM: 0,
      maxLongitudinalGrade: 0, p95LongitudinalGrade: 0, maxCrossSlope: 0, p95CrossSlope: 0,
      maxEdgeStepM: 0, maxLocalReliefM: 0, maxVrm: 0, minTerrainConfidence: Number.NaN,
      fractionMeasured: null, fractionInterpolated: null, fractionLowConfidenceOrEdgeRisk: null,
      dominantCostContributors: [],
    };
  }

  let horizontalLengthM = 0;
  let length3dM = 0;
  let totalAscentM = 0;
  let totalDescentM = 0;
  const longitudinalGrades: number[] = [];
  const crossSlopes: number[] = [];
  let maxEdgeStepM = 0;
  let maxLocalReliefM = 0;
  let minTerrainConfidence = Number.POSITIVE_INFINITY;
  let maxVrm = 0;

  const contribSums = { 'longitudinal-grade': 0, 'cross-slope': 0, ruggedness: 0, step: 0, support: 0 };

  for (let k = 0; k < path.length; k++) {
    const i = path[k];
    if (grid.confidence[i] < minTerrainConfidence) minTerrainConfidence = grid.confidence[i];
    const relief = features.localStep[i];
    if (Number.isFinite(relief) && relief > maxLocalReliefM) maxLocalReliefM = relief;
    const vrm = features.vrm[i];
    if (Number.isFinite(vrm) && vrm > maxVrm) maxVrm = vrm;

    if (k === 0) continue;
    const prev = path[k - 1];
    const prevRow = Math.floor(prev / grid.cols);
    const prevCol = prev - prevRow * grid.cols;
    const row = Math.floor(i / grid.cols);
    const col = i - row * grid.cols;
    const dx = col - prevCol;
    const dy = row - prevRow;

    const evalr = edgeGeometry(grid, features, prev, i, dx, dy);
    if (Number.isFinite(evalr.stepM) && evalr.stepM > maxEdgeStepM) maxEdgeStepM = evalr.stepM;
    horizontalLengthM += evalr.distanceM;
    const rise = grid.z[i] - grid.z[prev];
    length3dM += Math.hypot(evalr.distanceM, rise);
    if (rise > 0) totalAscentM += rise; else totalDescentM += -rise;

    longitudinalGrades.push(evalr.longitudinalGrade);
    crossSlopes.push(evalr.crossSlope);

    contribSums['longitudinal-grade'] += weights.longitudinal * utilization(evalr.longitudinalGrade, profile.maxLongitudinalGrade);
    contribSums['cross-slope'] += weights.cross * utilization(evalr.crossSlope, profile.maxCrossSlope);
    contribSums.step += weights.step * utilization(evalr.stepM, profile.maxStepHeight);
    const vrmHere = Math.max(features.vrm[prev] || 0, features.vrm[i] || 0);
    contribSums.ruggedness += profile.maxRuggedness != null
      ? weights.ruggedness * utilization(vrmHere, profile.maxRuggedness)
      : 0;
    contribSums.support += weights.support * (1 - Math.min(grid.confidence[prev], grid.confidence[i]) / 100);
  }

  let measured = 0;
  let interpolated = 0;
  let lowConfOrEdge = 0;
  const coverageKnown = grid.coverage != null;
  if (coverageKnown) {
    for (const i of path) {
      const cov = (grid.coverage as Uint8Array)[i];
      if (cov === MEASURED) { measured++; continue; }
      // Not measured: either interpolated-and-trusted, or low-confidence/edge-risk.
      if (grid.confidence[i] < EVIDENCE_THRESHOLDS.dashed) lowConfOrEdge++;
      else interpolated++;
    }
  }

  const contributors: CostContributor[] = (Object.keys(contribSums) as (keyof typeof contribSums)[])
    .map((term) => ({ term, total: contribSums[term] }))
    .sort((a, b) => b.total - a.total);

  return {
    cellCount: path.length,
    horizontalLengthM,
    length3dM,
    totalAscentM,
    totalDescentM,
    maxLongitudinalGrade: longitudinalGrades.length ? Math.max(...longitudinalGrades) : 0,
    p95LongitudinalGrade: quantile(longitudinalGrades, 0.95),
    maxCrossSlope: crossSlopes.length ? Math.max(...crossSlopes) : 0,
    p95CrossSlope: quantile(crossSlopes, 0.95),
    maxEdgeStepM, maxLocalReliefM,
    maxVrm,
    minTerrainConfidence: Number.isFinite(minTerrainConfidence) ? minTerrainConfidence : Number.NaN,
    fractionMeasured: coverageKnown ? measured / path.length : null,
    fractionInterpolated: coverageKnown ? interpolated / path.length : null,
    fractionLowConfidenceOrEdgeRisk: coverageKnown ? lowConfOrEdge / path.length : null,
    dominantCostContributors: contributors,
  };
}
