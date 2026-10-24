/**
 * traversabilityCost.ts — hard eligibility and soft cost over a terrain-access
 * grid, per §12.6 of the governing prompt.
 *
 * ── NODE CONSTRAINTS VS. EDGE CONSTRAINTS ───────────────────────────────────
 * The hard-block list mixes two different kinds of fact:
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
 * Grade enters the cost once, through the longitudinal term. The step term
 * reads the move's step as `localStep.ts` defines it, the part of its rise
 * the slope on either side does not explain, so a smooth slope adds nothing
 * to it; the grade limit is the only limit on slope.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { hornSlopeAspect, synthesisedNeighbourMask } from '../../terrain/ground/terrainDerivatives';
import { computeVRM } from '../../terrain/complexity/vectorRuggedness';
import { computeLocalStep, computeOrthogonalSteps, edgeRise, moveStep, type OrthogonalSteps } from './localStep';
import { classifyObstruction, type ObstructionState } from './obstacleEvidence';
import { diagonalSweepClear, dilateBlocked } from './footprintClearance';
import { directionalSlope, gradientField, headingUnit, type GradientField } from './directionalGrade';
import {
  TERRAIN_ACCESS_NEIGHBOURS,
  resolveEvidenceGapPolicy,
  type BlockReason,
  type EdgeBlockReason,
  type NodeBlockReason,
  type TerrainAccessGrid,
  type TerrainAccessProfile,
} from './terrainAccessTypes';

/** The 3×3 (1-cell-radius) window Horn slope, VRM and the local relief
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
  /** Local relief: the largest raw height difference in each cell's 3×3 footprint, metres. Reported, never gated. */
  readonly localStep: Float32Array;
  /** The step of every orthogonal move (`computeOrthogonalSteps`), read by `moveStep` for each move and corner path. */
  readonly orthogonalSteps: OrthogonalSteps;
  readonly obstruction: readonly ObstructionState[];
  /**
   * 1 where the cell's Horn window used a synthesised neighbour (the grid's
   * outer ring, or a void beside it), so its slope and aspect are an
   * estimate; 0 where all nine values were read from the grid, and at an
   * invalid cell. Computed on the same masked heights the slope is, by
   * `synthesisedNeighbourMask` (`terrainDerivatives.ts`).
   */
  readonly derivativeSynthesised: Uint8Array;
  /**
   * Why {@link derivativeSynthesised} flagged a cell: 0 where it did not,
   * {@link DERIVATIVE_CAUSE_BOUNDARY} where the window leaves the grid or
   * touches NoData connected to the grid edge (the survey's outer boundary),
   * {@link DERIVATIVE_CAUSE_HOLE} where it touches only interior NoData holes.
   */
  readonly derivativeSupportCause: Uint8Array;
}

/** {@link TerrainAccessFeatures.derivativeSupportCause}: window extrapolated at the outer boundary. */
export const DERIVATIVE_CAUSE_BOUNDARY = 1;
/** {@link TerrainAccessFeatures.derivativeSupportCause}: centre substituted beside an interior NoData hole. */
export const DERIVATIVE_CAUSE_HOLE = 2;

/**
 * Split a synthesised-neighbour `mask` by cause. NoData reachable from the
 * grid edge through NoData (8-connected) is the survey's outer boundary; any
 * other NoData is an interior hole. A flagged cell whose window leaves the
 * grid or touches boundary NoData is {@link DERIVATIVE_CAUSE_BOUNDARY}, even
 * when it also touches a hole; otherwise {@link DERIVATIVE_CAUSE_HOLE}.
 */
export function derivativeSupportCause(z: Float32Array, mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const n = cols * rows;
  const cause = new Uint8Array(n);
  const outer = new Uint8Array(n);
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    const edge = row === 0 || col === 0 || row === rows - 1 || col === cols - 1;
    if (edge && !Number.isFinite(z[i])) { outer[i] = 1; stack.push(i); }
  }
  while (stack.length > 0) {
    const i = stack.pop() as number;
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const j = r * cols + c;
        if (outer[j] === 0 && !Number.isFinite(z[j])) { outer[j] = 1; stack.push(j); }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (mask[i] === 0) continue;
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    let boundary = row === 0 || col === 0 || row === rows - 1 || col === cols - 1;
    for (let dr = -1; dr <= 1 && !boundary; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (outer[(row + dr) * cols + col + dc] === 1) { boundary = true; break; }
      }
    }
    cause[i] = boundary ? DERIVATIVE_CAUSE_BOUNDARY : DERIVATIVE_CAUSE_HOLE;
  }
  return cause;
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
  const orthogonalSteps = computeOrthogonalSteps(grid, gradient);
  const obstruction = classifyObstruction(grid, profile.obstacleHeightThreshold);
  const derivativeSynthesised = synthesisedNeighbourMask(maskedZ, grid.cols, grid.rows);
  const supportCause = derivativeSupportCause(maskedZ, derivativeSynthesised, grid.cols, grid.rows);
  return {
    slope, aspect, gradient, vrm: vrmResult.vrm, localStep, orthogonalSteps, obstruction, derivativeSynthesised,
    derivativeSupportCause: supportCause,
  };
}

/** Per-cell node eligibility: blocked flag + the reason, before width clearance. */
export interface NodeEligibility {
  readonly blocked: Uint8Array;
  readonly reason: readonly (NodeBlockReason | null)[];
}

/** True when the 3×3 window around `index` (clipped to the grid) holds a flagged cell. */
export function windowHoldsFlagged(mask: Uint8Array, cols: number, rows: number, index: number): boolean {
  const row = Math.floor(index / cols);
  const col = index - row * cols;
  for (let r = Math.max(0, row - 1); r <= Math.min(rows - 1, row + 1); r++) {
    for (let c = Math.max(0, col - 1); c <= Math.min(cols - 1, col + 1); c++) {
      if (mask[r * cols + c] === 1) return true;
    }
  }
  return false;
}

/**
 * Direction-independent eligibility: NoData, ROI, support, ruggedness,
 * obstruction, then, under the conservative evidence policy, a cell with no
 * above-ground return while an obstruction limit is evaluated, a cell whose
 * slope used a synthesised neighbour, and, while a ruggedness limit is
 * evaluated, a cell whose 3×3 VRM window holds such a cell (its VRM reads
 * that slope). So a route found under conservative reads every limit it
 * applies from fully supported values. Does not yet account for vehicle
 * width — see {@link applyWidthClearance}.
 */
export function nodeEligibility(grid: TerrainAccessGrid, features: TerrainAccessFeatures, profile: TerrainAccessProfile): NodeEligibility {
  const n = grid.cols * grid.rows;
  const blocked = new Uint8Array(n);
  const reason: (NodeBlockReason | null)[] = new Array(n).fill(null);
  const conservative = resolveEvidenceGapPolicy(profile) === 'conservative';
  const obstructionEvaluated = profile.obstacleHeightThreshold != null && grid.heightAboveGround != null;

  for (let i = 0; i < n; i++) {
    if (grid.valid[i] === 0) { blocked[i] = 1; reason[i] = 'no-data'; continue; }
    if (grid.allowed?.[i] === 0) { blocked[i] = 1; reason[i] = 'outside-roi'; continue; }
    if (grid.confidence[i] < profile.minimumTerrainConfidence && profile.unknownPolicy === 'block') {
      blocked[i] = 1; reason[i] = 'low-confidence'; continue;
    }
    if (profile.maxRuggedness != null) {
      const v = features.vrm[i];
      if (Number.isFinite(v) && v > profile.maxRuggedness) { blocked[i] = 1; reason[i] = 'ruggedness'; continue; }
    }
    if (features.obstruction[i] === 'obstructed') { blocked[i] = 1; reason[i] = 'obstruction'; continue; }
    if (!conservative) continue;
    if (obstructionEvaluated && features.obstruction[i] === 'not-evaluated') {
      blocked[i] = 1; reason[i] = 'obstruction-unknown'; continue;
    }
    if (features.derivativeSynthesised[i] === 1
      || (profile.maxRuggedness != null && windowHoldsFlagged(features.derivativeSynthesised, grid.cols, grid.rows, i))) {
      blocked[i] = 1; reason[i] = 'derivative-support';
    }
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

/** A cell blocked for one of the declared node reasons (not merely for width). */
function supportBlocked(eligibility: NodeEligibility, index: number): boolean {
  return eligibility.blocked[index] === 1 && eligibility.reason[index] !== 'vehicle-width';
}

/** Per-eligibility memo of the diagonal sweep check, keyed by width. Each
 * diagonal is stored once, from its upper cell: index·2 + (dx === 1 ? 0 : 1);
 * 0 = not computed, 1 = clear, 2 = refused. */
const sweepMemo = new WeakMap<NodeEligibility, { width: number; state: Uint8Array }>();

/**
 * THE edge predicate every Terrain Access consumer shares (A*, the
 * traversability map, the why-not inspector): may the centreline move from
 * `fromIndex` by raster offset (dx, dy) at all? False when the destination is
 * off the grid or node-blocked (post width-clearance), and, for a diagonal,
 * when the move would cut the corner of an unsupported cell or sweep the
 * declared width over unsupported area mid-move (see `footprintClearance.ts`).
 * Says nothing about grade, cross slope or step — those are
 * {@link evaluateEdge}'s, and apply only to moves this accepts.
 */
export function transitionAllowed(
  grid: Pick<TerrainAccessGrid, 'cols' | 'rows' | 'cellMetresX' | 'cellMetresY'>,
  eligibility: NodeEligibility,
  profile: Pick<TerrainAccessProfile, 'vehicleWidth'>,
  fromIndex: number,
  dx: number,
  dy: number,
): boolean {
  const { cols, rows } = grid;
  const row = Math.floor(fromIndex / cols);
  const col = fromIndex - row * cols;
  const c = col + dx;
  const r = row + dy;
  if (c < 0 || c >= cols || r < 0 || r >= rows) return false;
  if (eligibility.blocked[r * cols + c] === 1) return false;
  if (dx === 0 || dy === 0) return true;

  // Canonical form: every diagonal stored once, from its upper cell, heading down.
  const top = dy === 1 ? fromIndex : r * cols + c;
  const dir = dy === 1 ? dx : -dx;
  let memo = sweepMemo.get(eligibility);
  if (!memo || memo.width !== profile.vehicleWidth || memo.state.length !== cols * rows * 2) {
    memo = { width: profile.vehicleWidth, state: new Uint8Array(cols * rows * 2) };
    sweepMemo.set(eligibility, memo);
  }
  const slot = top * 2 + (dir === 1 ? 0 : 1);
  if (memo.state[slot] === 0) {
    const clear = diagonalSweepClear(
      (i) => supportBlocked(eligibility, i), cols, rows, grid.cellMetresX, grid.cellMetresY,
      profile.vehicleWidth, top, dir, 1,
    );
    memo.state[slot] = clear ? 1 : 2;
  }
  return memo.state[slot] === 1;
}

/** The pure geometry of one directed move — no profile, no blocking decision. */
export interface EdgeGeometry {
  readonly distanceM: number;
  readonly longitudinalGrade: number;
  readonly crossSlope: number;
  /**
   * The move's step, metres: the part of its rise the terrain on either side
   * does not explain, and for a diagonal the easier path through its corner
   * cells (`moveStep`, `localStep.ts`). Not the rise itself. NaN when either
   * endpoint has no elevation.
   */
  readonly stepM: number;
}

/**
 * The geometry of the directed move `from → to` along raster offset
 * `(dx, dy)`: physical distance, longitudinal grade, cross slope and the
 * move's step. Independent of any profile, so a caller that only wants the
 * numbers — `routeDiagnostics.ts`, a UI inspector — is not required to
 * fabricate one.
 *
 * Longitudinal grade is the edge's conservative, direction-symmetric grade:
 * the largest of the Horn gradient projected on the heading at `from`, the
 * same projection at `to`, and the edge's own rise over run
 * (|z(to) − z(from)| / distanceM). Using the from-cell gradient alone let a
 * move out of a V-valley floor (zero gradient there) read as level although
 * the edge itself climbs steeply, and made `a → b` and `b → a` disagree.
 * Cross slope is the larger perpendicular Horn component of the two
 * endpoints. The step is `moveStep` (`localStep.ts`): the part of the rise
 * the terrain on either side of the move does not explain, and for a
 * diagonal also the easier path through its corner cells. All three are
 * symmetric under reversing the move.
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
  const atFrom = directionalSlope(
    { east: features.gradient.east[fromIndex], north: features.gradient.north[fromIndex] }, heading,
  );
  const atTo = directionalSlope(
    { east: features.gradient.east[toIndex], north: features.gradient.north[toIndex] }, heading,
  );
  const stepM = moveStep(grid, features.gradient, fromIndex, dx, dy, features.orthogonalSteps);
  const riseM = edgeRise(grid, fromIndex, toIndex);
  const distanceM = Math.hypot(dx * grid.cellMetresX, dy * grid.cellMetresY);
  const edgeGrade = Number.isFinite(riseM) && distanceM > 0 ? riseM / distanceM : 0;
  const longitudinalGrade = Math.max(atFrom.longitudinalGrade, atTo.longitudinalGrade, edgeGrade);
  const crossSlope = Math.max(atFrom.crossSlope, atTo.crossSlope);
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

/** The names of the {@link CostWeights} terms, in declaration order. */
export const COST_WEIGHT_TERMS: readonly (keyof CostWeights)[] = Object.freeze([
  'longitudinal', 'cross', 'ruggedness', 'step', 'support',
]);

/**
 * The weight terms that are not a finite number ≥ 0, each with its value;
 * empty when the weights are usable. A negative or non-finite weight would
 * let an edge cost fall below its planimetric length (or become NaN), so the
 * A* heuristic would no longer be admissible.
 */
export function invalidCostWeights(weights: CostWeights): readonly string[] {
  const out: string[] = [];
  for (const term of COST_WEIGHT_TERMS) {
    const v = (weights as unknown as Record<string, unknown>)[term];
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) out.push(`${term} = ${String(v)}`);
  }
  return out;
}

/** Monotonic utilization: 0 at no use, 1 at (or past) the declared limit.
 * Exported so `routeDiagnostics.ts` reports the same ratio the cost model
 * itself used, rather than a second, silently-divergent computation. */
export function utilization(value: number, limit: number): number {
  if (limit <= 0 || !Number.isFinite(value)) return 0;
  const x = value / limit;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
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
        if (!transitionAllowed(grid, eligibility, profile, i, dx, dy)) continue;
        const j = (row + dy) * grid.cols + col + dx;
        const cost = edgeCost(grid, features, profile, i, j, dx, dy, weights);
        if (cost == null) continue;
        const distance = Math.hypot(dx * grid.cellMetresX, dy * grid.cellMetresY);
        const multiplier = distance > 0 ? cost / distance - 1 : 0;
        if (multiplier < best) best = multiplier;
      }

      if (!Number.isFinite(best)) { out[i] = { state: 'blocked', bestMultiplier: null }; continue; }
      let state: MapCellState;
      if (best <= MAP_COST_BUCKETS.low) state = 'low-cost';
      else if (best <= MAP_COST_BUCKETS.moderate) state = 'moderate-cost';
      else state = 'high-cost';
      out[i] = { state, bestMultiplier: best };
    }
  }
  return out;
}

/** Why a move out of a closed area is not taken: a declared reason, or a diagonal refused at a corner. */
export type ClosedMoveReason = BlockReason | 'corner';

/** The connected area one endpoint can reach, and why every move out of it is closed. */
export interface ClosedArea {
  /** Which endpoint the area was grown from. */
  readonly seed: 'start' | 'goal';
  /** Eligible cells reachable from that endpoint, itself included. */
  readonly cells: number;
  /**
   * Moves from a cell in the area to an in-grid cell outside it, by the
   * reason each is closed: the destination's node reason, an edge limit
   * (`evaluateEdge`'s first reason), or `'corner'` for a diagonal the shared
   * transition rule refuses at an unsupported corner or for its swept width.
   * Moves off the grid are not counted: the survey edge is not a limit.
   */
  readonly closedMoves: ReadonlyMap<ClosedMoveReason, number>;
}

/**
 * When no route joins `startIndex` and `endIndex`, grow the area each can
 * reach over the same moves the search takes, one cell from each in turn,
 * and stop when one is exhausted: that smaller area is the one the limits
 * close, found in work proportional to its size. Then tally why each move out
 * of it is closed. Null when the two endpoints are in fact connected, or
 * either is not an eligible cell.
 */
export function closedAreaBetween(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  eligibility: NodeEligibility,
  profile: TerrainAccessProfile,
  startIndex: number,
  endIndex: number,
): ClosedArea | null {
  const { cols, rows } = grid;
  const n = cols * rows;
  const ok = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n && eligibility.blocked[i] === 0;
  if (!ok(startIndex) || !ok(endIndex) || startIndex === endIndex) return null;
  const label = new Uint8Array(n);
  const queues: number[][] = [[startIndex], [endIndex]];
  const heads = [0, 0];
  label[startIndex] = 1;
  label[endIndex] = 2;
  const opens = (i: number, dx: number, dy: number, j: number): boolean =>
    transitionAllowed(grid, eligibility, profile, i, dx, dy)
    && !evaluateEdge(grid, features, profile, i, j, dx, dy).blocked;

  let done = -1;
  while (done < 0) {
    for (let k = 0; k < 2 && done < 0; k++) {
      if (heads[k] >= queues[k].length) { done = k; break; }
      const i = queues[k][heads[k]++];
      const row = Math.floor(i / cols);
      const col = i - row * cols;
      for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
        const c = col + dx;
        const r = row + dy;
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const j = r * cols + c;
        if (label[j] === k + 1) continue;
        if (!opens(i, dx, dy, j)) continue;
        if (label[j] !== 0) return null; // the other area: the two are connected
        label[j] = k + 1;
        queues[k].push(j);
      }
    }
  }

  const mine = done + 1;
  const closedMoves = new Map<ClosedMoveReason, number>();
  const add = (reason: ClosedMoveReason): void => { closedMoves.set(reason, (closedMoves.get(reason) ?? 0) + 1); };
  for (const i of queues[done]) {
    const row = Math.floor(i / cols);
    const col = i - row * cols;
    for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
      const c = col + dx;
      const r = row + dy;
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const j = r * cols + c;
      if (label[j] === mine) continue;
      if (!transitionAllowed(grid, eligibility, profile, i, dx, dy)) {
        add(eligibility.blocked[j] === 1 ? (eligibility.reason[j] ?? 'no-data') : 'corner');
        continue;
      }
      const reason = evaluateEdge(grid, features, profile, i, j, dx, dy).reason;
      if (reason) add(reason);
    }
  }
  return { seed: done === 0 ? 'start' : 'goal', cells: queues[done].length, closedMoves };
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
   * than an exceeded geometric limit: the UNKNOWN/WITHHELD case. */
  readonly category: 'eligible' | 'blocked' | 'unknown';
  readonly reasons: readonly WhyNotReason[];
}

const UNKNOWN_REASONS: ReadonlySet<NodeBlockReason> = new Set([
  'no-data', 'low-confidence', 'obstruction-unknown', 'derivative-support',
]);

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

  const row = Math.floor(index / grid.cols);
  const col = index - row * grid.cols;
  let anyViable = false;
  let closestMiss: WhyNotReason | null = null;
  let closestMargin = Number.POSITIVE_INFINITY;

  for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
    if (!transitionAllowed(grid, eligibility, profile, index, dx, dy)) continue;
    const j = (row + dy) * grid.cols + col + dx;
    const evalr = evaluateEdge(grid, features, profile, index, j, dx, dy);
    if (!evalr.blocked) { anyViable = true; break; }
    // Step is in metres and grade/cross slope are tangents, so each excess is
    // taken relative to its own limit before they are compared.
    const margin =
      evalr.reason === 'step-height' ? relativeExcess(evalr.stepM, profile.maxStepHeight)
      : evalr.reason === 'longitudinal-grade' ? relativeExcess(evalr.longitudinalGrade, profile.maxLongitudinalGrade)
      : relativeExcess(evalr.crossSlope, profile.maxCrossSlope);
    if (closestMiss == null || margin < closestMargin) {
      closestMargin = margin;
      closestMiss = { reason: evalr.reason as EdgeBlockReason, detail: edgeDetail(evalr, profile) };
    }
  }

  if (anyViable) return { eligible: true, category: 'eligible', reasons: [] };
  return {
    eligible: false,
    category: 'blocked',
    reasons: closestMiss ? [closestMiss] : [{ reason: 'no-data', detail: 'no eligible neighbour can be reached without crossing unsupported terrain' }],
  };
}

/** How far `value` exceeds `limit`, as a fraction of the limit; a zero limit
 * (a step height of 0 m is a valid declaration) makes any excess infinite. */
function relativeExcess(value: number, limit: number): number {
  if (limit > 0) return (value - limit) / limit;
  return value > limit ? Number.POSITIVE_INFINITY : 0;
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
    case 'obstruction-unknown':
      return 'no above-ground return here, so the obstruction limit cannot be checked; the conservative evidence policy blocks it';
    case 'derivative-support':
      if (features.derivativeSynthesised[index] !== 1) {
        return 'ruggedness here reads a neighbour whose slope used a synthesised neighbour (grid edge or void); '
          + 'with a ruggedness limit set, the conservative evidence policy blocks it';
      }
      return 'slope and aspect here were computed with at least one synthesised neighbour (grid edge or void); '
        + 'the conservative evidence policy blocks it';
    case 'vehicle-width':
      return 'the declared vehicle width does not fit between this cell and the nearest unsupported cell or survey edge';
  }
}

function edgeDetail(evalr: EdgeEvaluation, profile: TerrainAccessProfile): string {
  switch (evalr.reason) {
    case 'step-height':
      return `step ${evalr.stepM.toFixed(3)} m (height change the slope on either side does not explain) `
        + `> limit ${profile.maxStepHeight.toFixed(3)} m`;
    case 'longitudinal-grade':
      return `longitudinal grade ${tangentToDeg(evalr.longitudinalGrade)}° > limit ${tangentToDeg(profile.maxLongitudinalGrade)}°`;
    case 'cross-slope':
      return `cross slope ${tangentToDeg(evalr.crossSlope)}° > limit ${tangentToDeg(profile.maxCrossSlope)}°`;
    default: return 'blocked';
  }
}
