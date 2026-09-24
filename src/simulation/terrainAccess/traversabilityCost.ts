/**
 * traversabilityCost.ts — hard eligibility and soft cost over a terrain-access
 * grid, per §12.6 of the governing prompt.
 *
 * ── NODE CONSTRAINTS VS. EDGE CONSTRAINTS ───────────────────────────────────
 * The prompt's hard-block list mixes two different kinds of fact:
 *
 *   direction-independent (a property of the CELL): NoData, outside ROI,
 *   minimum support, ruggedness, obstruction evidence
 *
 *   direction-dependent (a property of a specific MOVE): longitudinal grade,
 *   cross slope, step height
 *
 * A cell can be perfectly fine to stand on yet unreachable from one heading
 * and reachable from another (TA-3's cross-slope trap is exactly this), so
 * collapsing both kinds into one per-cell flag would either over-block a
 * cell that has a usable heading or under-block a heading that does not
 * exist. This module keeps them separate: `nodeEligibility` decides whether a
 * cell can be part of the graph AT ALL, `evaluateEdge` decides whether one
 * specific directed move between two already-eligible cells is allowed.
 *
 * ── THE COST FORMULA IS THE ONE §12.6 SPECIFIES, WITH A NAMED f ─────────────
 * `edgeCost = distance · (1 + Σ w · f(value / limit))`, monotonic
 * `f(x) = clamp(x, 0, 1)`: cost rises linearly with how much of the declared
 * limit a move actually uses, saturating at 1 exactly at the limit — beyond
 * it the move is hard-blocked and never reaches this formula, so `f` never
 * needs to represent overshoot. A term whose limit is disabled (ruggedness
 * with `maxRuggedness: null`) or zero contributes 0 rather than dividing by
 * zero. The weights are declared and bounded, not implied.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { hornSlopeAspect } from '../../terrain/ground/terrainDerivatives';
import { computeVRM } from '../../terrain/complexity/vectorRuggedness';
import { computeLocalStep, edgeStep } from './localStep';
import { classifyObstruction, type ObstructionState } from './obstacleEvidence';
import { dilateBlocked } from './footprintClearance';
import { directionalSlope, gradientField, headingUnit, type GradientField } from './directionalGrade';
import {
  TERRAIN_ACCESS_NEIGHBOURS,
  type BlockReason,
  type EdgeBlockReason,
  type NodeBlockReason,
  type TerrainAccessGrid,
  type TerrainAccessProfile,
} from './terrainAccessTypes';

/** The 3×3 (1-cell-radius) window Horn slope, VRM and the local-step metric
 * all share by default in this module, so "local" means one neighbourhood
 * everywhere a Terrain Access feature says it. */
const LOCAL_WINDOW_CELLS = 3;

/** Terrain features prepared once per run and read by every edge/node query. */
export interface TerrainAccessFeatures {
  readonly slope: Float32Array;
  readonly aspect: Float32Array;
  readonly gradient: GradientField;
  /** Vector Ruggedness Measure, [0, 1] or NaN at an invalid cell. */
  readonly vrm: Float32Array;
  /** The §12.4 local-step diagnostic (3×3 footprint), metres. */
  readonly localStep: Float32Array;
  readonly obstruction: readonly ObstructionState[];
}

/** Build every terrain feature the cost model reads, once, from the grid. */
export function prepareTerrainAccessFeatures(
  grid: TerrainAccessGrid,
  profile: TerrainAccessProfile,
): TerrainAccessFeatures {
  // `hornSlopeAspect` has no `valid` mask of its own: it takes a non-finite
  // `z[i]` as its own "no data" signal. `grid.z` is contractually NaN at an
  // invalid cell (see `dtmTerrainAccessGrid.ts`), but this masks defensively
  // rather than trusting every caller/fixture to honour that — a zero-filled
  // invalid cell would otherwise pollute a valid neighbour's Horn window with
  // a fabricated 0 m elevation, silently, on any terrain that is not itself
  // flat at 0 m.
  const maskedZ = new Float32Array(grid.z.length);
  for (let i = 0; i < maskedZ.length; i++) maskedZ[i] = grid.valid[i] === 0 ? Number.NaN : grid.z[i];
  const { slope, aspect } = hornSlopeAspect(maskedZ, grid.cols, grid.rows, grid.cellMetresX, grid.cellMetresY);
  const gradient = gradientField({ slope, aspect });
  const vrmResult = computeVRM(slope, aspect, grid.cols, grid.rows, {
    windowCells: LOCAL_WINDOW_CELLS,
    valid: grid.valid,
  });
  const localStep = computeLocalStep(grid, (LOCAL_WINDOW_CELLS - 1) / 2);
  const obstruction = classifyObstruction(grid, profile.obstacleHeightThreshold);
  return { slope, aspect, gradient, vrm: vrmResult.vrm, localStep, obstruction };
}

/** Per-cell node eligibility: blocked flag + the reason, before width clearance. */
export interface NodeEligibility {
  readonly blocked: Uint8Array;
  readonly reason: readonly (NodeBlockReason | null)[];
}

/**
 * Direction-independent eligibility: NoData, ROI, support, ruggedness,
 * obstruction. Does not yet account for vehicle width — see
 * {@link applyWidthClearance}.
 */
export function nodeEligibility(grid: TerrainAccessGrid, features: TerrainAccessFeatures, profile: TerrainAccessProfile): NodeEligibility {
  const n = grid.cols * grid.rows;
  const blocked = new Uint8Array(n);
  const reason: (NodeBlockReason | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    if (grid.valid[i] === 0) { blocked[i] = 1; reason[i] = 'no-data'; continue; }
    if (grid.allowed && grid.allowed[i] === 0) { blocked[i] = 1; reason[i] = 'outside-roi'; continue; }
    if (grid.confidence[i] < profile.minimumTerrainConfidence && profile.unknownPolicy === 'block') {
      blocked[i] = 1; reason[i] = 'low-confidence'; continue;
    }
    if (profile.maxRuggedness != null) {
      const v = features.vrm[i];
      if (Number.isFinite(v) && v > profile.maxRuggedness) { blocked[i] = 1; reason[i] = 'ruggedness'; continue; }
    }
    if (features.obstruction[i] === 'obstructed') { blocked[i] = 1; reason[i] = 'obstruction'; continue; }
  }
  return { blocked, reason };
}

/** Dilate `eligibility` by `profile.vehicleWidth / 2`, per §12.7. */
export function applyWidthClearance(
  grid: TerrainAccessGrid,
  eligibility: NodeEligibility,
  profile: TerrainAccessProfile,
): NodeEligibility {
  const dilated = dilateBlocked(
    eligibility.blocked, grid.cols, grid.rows, grid.cellMetresX, grid.cellMetresY, profile.vehicleWidth,
  );
  const reason = eligibility.reason.slice();
  for (let i = 0; i < dilated.length; i++) {
    if (dilated[i] === 1 && eligibility.blocked[i] === 0) reason[i] = 'vehicle-width';
  }
  return { blocked: dilated, reason };
}

/** The pure geometry of one directed move — no profile, no blocking decision. */
export interface EdgeGeometry {
  readonly distanceM: number;
  readonly longitudinalGrade: number;
  readonly crossSlope: number;
  readonly stepM: number;
}

/**
 * The geometry of the directed move `from → to` along raster offset
 * `(dx, dy)`: physical distance, directional grade/cross-slope (evaluated at
 * `from`'s gradient, per §12.5) and the edge step. Independent of any
 * profile, so a caller that only wants the numbers — `routeDiagnostics.ts`,
 * a UI inspector — is not required to fabricate one.
 */
export function edgeGeometry(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  fromIndex: number,
  toIndex: number,
  dx: number,
  dy: number,
): EdgeGeometry {
  const heading = headingUnit(dx, dy, grid.cellMetresX, grid.cellMetresY);
  const grad = { east: features.gradient.east[fromIndex], north: features.gradient.north[fromIndex] };
  const { longitudinalGrade, crossSlope } = directionalSlope(grad, heading);
  const stepM = edgeStep(grid, fromIndex, toIndex);
  const distanceM = Math.hypot(dx * grid.cellMetresX, dy * grid.cellMetresY);
  return { distanceM, longitudinalGrade, crossSlope, stepM };
}

/** The evaluation of one specific directed move between two eligible nodes. */
export interface EdgeEvaluation extends EdgeGeometry {
  readonly blocked: boolean;
  readonly reason: EdgeBlockReason | null;
}

/**
 * Evaluate the directed move `from → to` against `profile`'s declared
 * limits. Does not check node eligibility — a caller only evaluates edges
 * between cells `nodeEligibility` (post width-clearance) has already
 * accepted.
 */
export function evaluateEdge(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  profile: Pick<TerrainAccessProfile, 'maxStepHeight' | 'maxLongitudinalGrade' | 'maxCrossSlope'>,
  fromIndex: number,
  toIndex: number,
  dx: number,
  dy: number,
): EdgeEvaluation {
  const geometry = edgeGeometry(grid, features, fromIndex, toIndex, dx, dy);
  const { longitudinalGrade, crossSlope, stepM } = geometry;

  let reason: EdgeBlockReason | null = null;
  if (Number.isFinite(stepM) && stepM > profile.maxStepHeight) reason = 'step-height';
  else if (longitudinalGrade > profile.maxLongitudinalGrade) reason = 'longitudinal-grade';
  else if (crossSlope > profile.maxCrossSlope) reason = 'cross-slope';

  return { ...geometry, blocked: reason != null, reason };
}

/** Declared, bounded weights for the soft-cost terms. Illustrative defaults —
 * "OLV generic geometric weighting", not a validated real-world cost model,
 * matching the caution §8.12 applies to Scan Rescue's default ranking. */
export interface CostWeights {
  readonly longitudinal: number;
  readonly cross: number;
  readonly ruggedness: number;
  readonly step: number;
  readonly support: number;
}

export const DEFAULT_COST_WEIGHTS: CostWeights = Object.freeze({
  longitudinal: 1,
  cross: 1,
  ruggedness: 0.5,
  step: 1,
  support: 1,
});

/** Monotonic utilization: 0 at no use, 1 at (or past) the declared limit.
 * Exported so `routeDiagnostics.ts` reports the same ratio the cost model
 * itself used, rather than a second, silently-divergent computation. */
export function utilization(value: number, limit: number): number {
  if (!(limit > 0) || !Number.isFinite(value)) return 0;
  const x = value / limit;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The full edge cost for an already-eligible move, per §12.6's formula. Null
 * when the edge itself is hard-blocked (never compute a cost for a move that
 * cannot be taken).
 */
export function edgeCost(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  profile: TerrainAccessProfile,
  fromIndex: number,
  toIndex: number,
  dx: number,
  dy: number,
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
): number | null {
  const evalr = evaluateEdge(grid, features, profile, fromIndex, toIndex, dx, dy);
  if (evalr.blocked) return null;

  const ruggedness = profile.maxRuggedness != null
    ? utilization(Math.max(features.vrm[fromIndex] || 0, features.vrm[toIndex] || 0), profile.maxRuggedness)
    : 0;
  const confidence01 = Math.min(grid.confidence[fromIndex], grid.confidence[toIndex]) / 100;

  const multiplier =
    1
    + weights.longitudinal * utilization(evalr.longitudinalGrade, profile.maxLongitudinalGrade)
    + weights.cross * utilization(evalr.crossSlope, profile.maxCrossSlope)
    + weights.ruggedness * ruggedness
    + weights.step * utilization(evalr.stepM, profile.maxStepHeight)
    + weights.support * (1 - confidence01);

  return evalr.distanceM * multiplier;
}

/** One cell's state on the traversability map (§12.10). */
export type MapCellState = 'blocked' | 'unknown' | 'low-cost' | 'moderate-cost' | 'high-cost';

/** Illustrative cost-multiplier buckets for the map/legend — not a validated
 * scientific classification, documented the way `EVIDENCE_THRESHOLDS` is in
 * `cellConfidence.ts`. The multiplier is the `edgeCost` bracket term (total
 * cost ÷ distance), so 0 is a flat, fully-supported move. */
export const MAP_COST_BUCKETS = Object.freeze({ low: 0.15, moderate: 0.5 });

/** Per-cell traversability-map classification, and the best achievable cost
 * multiplier that classification rests on (null when the cell is blocked or
 * unknown). */
export interface TraversabilityMapCell {
  readonly state: MapCellState;
  readonly bestMultiplier: number | null;
}

/**
 * Classify every cell for the traversability map. A node-eligible cell with
 * no viable outgoing edge in any of the eight directions (isolated by its
 * neighbours' constraints) reads as `'blocked'`: nothing can actually move
 * through it, however clear the cell itself is.
 */
export function buildTraversabilityMap(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  eligibility: NodeEligibility,
  profile: TerrainAccessProfile,
  weights: CostWeights = DEFAULT_COST_WEIGHTS,
): TraversabilityMapCell[] {
  const n = grid.cols * grid.rows;
  const out: TraversabilityMapCell[] = new Array(n);
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const i = row * grid.cols + col;
      if (grid.valid[i] === 0) { out[i] = { state: 'unknown', bestMultiplier: null }; continue; }
      if (eligibility.blocked[i] === 1) { out[i] = { state: 'blocked', bestMultiplier: null }; continue; }

      let best = Number.POSITIVE_INFINITY;
      for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
        const c = col + dx;
        const r = row + dy;
        if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
        const j = r * grid.cols + c;
        if (eligibility.blocked[j] === 1) continue;
        const cost = edgeCost(grid, features, profile, i, j, dx, dy, weights);
        if (cost == null) continue;
        const distance = Math.hypot(dx * grid.cellMetresX, dy * grid.cellMetresY);
        const multiplier = distance > 0 ? cost / distance - 1 : 0;
        if (multiplier < best) best = multiplier;
      }

      if (!Number.isFinite(best)) { out[i] = { state: 'blocked', bestMultiplier: null }; continue; }
      const state: MapCellState =
        best <= MAP_COST_BUCKETS.low ? 'low-cost' : best <= MAP_COST_BUCKETS.moderate ? 'moderate-cost' : 'high-cost';
      out[i] = { state, bestMultiplier: best };
    }
  }
  return out;
}

/** One reason line for the why-not inspector. */
export interface WhyNotReason {
  readonly reason: BlockReason;
  /** A reader-facing sentence, e.g. "cross slope 18.2° > limit 15°". Degrees
   * are used here — and only here — because the why-not inspector is meant
   * to be read by a person; the model itself stays in tangents throughout. */
  readonly detail: string;
}

/** The result of inspecting one cell (§12.11). */
export interface WhyNotResult {
  readonly eligible: boolean;
  /** `'unknown'` when the blocking reason is missing/weak evidence rather
   * than an exceeded geometric limit — the prompt's UNKNOWN/WITHHELD case. */
  readonly category: 'eligible' | 'blocked' | 'unknown';
  readonly reasons: readonly WhyNotReason[];
}

const UNKNOWN_REASONS: ReadonlySet<NodeBlockReason> = new Set(['no-data', 'low-confidence']);

const tangentToDeg = (t: number): string => ((Math.atan(t) * 180) / Math.PI).toFixed(1);

/** Inspect one cell: why it is (or is not) part of the eligible network. */
export function whyNotEligible(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  eligibility: NodeEligibility,
  profile: TerrainAccessProfile,
  index: number,
): WhyNotResult {
  const nodeReason = eligibility.reason[index];
  if (eligibility.blocked[index] === 1 && nodeReason) {
    const category = UNKNOWN_REASONS.has(nodeReason) ? 'unknown' : 'blocked';
    return { eligible: false, category, reasons: [{ reason: nodeReason, detail: nodeDetail(grid, features, profile, index, nodeReason) }] };
  }

  const row = (index / grid.cols) | 0;
  const col = index - row * grid.cols;
  let anyViable = false;
  let closestMiss: WhyNotReason | null = null;
  let closestMargin = Number.POSITIVE_INFINITY;

  for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
    const c = col + dx;
    const r = row + dy;
    if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
    const j = r * grid.cols + c;
    if (eligibility.blocked[j] === 1) continue;
    const evalr = evaluateEdge(grid, features, profile, index, j, dx, dy);
    if (!evalr.blocked) { anyViable = true; break; }
    const margin =
      evalr.reason === 'step-height' ? evalr.stepM - profile.maxStepHeight
      : evalr.reason === 'longitudinal-grade' ? evalr.longitudinalGrade - profile.maxLongitudinalGrade
      : evalr.crossSlope - profile.maxCrossSlope;
    if (margin < closestMargin) {
      closestMargin = margin;
      closestMiss = { reason: evalr.reason as EdgeBlockReason, detail: edgeDetail(evalr, profile) };
    }
  }

  if (anyViable) return { eligible: true, category: 'eligible', reasons: [] };
  return {
    eligible: false,
    category: 'blocked',
    reasons: closestMiss ? [closestMiss] : [{ reason: 'no-data', detail: 'no in-bounds eligible neighbour to move to or from' }],
  };
}

function nodeDetail(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  profile: TerrainAccessProfile,
  index: number,
  reason: NodeBlockReason,
): string {
  switch (reason) {
    case 'no-data': return 'no elevation is known at this cell';
    case 'outside-roi': return 'outside the declared region of interest';
    case 'low-confidence':
      return `terrain support ${grid.confidence[index].toFixed(0)} < required ${profile.minimumTerrainConfidence.toFixed(0)}`;
    case 'ruggedness':
      return `ruggedness ${features.vrm[index].toFixed(3)} > limit ${(profile.maxRuggedness ?? 0).toFixed(3)}`;
    case 'obstruction': return 'above-ground return evidence exceeds the declared threshold';
    case 'vehicle-width': return 'too close to a blocked cell for the declared vehicle width to clear';
  }
}

function edgeDetail(evalr: EdgeEvaluation, profile: TerrainAccessProfile): string {
  switch (evalr.reason) {
    case 'step-height': return `step ${evalr.stepM.toFixed(3)} m > limit ${profile.maxStepHeight.toFixed(3)} m`;
    case 'longitudinal-grade':
      return `longitudinal grade ${tangentToDeg(evalr.longitudinalGrade)}° > limit ${tangentToDeg(profile.maxLongitudinalGrade)}°`;
    case 'cross-slope':
      return `cross slope ${tangentToDeg(evalr.crossSlope)}° > limit ${tangentToDeg(profile.maxCrossSlope)}°`;
    default: return 'blocked';
  }
}
