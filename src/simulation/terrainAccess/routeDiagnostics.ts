/**
 * routeDiagnostics.ts — what a found route actually crossed, per §12.9 of the
 * governing prompt.
 *
 * A route that only reports "FOUND, cost 41.2" tells a reader nothing about
 * where the risk in it sits. This walks the path cell-by-cell and reports the
 * worst conditions along it — the whole point being that a route diagnostic
 * is inspectable, not a single opaque number.
 *
 * Evidence along the route is reported as two separate things:
 *
 *   - PROVENANCE (`fractionMeasured` / `fractionInterpolated`): the share of
 *     route cells whose height was measured or interpolated, read from
 *     `grid.coverage` alone. Null when the grid carries no coverage.
 *   - WEAK EVIDENCE (`fractionBelowProfileConfidence`): the share of EVERY
 *     route cell — measured or interpolated — whose confidence is below the
 *     profile's own `minimumTerrainConfidence`, the threshold recorded in the
 *     run. A measured cell is not exempt: few returns can make a measured cell
 *     weak. The display thresholds in `cellConfidence.ts` play no part.
 *
 *   - DERIVATIVE SUPPORT (`fractionDerivativeSynthesised`): the share of route
 *     cells whose slope and aspect used a synthesised neighbour, split by
 *     cause (outer boundary or interior NoData hole), and the route cells
 *     whose 3×3 ruggedness window holds such a cell.
 *
 * No edge-risk figure is reported: that needs the DTM's `interpDistanceCells`,
 * which this module's grid does not carry.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import {
  DERIVATIVE_CAUSE_BOUNDARY, DERIVATIVE_CAUSE_HOLE, edgeGeometry, utilization, windowHoldsFlagged,
  type CostWeights, type TerrainAccessFeatures,
} from './traversabilityCost';
import type { TerrainAccessGrid } from './terrainAccessTypes';

const MEASURED = 2;
const INTERPOLATED = 1;

/** A named cost term and how much of the route's total soft cost it explains. */
export interface CostContributor {
  readonly term: 'longitudinal-grade' | 'cross-slope' | 'ruggedness' | 'step' | 'support';
  /**
   * Sum, over every edge in the route, of this term's weighted utilization
   * times the edge's horizontal distance in metres: the share of the route's
   * total cost this term accounts for, so a long diagonal edge counts for
   * more than a short orthogonal one, as it does in the cost itself.
   */
  readonly total: number;
}

/** Everything §12.9 asks a completed route to disclose. */
export interface RouteDiagnostics {
  readonly cellCount: number;
  readonly horizontalLengthM: number;
  readonly length3dM: number;
  readonly totalAscentM: number;
  readonly totalDescentM: number;
  /**
   * Per-edge grade as `edgeGeometry` defines it (the larger of the Horn
   * directional grade at either endpoint and the edge's own rise/run), the
   * same figure the grade limit gates.
   */
  readonly maxLongitudinalGrade: number;
  /** 95th percentile of the per-edge grade, weighted by edge length. */
  readonly p95LongitudinalGrade: number;
  readonly maxCrossSlope: number;
  /** 95th percentile of the per-edge cross slope, weighted by edge length. */
  readonly p95CrossSlope: number;
  /**
   * The largest step actually crossed along the route (`moveStep`, read as
   * `evalr.stepM` in `traversabilityCost.ts`): the part of a move's rise the
   * terrain on either side does not explain, so a smooth slope adds nothing to
   * it. The exact quantity `maxStepHeight` gates a move against, and the
   * figure a reader should compare to their declared step limit.
   */
  readonly maxEdgeStepM: number;
  /**
   * The largest windowed-footprint relief (`features.localStep`, the largest
   * raw height difference in a route cell's whole 3x3 neighbourhood, slope
   * included, whether or not the route crosses it) touched by the route. NOT
   * the quantity the step limit applies to, so this is reported separately
   * and never compared to `maxStepHeight` by name.
   */
  readonly maxLocalReliefM: number;
  readonly maxVrm: number;
  readonly minTerrainConfidence: number;
  /** Provenance: share of route cells measured. Null when `grid.coverage` was not supplied. */
  readonly fractionMeasured: number | null;
  /** Provenance: share of route cells interpolated. Null when `grid.coverage` was not supplied. */
  readonly fractionInterpolated: number | null;
  /**
   * Share of all route cells whose confidence is below
   * {@link profileMinimumTerrainConfidence}, whatever their provenance. Null
   * only for an empty path.
   */
  readonly fractionBelowProfileConfidence: number | null;
  /** The profile's `minimumTerrainConfidence` the share above was computed against. */
  readonly profileMinimumTerrainConfidence: number;
  /**
   * Route cells whose slope and aspect used a synthesised neighbour
   * (`TerrainAccessFeatures.derivativeSynthesised`): the grid's outer ring,
   * or a cell beside a void. Zero under the conservative evidence policy,
   * which blocks them.
   */
  readonly derivativeSynthesisedRouteCells: number;
  /** {@link derivativeSynthesisedRouteCells} over all route cells. Null only for an empty path. */
  readonly fractionDerivativeSynthesised: number | null;
  /** Of {@link derivativeSynthesisedRouteCells}, those at the outer boundary (grid edge or NoData reaching it). */
  readonly derivativeSynthesisedBoundaryRouteCells: number;
  /** Of {@link derivativeSynthesisedRouteCells}, those beside an interior NoData hole only. */
  readonly derivativeSynthesisedHoleRouteCells: number;
  /**
   * Route cells whose 3×3 ruggedness (VRM) window holds a cell flagged in
   * `derivativeSynthesised`, itself included: their VRM reads at least one
   * slope computed with a substituted neighbour. Zero under the conservative
   * evidence policy while a ruggedness limit is set, which blocks them.
   */
  readonly ruggednessSynthesisedRouteCells: number;
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
    readonly minimumTerrainConfidence: number;
  },
): RouteDiagnostics {
  if (path.length === 0) {
    return {
      cellCount: 0, horizontalLengthM: 0, length3dM: 0, totalAscentM: 0, totalDescentM: 0,
      maxLongitudinalGrade: 0, p95LongitudinalGrade: 0, maxCrossSlope: 0, p95CrossSlope: 0,
      maxEdgeStepM: 0, maxLocalReliefM: 0, maxVrm: 0, minTerrainConfidence: Number.NaN,
      fractionMeasured: null, fractionInterpolated: null, fractionBelowProfileConfidence: null,
      profileMinimumTerrainConfidence: profile.minimumTerrainConfidence,
      derivativeSynthesisedRouteCells: 0, fractionDerivativeSynthesised: null,
      derivativeSynthesisedBoundaryRouteCells: 0, derivativeSynthesisedHoleRouteCells: 0,
      ruggednessSynthesisedRouteCells: 0,
      dominantCostContributors: [],
    };
  }

  let horizontalLengthM = 0;
  let length3dM = 0;
  let totalAscentM = 0;
  let totalDescentM = 0;
  const longitudinalGrades: number[] = [];
  const crossSlopes: number[] = [];
  const edgeLengths: number[] = [];
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
    edgeLengths.push(evalr.distanceM);

    // Each term weighted by the edge's distance, as edgeCost weights it.
    const w = evalr.distanceM;
    contribSums['longitudinal-grade'] += w * weights.longitudinal * utilization(evalr.longitudinalGrade, profile.maxLongitudinalGrade);
    contribSums['cross-slope'] += w * weights.cross * utilization(evalr.crossSlope, profile.maxCrossSlope);
    contribSums.step += w * weights.step * utilization(evalr.stepM, profile.maxStepHeight);
    const vrmHere = Math.max(features.vrm[prev] || 0, features.vrm[i] || 0);
    contribSums.ruggedness += profile.maxRuggedness != null
      ? w * weights.ruggedness * utilization(vrmHere, profile.maxRuggedness)
      : 0;
    contribSums.support += w * weights.support * (1 - Math.min(grid.confidence[prev], grid.confidence[i]) / 100);
  }

  let measured = 0;
  let interpolated = 0;
  let belowProfile = 0;
  let synthesised = 0;
  let synthesisedBoundary = 0;
  let synthesisedHole = 0;
  let ruggednessSynthesised = 0;
  const coverage = grid.coverage;
  for (const i of path) {
    if (grid.confidence[i] < profile.minimumTerrainConfidence) belowProfile++;
    if (features.derivativeSynthesised[i] === 1) synthesised++;
    const cause = features.derivativeSupportCause[i];
    if (cause === DERIVATIVE_CAUSE_BOUNDARY) synthesisedBoundary++;
    else if (cause === DERIVATIVE_CAUSE_HOLE) synthesisedHole++;
    if (windowHoldsFlagged(features.derivativeSynthesised, grid.cols, grid.rows, i)) ruggednessSynthesised++;
    if (!coverage) continue;
    if (coverage[i] === MEASURED) measured++;
    else if (coverage[i] === INTERPOLATED) interpolated++;
  }
  const coverageKnown = coverage != null;

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
    p95LongitudinalGrade: weightedQuantile(longitudinalGrades, edgeLengths, 0.95),
    maxCrossSlope: crossSlopes.length ? Math.max(...crossSlopes) : 0,
    p95CrossSlope: weightedQuantile(crossSlopes, edgeLengths, 0.95),
    maxEdgeStepM, maxLocalReliefM,
    maxVrm,
    minTerrainConfidence: Number.isFinite(minTerrainConfidence) ? minTerrainConfidence : Number.NaN,
    fractionMeasured: coverageKnown ? measured / path.length : null,
    fractionInterpolated: coverageKnown ? interpolated / path.length : null,
    fractionBelowProfileConfidence: belowProfile / path.length,
    profileMinimumTerrainConfidence: profile.minimumTerrainConfidence,
    derivativeSynthesisedRouteCells: synthesised,
    fractionDerivativeSynthesised: synthesised / path.length,
    derivativeSynthesisedBoundaryRouteCells: synthesisedBoundary,
    derivativeSynthesisedHoleRouteCells: synthesisedHole,
    ruggednessSynthesisedRouteCells: ruggednessSynthesised,
    dominantCostContributors: contributors,
  };
}

/**
 * Relative tolerance on the coverage test in {@link weightedQuantile}. Edge
 * lengths such as √2 or 0.1 are not exact in binary, so a running sum that
 * covers exactly `q` of the total can land one ulp short of `q · total`.
 * Values whose coverage falls within this fraction of the total are taken as
 * reaching it.
 */
const QUANTILE_RELATIVE_TOLERANCE = 1e-12;

/**
 * Length-weighted quantile: the smallest value v such that edges with value
 * at most v cover at least fraction `q` of the total weight. Lower-value
 * step function (no interpolation), so the result is always an observed
 * edge value. 0 for an empty input. Sums are compensated (Neumaier) and the
 * coverage test allows {@link QUANTILE_RELATIVE_TOLERANCE} of the total, so
 * an exact boundary (95 of 100 equal √2 edges at q = 0.95) returns the
 * boundary value rather than the next one.
 */
export function weightedQuantile(values: readonly number[], weightsIn: readonly number[], q: number): number {
  const idx: number[] = [];
  let total = 0;
  let totalComp = 0;
  for (let k = 0; k < values.length; k++) {
    if (!Number.isFinite(values[k]) || !(weightsIn[k] > 0)) continue;
    idx.push(k);
    const t = total + weightsIn[k];
    totalComp += Math.abs(total) >= weightsIn[k] ? (total - t) + weightsIn[k] : (weightsIn[k] - t) + total;
    total = t;
  }
  if (idx.length === 0) return 0;
  total += totalComp;
  idx.sort((a, b) => values[a] - values[b] || a - b);
  const threshold = q * total - QUANTILE_RELATIVE_TOLERANCE * total;
  let acc = 0;
  let accComp = 0;
  for (const k of idx) {
    const w = weightsIn[k];
    const t = acc + w;
    accComp += Math.abs(acc) >= w ? (acc - t) + w : (w - t) + acc;
    acc = t;
    if (acc + accComp >= threshold) return values[k];
  }
  return values[idx[idx.length - 1]];
}
