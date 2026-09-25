/**
 * coverageGain.ts — `olv.observation.coverage-gain` (docs/observatory/SPEC.md
 * §5.6, OB-GAIN-01..03, OB-GAIN-05). Phase O10.
 *
 * Coverage Gain counts voxels a hypothetical station would newly address. It
 * is not an information-theoretic quantity.
 *
 *   - OB-GAIN-01: {@link ObservationInstrumentModel} is declared by the user
 *     and recorded in full; {@link resolveInstrumentModel} copies a source's
 *     declared parameters for "same as source N". No manufacturer table.
 *   - OB-GAIN-02: {@link generateCandidates} places candidates on a grid of
 *     declared spacing over `SURFACE` voxels whose normal lies within a
 *     declared angle of vertical and whose column above is clear to
 *     instrument height, capped, indexed in grid order.
 *   - OB-GAIN-03: {@link traceCandidateVisibility} traverses planning rays
 *     against the classified field with the ledger's own clip and DDA
 *     (`clipRayToDomain`, `traverseVoxelSteps`); {@link scoreCandidate}
 *     reports every term of `G(c) = Σ w(state)·vis·inc − λ_red·redundant`.
 *   - OB-GAIN-05: {@link planningAuthority} labels planning `preview` when the
 *     field's authority is below `measured`; `NOT_READ` voxels get weight 0
 *     and are counted.
 *
 * Weak `SURFACE` is judged on the two strength components the ledger row
 * carries (`sources`, `consistency`, read with `strength.ts`'s own
 * functions). The incidence term uses `incidence.ts`, the same estimate
 * `olv.observation.strength` uses. The greedy multi-station search is
 * `stationSuggestion.ts` (OB-GAIN-04).
 *
 * Pure and DOM-free (OB-INT-01). Never writes to the ledger rows or the state
 * map it is handed.
 */
import { clipRayToDomain, packVoxelKey, traverseVoxelSteps, unpackVoxelKey, type ObservationDomain, type ObservationLedgerRow } from './ledger';
import { computeConsistency, countStrengthSources } from './strength';
import { incidenceCosine, normalAngleFromVerticalDegrees, type Vec3 } from './incidence';
import type { ObservationState } from './types';

// ---------------------------------------------------------------------------
// OB-GAIN-01 — instrument model
// ---------------------------------------------------------------------------

/**
 * The instrument model a user declares before Coverage Gain runs
 * (OB-GAIN-01). Lengths are in the field's own linear unit.
 */
export interface ObservationInstrumentModel {
  /** Height above the standing surface a candidate station is placed at. */
  readonly heightAboveSurface: number;
  readonly minRange: number;
  readonly maxRange: number;
  /** Total vertical span, centred on the horizon: elevations in [−v/2, +v/2], clamped to [−90, 90]. */
  readonly verticalFieldOfViewDegrees: number;
  /** Angular step used for planning rays, in degrees, in both azimuth and elevation. */
  readonly angularStepDegrees: number;
  /** When set, copies this source's declared parameters instead. */
  readonly sameAsSourceIndex: number | null;
}

/** A source's declared instrument parameters, when it declares any (the "same as source N" input). */
export type DeclaredSourceInstrument = Omit<ObservationInstrumentModel, 'sameAsSourceIndex'>;

/** Throws on a model no planning ray can be built from. */
export function validateInstrumentModel(model: ObservationInstrumentModel): void {
  const finitePositive = (v: number, name: string): void => {
    if (!(v > 0) || !Number.isFinite(v)) throw new Error(`instrument model: ${name} must be a finite number > 0, got ${v}`);
  };
  if (!(model.heightAboveSurface >= 0) || !Number.isFinite(model.heightAboveSurface)) {
    throw new Error(`instrument model: heightAboveSurface must be finite and >= 0, got ${model.heightAboveSurface}`);
  }
  if (!(model.minRange >= 0) || !Number.isFinite(model.minRange)) throw new Error(`instrument model: minRange must be finite and >= 0, got ${model.minRange}`);
  finitePositive(model.maxRange, 'maxRange');
  if (!(model.maxRange > model.minRange)) throw new Error(`instrument model: maxRange (${model.maxRange}) must exceed minRange (${model.minRange})`);
  finitePositive(model.verticalFieldOfViewDegrees, 'verticalFieldOfViewDegrees');
  finitePositive(model.angularStepDegrees, 'angularStepDegrees');
  if (model.angularStepDegrees > 90) throw new Error(`instrument model: angularStepDegrees must be <= 90, got ${model.angularStepDegrees}`);
}

/**
 * Resolves "same as source N": the named source's declared parameters replace
 * the model's own, and `sameAsSourceIndex` is kept so the record says where
 * they came from. Refuses when source N declares none.
 */
export function resolveInstrumentModel(
  model: ObservationInstrumentModel,
  declaredBySource: readonly (DeclaredSourceInstrument | null)[],
): ObservationInstrumentModel {
  if (model.sameAsSourceIndex === null) {
    validateInstrumentModel(model);
    return model;
  }
  const declared = declaredBySource[model.sameAsSourceIndex];
  if (declared === undefined || declared === null) {
    throw new Error(`instrument model: source ${model.sameAsSourceIndex} declares no instrument parameters to copy`);
  }
  const resolved: ObservationInstrumentModel = { ...declared, sameAsSourceIndex: model.sameAsSourceIndex };
  validateInstrumentModel(resolved);
  return resolved;
}

/**
 * Planning ray directions, unit vectors, flat `x,y,z,...`. Azimuth bins are
 * `[i·s, (i+1)·s)` over `[0, 360)` and elevation bins `[lo + j·s, lo + (j+1)·s)`
 * over the vertical field of view; each ray points at its bin centre. When
 * the step divides 45° evenly, every bin centre is an odd multiple of half a
 * step, so no planning ray runs exactly along a grid axis or a 45° diagonal,
 * where a voxel traversal meets an exact tie. Order:
 * elevation bin outer, azimuth bin inner.
 */
export function planningDirections(model: ObservationInstrumentModel): Float64Array {
  validateInstrumentModel(model);
  const step = model.angularStepDegrees;
  const half = Math.min(90, model.verticalFieldOfViewDegrees / 2);
  const lo = -half;
  const azBins = Math.max(1, Math.floor(360 / step));
  const elBins = Math.max(1, Math.floor((2 * half) / step));
  const out = new Float64Array(azBins * elBins * 3);
  const rad = Math.PI / 180;
  let o = 0;
  for (let j = 0; j < elBins; j++) {
    const el = (lo + (j + 0.5) * step) * rad;
    const ce = Math.cos(el);
    const se = Math.sin(el);
    for (let i = 0; i < azBins; i++) {
      const az = (i + 0.5) * step * rad;
      out[o++] = ce * Math.cos(az);
      out[o++] = ce * Math.sin(az);
      out[o++] = se;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// the planning field: a read-only view of the classified ledger
// ---------------------------------------------------------------------------

/**
 * What planning reads: the classified field (`observationField.ts`), the
 * ledger rows behind it (`ledger.ts`) and fitted normals (`incidence.ts`).
 * A key absent from `stateByKey` reads as `UNADDRESSED`.
 */
export interface PlanningField {
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
  readonly stateByKey: ReadonlyMap<number, ObservationState>;
  readonly rowByKey: ReadonlyMap<number, Pick<ObservationLedgerRow, 'counters' | 'perSource'>>;
  readonly normalByKey: ReadonlyMap<number, Vec3>;
}

function stateOf(field: PlanningField, key: number): ObservationState {
  return field.stateByKey.get(key) ?? 'UNADDRESSED';
}

// ---------------------------------------------------------------------------
// OB-GAIN-03 — declared weights and parameters
// ---------------------------------------------------------------------------

/** OB-GAIN-03's per-state weights `w`; every state not named here weighs 0. */
export interface GainStateWeights {
  readonly SHADOWED: number;
  readonly UNADDRESSED: number;
  readonly NO_RETURN_PATH: number;
  readonly CONFLICT: number;
  /** Weak `SURFACE`: strength components below declared floors. */
  readonly WEAK_SURFACE: number;
}

/** OB-GAIN-03's declared default per-state weights. */
export const DEFAULT_GAIN_STATE_WEIGHTS: GainStateWeights = Object.freeze({
  SHADOWED: 1.0,
  UNADDRESSED: 1.0,
  NO_RETURN_PATH: 0.25,
  CONFLICT: 0.5,
  WEAK_SURFACE: 0.5,
});

/** Floors below which a `SURFACE` voxel is weak: fewer than `sources` hitting sources, or hit fraction below `consistency`. */
export interface WeakSurfaceFloors {
  readonly sources: number;
  readonly consistency: number;
}

export interface CoverageGainParameters {
  readonly stateWeights: GainStateWeights;
  /** λ_red, the penalty per already-strong voxel revisited. */
  readonly redundancyWeight: number;
  readonly weakSurfaceFloors: WeakSurfaceFloors;
  /** `PARTIAL` blocks a planning ray when its hit fraction is ≥ this (SPEC: `p_solid`). */
  readonly p_solid: number;
  /** Candidate grid spacing, in the field's linear unit (OB-GAIN-02). */
  readonly candidateSpacing: number;
  /** Maximum candidates kept, in index order (OB-GAIN-02). */
  readonly candidateCap: number;
  /** A standing surface's normal must lie within this many degrees of vertical. */
  readonly maxNormalAngleFromVerticalDegrees: number;
}

/** Declared defaults apart from `p_solid` and `candidateSpacing`, which come from the run. */
export const DEFAULT_COVERAGE_GAIN_PARAMETERS: Omit<CoverageGainParameters, 'p_solid' | 'candidateSpacing'> = Object.freeze({
  stateWeights: DEFAULT_GAIN_STATE_WEIGHTS,
  redundancyWeight: 0.1,
  weakSurfaceFloors: Object.freeze({ sources: 2, consistency: 0.9 }),
  candidateCap: 24,
  maxNormalAngleFromVerticalDegrees: 20,
});

/** True when a `SURFACE` voxel's row falls below either declared floor. A `SURFACE` voxel with no row is weak. */
export function isWeakSurface(row: Pick<ObservationLedgerRow, 'counters' | 'perSource'> | undefined, floors: WeakSurfaceFloors): boolean {
  if (row === undefined) return true;
  if (countStrengthSources(row) < floors.sources) return true;
  const f = computeConsistency(row);
  return !(f >= floors.consistency);
}

/** Whether a voxel stops a planning ray: `SURFACE` always, `PARTIAL` when its hit fraction is ≥ `p_solid`. */
export function blocksPlanningRay(state: ObservationState, row: Pick<ObservationLedgerRow, 'counters'> | undefined, pSolid: number): boolean {
  if (state === 'SURFACE') return true;
  if (state !== 'PARTIAL' || row === undefined) return false;
  const n = row.counters.hit + row.counters.pass;
  return n > 0 && row.counters.hit / n >= pSolid;
}

// ---------------------------------------------------------------------------
// OB-GAIN-02 — candidates
// ---------------------------------------------------------------------------

export interface CoverageCandidate {
  readonly candidateIndex: number;
  /** World position: the standing voxel's centre in X and Y, its centre plus instrument height in Z. */
  readonly position: Vec3;
  /** The `SURFACE` voxel the candidate stands on, or `null` for a candidate given by position. */
  readonly standingVoxelKey: number | null;
}

export interface CandidateGeneration {
  readonly candidates: readonly CoverageCandidate[];
  /** Grid cells that held a qualifying standing voxel, before the cap. */
  readonly qualifyingCount: number;
  readonly cap: number;
  /** Qualifying cells dropped by the cap. */
  readonly droppedByCap: number;
}

/**
 * OB-GAIN-02. Each `SURFACE` voxel with a fitted normal within the declared
 * angle of vertical, and no voxel that would stop a planning ray
 * ({@link blocksPlanningRay}) in its column from the voxel above it up to
 * instrument height (cells above the domain top are not examined),
 * qualifies. Qualifying voxels are bucketed into square XY cells of
 * `candidateSpacing`; each cell keeps the voxel whose centre is closest to the
 * cell centre (ties to the lower key). Cells are ordered by (row, column)
 * ascending. Over the cap, an evenly strided subset is kept (cell positions
 * `floor(i · qualifying / cap)`), so the cap thins the grid instead of
 * cutting off one side of it. Kept cells are indexed from 0 in order.
 */
export function generateCandidates(
  field: PlanningField,
  model: ObservationInstrumentModel,
  params: Pick<CoverageGainParameters, 'candidateSpacing' | 'candidateCap' | 'maxNormalAngleFromVerticalDegrees' | 'p_solid'>,
): CandidateGeneration {
  validateInstrumentModel(model);
  if (!(params.candidateSpacing > 0) || !Number.isFinite(params.candidateSpacing)) {
    throw new Error(`generateCandidates: candidateSpacing must be a finite number > 0, got ${params.candidateSpacing}`);
  }
  if (!Number.isInteger(params.candidateCap) || params.candidateCap < 0) {
    throw new Error(`generateCandidates: candidateCap must be a non-negative integer, got ${params.candidateCap}`);
  }
  const { domain, voxelEdge: h, grid } = field;
  const columnCells = Math.ceil(model.heightAboveSurface / h);
  const cellsX = Math.max(1, Math.ceil((domain.max[0] - domain.min[0]) / params.candidateSpacing));

  const best = new Map<number, { key: number; dist2: number; center: Vec3 }>();
  const keys = [...field.stateByKey.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    if (field.stateByKey.get(key) !== 'SURFACE') continue;
    const normal = field.normalByKey.get(key);
    if (normal === undefined || normalAngleFromVerticalDegrees(normal) > params.maxNormalAngleFromVerticalDegrees) continue;
    const { ix, iy, iz } = unpackVoxelKey(key, grid.nx, grid.ny);
    let clear = true;
    for (let dz = 1; dz <= columnCells && iz + dz < grid.nz; dz++) {
      const above = packVoxelKey(ix, iy, iz + dz, grid.nx, grid.ny);
      if (blocksPlanningRay(stateOf(field, above), field.rowByKey.get(above), params.p_solid)) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;
    const center: Vec3 = [domain.min[0] + (ix + 0.5) * h, domain.min[1] + (iy + 0.5) * h, domain.min[2] + (iz + 0.5) * h];
    const cx = Math.floor((center[0] - domain.min[0]) / params.candidateSpacing);
    const cy = Math.floor((center[1] - domain.min[1]) / params.candidateSpacing);
    const cell = cy * cellsX + cx;
    const ccx = domain.min[0] + (cx + 0.5) * params.candidateSpacing;
    const ccy = domain.min[1] + (cy + 0.5) * params.candidateSpacing;
    const dist2 = (center[0] - ccx) ** 2 + (center[1] - ccy) ** 2;
    const prev = best.get(cell);
    if (prev === undefined || dist2 < prev.dist2) best.set(cell, { key, dist2, center });
  }

  const cells = [...best.keys()].sort((a, b) => a - b);
  const kept = cells.length <= params.candidateCap
    ? cells
    : Array.from({ length: params.candidateCap }, (_, i) => cells[Math.floor((i * cells.length) / params.candidateCap)]!);
  const candidates = kept.map((cell, candidateIndex): CoverageCandidate => {
    const b = best.get(cell)!;
    return {
      candidateIndex,
      position: [b.center[0], b.center[1], b.center[2] + model.heightAboveSurface],
      standingVoxelKey: b.key,
    };
  });
  return { candidates, qualifyingCount: cells.length, cap: params.candidateCap, droppedByCap: cells.length - kept.length };
}

// ---------------------------------------------------------------------------
// OB-GAIN-03 — visibility and terms
// ---------------------------------------------------------------------------

/** The voxels one candidate's planning rays reach, ascending by key, each with its incidence term. */
export interface CandidateVisibility {
  readonly candidateIndex: number;
  readonly keys: Float64Array;
  /** `inc_c(v)`: the largest `|cos i|` over the rays reaching `v` when `v` has a fitted normal, otherwise 1. */
  readonly incidence: Float64Array;
  readonly rayCount: number;
}

/**
 * Walks every planning ray from `position` over `[minRange, maxRange]`,
 * clipped to the domain. Each traversed voxel is visible; a blocking voxel
 * (see {@link blocksPlanningRay}) is visible and ends the ray.
 */
export function traceCandidateVisibility(
  field: PlanningField,
  candidateIndex: number,
  position: Vec3,
  model: ObservationInstrumentModel,
  pSolid: number,
  directions: Float64Array = planningDirections(model),
): CandidateVisibility {
  const { domain, voxelEdge, grid } = field;
  const best = new Map<number, number>();
  const rayCount = directions.length / 3;
  for (let r = 0; r < rayCount; r++) {
    const dir: Vec3 = [directions[r * 3]!, directions[r * 3 + 1]!, directions[r * 3 + 2]!];
    const clip = clipRayToDomain(position, dir, model.minRange, model.maxRange, domain);
    if (clip === null || !(clip.tExit > clip.tEntry)) continue;
    const steps = traverseVoxelSteps(position, dir, clip.tEntry, clip.tExit, domain, voxelEdge);
    for (const s of steps) {
      if (s.ix < 0 || s.iy < 0 || s.iz < 0 || s.ix >= grid.nx || s.iy >= grid.ny || s.iz >= grid.nz) continue;
      const key = packVoxelKey(s.ix, s.iy, s.iz, grid.nx, grid.ny);
      const normal = field.normalByKey.get(key);
      const inc = normal === undefined ? 1 : incidenceCosine(dir, normal);
      const prev = best.get(key);
      if (prev === undefined || inc > prev) best.set(key, inc);
      if (blocksPlanningRay(stateOf(field, key), field.rowByKey.get(key), pSolid)) break;
    }
  }
  const sorted = [...best.keys()].sort((a, b) => a - b);
  const keys = Float64Array.from(sorted);
  const incidence = new Float64Array(sorted.length);
  sorted.forEach((k, i) => { incidence[i] = best.get(k)!; });
  return { candidateIndex, keys, incidence, rayCount };
}

/** Per-state tallies of visible voxels that carried weight (planned-covered voxels excluded). */
export interface GainStateTally {
  readonly SHADOWED: number;
  readonly UNADDRESSED: number;
  readonly NO_RETURN_PATH: number;
  readonly CONFLICT: number;
  readonly WEAK_SURFACE: number;
}

/**
 * OB-GAIN-03's per-candidate terms, every one reported separately:
 * `gain = weightedVisibilitySum − redundantPenalty`,
 * `redundantPenalty = redundancyWeight · redundantCount`.
 */
export interface CandidateGainTerms {
  readonly candidateIndex: number;
  readonly visibleVoxelCount: number;
  readonly weightedVisibilitySum: number;
  readonly weightedCounts: GainStateTally;
  /** Already-strong voxels revisited: strong `SURFACE` plus voxels a previously picked station would cover. */
  readonly redundantCount: number;
  readonly redundantPenalty: number;
  readonly gain: number;
  /** Visible `NOT_READ` voxels, weight 0 (OB-GAIN-05). */
  readonly excludedVoxelCount: number;
}

type GainCategory = keyof GainStateWeights | 'STRONG_SURFACE' | 'NOT_READ' | null;

function gainCategory(field: PlanningField, key: number, floors: WeakSurfaceFloors): GainCategory {
  const state = stateOf(field, key);
  switch (state) {
    case 'SHADOWED':
    case 'UNADDRESSED':
    case 'NO_RETURN_PATH':
    case 'CONFLICT':
    case 'NOT_READ':
      return state;
    case 'SURFACE':
      return isWeakSurface(field.rowByKey.get(key), floors) ? 'WEAK_SURFACE' : 'STRONG_SURFACE';
    default:
      return null;
  }
}

/**
 * The terms for one candidate. `covered` holds the keys a previously picked
 * station would see (the hypothetical ledger copy, OB-GAIN-04): such a voxel
 * carries no weight and counts as redundant. Sums run in ascending key order.
 */
export function scoreCandidate(
  field: PlanningField,
  visibility: CandidateVisibility,
  params: Pick<CoverageGainParameters, 'stateWeights' | 'redundancyWeight' | 'weakSurfaceFloors'>,
  covered: ReadonlySet<number> = new Set(),
): CandidateGainTerms {
  const tally = { SHADOWED: 0, UNADDRESSED: 0, NO_RETURN_PATH: 0, CONFLICT: 0, WEAK_SURFACE: 0 };
  let weightedVisibilitySum = 0;
  let redundantCount = 0;
  let excludedVoxelCount = 0;
  for (let i = 0; i < visibility.keys.length; i++) {
    const key = visibility.keys[i]!;
    const category = gainCategory(field, key, params.weakSurfaceFloors);
    if (category === 'NOT_READ') {
      excludedVoxelCount++;
      continue;
    }
    if (covered.has(key) || category === 'STRONG_SURFACE') {
      redundantCount++;
      continue;
    }
    if (category === null) continue;
    tally[category]++;
    weightedVisibilitySum += params.stateWeights[category] * visibility.incidence[i]!;
  }
  const redundantPenalty = params.redundancyWeight * redundantCount;
  return {
    candidateIndex: visibility.candidateIndex,
    visibleVoxelCount: visibility.keys.length,
    weightedVisibilitySum,
    weightedCounts: tally,
    redundantCount,
    redundantPenalty,
    gain: weightedVisibilitySum - redundantPenalty,
    excludedVoxelCount,
  };
}

// ---------------------------------------------------------------------------
// OB-GAIN-05 — basis and authority
// ---------------------------------------------------------------------------

export type PlanningAuthority = 'measured' | 'preview';

export interface PlanningAuthorityVerdict {
  readonly authority: PlanningAuthority;
  /** Why the authority is below `measured`; empty when it is `measured`. */
  readonly reasons: readonly string[];
}

/**
 * OB-GAIN-05 with OB-INV-03/04: planning is `measured` only over a field with
 * basis `full`, no `NOT_READ` voxel, and every station origin `DECLARED`.
 * Anything else is `preview`, with each reason named.
 */
export function planningAuthority(
  basis: string,
  stations: readonly { readonly id: string; readonly originStatus: string }[],
  notReadVoxelCount: number,
): PlanningAuthorityVerdict {
  const reasons: string[] = [];
  if (basis !== 'full') reasons.push(`basis ${basis}`);
  if (notReadVoxelCount > 0) reasons.push(`${notReadVoxelCount} voxel(s) not read in this load`);
  for (const s of stations) {
    if (s.originStatus === 'ASSUMED') reasons.push(`assumed origin: ${s.id}`);
    else if (s.originStatus !== 'DECLARED') reasons.push(`reconstructed origin: ${s.id}`);
  }
  return { authority: reasons.length === 0 ? 'measured' : 'preview', reasons };
}
