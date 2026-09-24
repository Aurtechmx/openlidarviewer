/**
 * terrainAccessRunner.ts — one Terrain Access run, from a terrain product to a
 * sealed record. Mirrors `flowPulse/flowPulseRunner.ts`'s shape: a DTM and a
 * set of parameters in, either a result with a sealed record or a typed
 * refusal out, never a partially-filled result.
 *
 * ── WHY AN UNRESOLVED SCALE REFUSES HERE BUT NOT IN FLOW PULSE ──────────────
 * `runFlowPulse` still runs with an unresolved horizontal scale, because flow
 * DIRECTION survives not knowing what a unit is worth in metres — only the
 * contributing-area FIGURE is withheld. Terrain Access has no such split:
 * `maxLongitudinalGrade`/`maxCrossSlope` are compared against a gradient
 * computed from the grid's metric cell size, and `maxStepHeight`/
 * `vehicleWidth` are declared in metres outright. An unresolved scale would
 * make every eligibility decision, not just one reported figure, depend on a
 * guessed unit — exactly the case §15 of the governing prompt names:
 * "slope/step constraints cannot be interpreted safely → refuse route
 * simulation." So `UNITS_UNRESOLVED` fires on `!scale.resolved` outright, and
 * separately on an unresolved vertical-unit-to-metres factor, which the same
 * reasoning applies to (a foot-denominated DTM read as metres would misstate
 * every grade by ~3.28×).
 *
 * ── INSUFFICIENT_EVIDENCE ────────────────────────────────────────────────────
 * Two distinct conditions both surface as this one refusal code, because both
 * describe the same fact to a reader: nothing in the grid is fit to route
 * over. Either the grid carries no cell with an elevation at all, or every
 * cell that does fails the declared eligibility gates (most often
 * `minimumTerrainConfidence` set above anything the terrain achieves). Unlike
 * `START_BLOCKED`/`END_BLOCKED`, which are about the two chosen endpoints,
 * this is about the grid as a whole.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * No `CANCELLED` refusal exists here: this is a synchronous pure function,
 * and cancellation belongs to whatever async wrapper the later UI phase adds
 * (§18's Snapshot → Await → Revalidate → Commit). `STALE_INPUT` is declared
 * in the refusal union for completeness with §30 but is never produced by
 * this module either, for the same reason: staleness is a property of two
 * calls over time, which only a caller holding both can detect.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { terrainDtmToAccessGrid, type HorizontalScale, type InterpolatedPolicy } from './dtmTerrainAccessGrid';
import {
  DEFAULT_COST_WEIGHTS,
  applyWidthClearance,
  buildTraversabilityMap,
  nodeEligibility,
  prepareTerrainAccessFeatures,
  type CostWeights,
  type NodeEligibility,
  type TerrainAccessFeatures,
  type TraversabilityMapCell,
} from './traversabilityCost';
import { aStarTerrain, type AStarOutcome } from './aStarTerrain';
import { computeRouteDiagnostics, type RouteDiagnostics } from './routeDiagnostics';
import { terrainAccessResultDigest } from './terrainAccessDigest';
import { basisLimitations } from '../simulationInputBasis';
import { sealRunRecord, type FieldSimulationRunRecord } from '../simulationRunRecord';
import { validateProfile, type TerrainAccessGrid, type TerrainAccessProfile } from './terrainAccessTypes';
import type { SimulationInputBasis } from '../simulationInputBasis';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../../terrain/surface/buildDsm';

/** Why a run could not happen (§30). */
export type TerrainAccessRefusalCode =
  | 'NO_DTM'
  | 'UNITS_UNRESOLVED'
  | 'INVALID_PROFILE'
  | 'START_BLOCKED'
  | 'END_BLOCKED'
  | 'NO_ROUTE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'TOO_LARGE';

/** A run that did not happen, and the precondition that stopped it. */
export interface TerrainAccessRefusal {
  readonly ok: false;
  readonly code: TerrainAccessRefusalCode;
  /** One sentence for a reader, naming what would make the run possible. */
  readonly reason: string;
}

/** What a run was asked to do. */
export interface TerrainAccessParams {
  readonly interpolated: InterpolatedPolicy;
  readonly maxCells: number;
  readonly withheldExcluded: boolean | null;
  /** Above-ground surface, when available; optional per §12.4. */
  readonly dsm?: SurfaceGrid | null;
  /** Region-of-interest mask, when the caller has declared one. */
  readonly roi?: Uint8Array | null;
  readonly weights?: CostWeights;
}

/** Defaults a panel can offer, all of them declared rather than hidden. */
export const TERRAIN_ACCESS_DEFAULTS: TerrainAccessParams = Object.freeze({
  interpolated: 'route',
  maxCells: 1_000_000,
  withheldExcluded: null,
});

/** What a completed run measured. */
export interface TerrainAccessResult {
  readonly ok: true;
  readonly grid: TerrainAccessGrid;
  readonly features: TerrainAccessFeatures;
  readonly eligibility: NodeEligibility;
  readonly outcome: Extract<AStarOutcome, 'FOUND'>;
  readonly path: readonly number[];
  readonly cost: number;
  readonly explored: number;
  readonly diagnostics: RouteDiagnostics;
  readonly map: readonly TraversabilityMapCell[];
  readonly basis: SimulationInputBasis;
  readonly limitations: readonly string[];
  readonly record: FieldSimulationRunRecord;
}

/** Identity of the run's inputs, supplied by the caller rather than invented. */
export interface TerrainAccessRunIdentity {
  readonly layerId: string | null;
  readonly filename: string | null;
  readonly sourceDigest: string | null;
  readonly analysisInputDigest: string;
  /** Digest of the terrain-core method that built the input; see `SimulationSource`.
   * Optional and defaults to null — most callers have no terrain-core descriptor
   * to report and null is the honest default, never a fabricated one. */
  readonly terrainCoreDigest?: string | null;
  readonly build: string;
  readonly id: string;
  readonly generatedAt: string;
  readonly processingManifestHead: string | null;
}

/** The registered methods a run uses, in the order it uses them. */
export const TERRAIN_ACCESS_METHODS: readonly string[] = Object.freeze([
  'olv.simulation.terrain-access.local-step',
  'olv.simulation.terrain-access.directional-grade',
  'olv.simulation.terrain-access.cost-map',
  'olv.simulation.terrain-access.astar',
]);

/**
 * Run one Terrain Access simulation from `startIndex` to `endIndex` over
 * `dtm`. Order is fixed and is the processing manifest: build the grid,
 * prepare terrain features (slope/aspect, VRM, local step, obstruction),
 * compute hard eligibility, apply width clearance, then search.
 */
export function runTerrainAccess(
  dtm: DtmGrid | null,
  scale: HorizontalScale,
  profile: TerrainAccessProfile,
  startIndex: number,
  endIndex: number,
  params: TerrainAccessParams,
  identity: TerrainAccessRunIdentity,
): TerrainAccessResult | TerrainAccessRefusal {
  if (!dtm) {
    return {
      ok: false, code: 'NO_DTM',
      reason: 'No terrain surface is available. Run terrain analysis on a loaded scan first.',
    };
  }

  if (!scale.resolved) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The horizontal scale is unresolved, so longitudinal grade, cross slope and step '
        + 'height cannot be interpreted safely. Assign a CRS that resolves the horizontal scale.',
    };
  }
  if (scale.isGeographic && !Number.isFinite(scale.latitudeDeg ?? Number.NaN)) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The terrain is in geographic degrees and its latitude is unknown, so the '
        + 'east–west length of a cell cannot be derived. Assign a CRS that resolves the latitude.',
    };
  }
  const verticalUnitToMetres = dtm.verticalUnitToMetres;
  if (verticalUnitToMetres == null || !(verticalUnitToMetres > 0)) {
    return {
      ok: false, code: 'UNITS_UNRESOLVED',
      reason: 'The vertical unit is unresolved, so an elevation difference cannot be interpreted '
        + 'in metres and grade/step constraints cannot be interpreted safely.',
    };
  }

  const profileProblems = validateProfile(profile);
  if (profileProblems.length > 0) {
    return {
      ok: false, code: 'INVALID_PROFILE',
      reason: `The mobility profile is not usable: ${profileProblems.map((p) => `${p.field} ${p.reason}`).join('; ')}.`,
    };
  }

  const cells = dtm.cols * dtm.rows;
  if (cells > params.maxCells) {
    return {
      ok: false, code: 'TOO_LARGE',
      reason: `The terrain grid holds ${cells} cells, above the ${params.maxCells} this run allows. `
        + 'Analyse a smaller extent or a coarser cell size.',
    };
  }

  const { grid, basis, warnings: gridWarnings } = terrainDtmToAccessGrid(dtm, scale, {
    interpolated: params.interpolated,
    withheldExcluded: params.withheldExcluded,
    dsm: params.dsm,
    roi: params.roi,
  });

  if (basis.measuredCells === 0) {
    return {
      ok: false, code: 'INSUFFICIENT_EVIDENCE',
      reason: params.interpolated === 'block'
        ? 'No cell carries a measured elevation. Allow interpolated cells, or analyse terrain with more ground returns.'
        : 'No cell in the terrain grid carries an elevation.',
    };
  }

  const features = prepareTerrainAccessFeatures(grid, profile);
  const eligibilityBeforeWidth = nodeEligibility(grid, features, profile);
  const eligibility = applyWidthClearance(grid, eligibilityBeforeWidth, profile);

  let eligibleCount = 0;
  for (const b of eligibility.blocked) if (b === 0) eligibleCount++;
  if (eligibleCount === 0) {
    return {
      ok: false, code: 'INSUFFICIENT_EVIDENCE',
      reason: 'No cell in the terrain grid is eligible under the declared mobility profile. '
        + 'Relax the profile\'s limits, or analyse terrain with better support.',
    };
  }

  const weights = params.weights ?? DEFAULT_COST_WEIGHTS;
  const search = aStarTerrain(grid, features, eligibility, profile, startIndex, endIndex, weights);

  if (search.outcome !== 'FOUND') {
    const reasonByOutcome: Record<Exclude<AStarOutcome, 'FOUND'>, string> = {
      START_BLOCKED: 'The start cell is not eligible under the declared mobility profile.',
      END_BLOCKED: 'The end cell is not eligible under the declared mobility profile.',
      NO_ROUTE: 'No eligible path connects the start and end cells under the declared mobility profile.',
    };
    return {
      ok: false,
      code: search.outcome,
      reason: reasonByOutcome[search.outcome],
    };
  }

  const diagnostics = computeRouteDiagnostics(grid, features, search.path, weights, profile);
  const map = buildTraversabilityMap(grid, features, eligibility, profile, weights);
  const resultDigest = terrainAccessResultDigest(grid.cols, grid.rows, eligibility.blocked, search.path, search.cost);

  const limitations = [
    ...basisLimitations(basis, 'terrain-access'),
    ...gridWarnings,
    ...modelLimitations(profile, diagnostics),
  ];

  const record = sealRunRecord({
    schemaVersion: 1,
    id: identity.id,
    generatedAt: identity.generatedAt,
    build: identity.build,
    kind: 'terrain-access',
    source: {
      layerId: identity.layerId,
      filename: identity.filename,
      sourceDigest: identity.sourceDigest,
      analysisInputDigest: identity.analysisInputDigest,
      terrainCoreDigest: identity.terrainCoreDigest ?? null,
      basis,
    },
    model: { id: 'olv.simulation.terrain-access.astar', version: 1 },
    methods: TERRAIN_ACCESS_METHODS,
    parameters: {
      profile,
      interpolated: params.interpolated,
      maxCells: params.maxCells,
      weights,
      startIndex,
      endIndex,
    },
    result: {
      cellCount: diagnostics.cellCount,
      horizontalLengthM: diagnostics.horizontalLengthM,
      length3dM: diagnostics.length3dM,
      totalAscentM: diagnostics.totalAscentM,
      totalDescentM: diagnostics.totalDescentM,
      maxLongitudinalGrade: diagnostics.maxLongitudinalGrade,
      maxCrossSlope: diagnostics.maxCrossSlope,
      maxEdgeStepM: diagnostics.maxEdgeStepM,
      maxLocalReliefM: diagnostics.maxLocalReliefM,
      maxVrm: diagnostics.maxVrm,
      minTerrainConfidence: diagnostics.minTerrainConfidence,
      cost: search.cost,
      exploredCells: search.explored,
      resultDigest,
    },
    limitations,
    processingManifestHead: identity.processingManifestHead,
  });

  return {
    ok: true,
    grid,
    features,
    eligibility,
    outcome: 'FOUND',
    path: search.path,
    cost: search.cost as number,
    explored: search.explored,
    diagnostics,
    map,
    basis,
    limitations,
    record,
  };
}

/**
 * What the model itself obliges the result to disclose — never a safety or
 * passability guarantee (§22), and the weak-evidence exposure §12.6/TA-7
 * requires when `unknownPolicy: 'penalize'` let the route use low-confidence
 * cells rather than refusing them. Metric distances are always reportable
 * here (unlike Flow Pulse): `UNITS_UNRESOLVED` already refused an unresolved
 * horizontal scale before a result could exist.
 */
function modelLimitations(
  profile: TerrainAccessProfile,
  diagnostics: RouteDiagnostics,
): readonly string[] {
  const out: string[] = [
    'A geometry-based traversability screening over the declared terrain and mobility limits. '
    + 'It is not a safety assessment, a guaranteed-passable route, or a vehicle dynamics '
    + 'simulation: soil strength, traction, tire/track-soil interaction, rollover, weather and '
    + 'vegetation compliance are not modelled.',
  ];

  if (profile.unknownPolicy === 'penalize'
    && diagnostics.fractionLowConfidenceOrEdgeRisk != null
    && diagnostics.fractionLowConfidenceOrEdgeRisk > 0) {
    out.push(
      `The route crosses low-confidence/edge-risk cells under the 'penalize' policy: `
      + `${(diagnostics.fractionLowConfidenceOrEdgeRisk * 100).toFixed(0)}% of route cells are below `
      + `the declared minimum terrain confidence (${profile.minimumTerrainConfidence}). Those cells were `
      + 'not excluded, only cost-penalized.',
    );
  }

  if (profile.vehicleLength != null) {
    out.push(
      `Vehicle length (${profile.vehicleLength} m) is recorded but not enforced: eligibility uses `
      + 'width-only clearance, not full swept-body orientation collision.',
    );
  }

  return out;
}
