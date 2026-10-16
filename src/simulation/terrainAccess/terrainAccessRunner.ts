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

import type { AboveGroundSurface, HorizontalScale, InterpolatedPolicy } from './dtmTerrainAccessGrid';
import {
  buildTraversabilityMap,
  type CostWeights,
  type NodeEligibility,
  type TerrainAccessFeatures,
  type TraversabilityMapCell,
} from './traversabilityCost';
import { prepareTerrainAccessRun } from './terrainAccessPrepare';
import { aStarTerrain, type AStarOutcome } from './aStarTerrain';
import { computeRouteDiagnostics, type RouteDiagnostics } from './routeDiagnostics';
import { terrainAccessResultDigest } from './terrainAccessDigest';
import {
  derivativeEstimateStatement, obstructionEstimateStatement, type DerivativeEstimatedConstraint,
} from './terrainAccessExplain';
import { basisLimitations } from '../simulationInputBasis';
import { sealRunRecord, type FieldSimulationRunRecord } from '../simulationRunRecord';
import { methodRef } from '../../science/methodRegistry';
import {
  resolveEvidenceGapPolicy, type EvidenceGapPolicy, type TerrainAccessGrid, type TerrainAccessProfile,
} from './terrainAccessTypes';
import type { SimulationInputBasis } from '../simulationInputBasis';
import type { DtmGrid } from '../../terrain/ground/cellConfidence';

/** Why a run could not happen (§30). */
export type TerrainAccessRefusalCode =
  | 'NO_DTM'
  | 'UNITS_UNRESOLVED'
  | 'INVALID_PROFILE'
  | 'START_BLOCKED'
  | 'END_BLOCKED'
  | 'NO_ROUTE'
  | 'INSUFFICIENT_EVIDENCE'
  | 'TOO_LARGE'
  /** The profile sets an above-ground obstruction limit and no aligned above-ground surface exists. */
  | 'OBSTRUCTION_EVIDENCE_UNAVAILABLE'
  /** A supplied above-ground surface does not cover the same cells as the terrain. */
  | 'SURFACE_MISALIGNED'
  /** A supplied above-ground surface was built with a different terrain surface. */
  | 'SURFACE_STALE'
  /** A declared region-of-interest mask does not fit the terrain grid. */
  | 'INVALID_ROI';

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
  /** Above-ground surface, when available; optional per §12.4, and checked for alignment. */
  readonly dsm?: AboveGroundSurface | null;
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
  /** Which digest `analysisInputDigest` is; see `SimulationSource.analysisInputDigestScheme`. */
  readonly analysisInputDigestScheme?: string;
  /** The surface-only digest the input digest wraps, when there is one. */
  readonly surfaceDigest?: string | null;
  /** Digest of the terrain-core method that built the input; see `SimulationSource`.
   * Optional and defaults to null — most callers have no terrain-core descriptor
   * to report and null is the honest default, never a fabricated one. */
  readonly terrainCoreDigest?: string | null;
  readonly build: string;
  readonly id: string;
  readonly generatedAt: string;
  readonly processingManifestHead: string | null;
}

/**
 * Whether each limit a profile can declare was applied to this run:
 * `evaluated` (applied to every cell), `disabled` (the profile left it off),
 * `unavailable` (the evidence it needs is absent, so it could not have been
 * applied — a profile that asks for it anyway is refused before a run),
 * `recorded-not-enforced` (kept in the record, not used by eligibility),
 * `disclosed` (computed for every cell and reported, not used to block), or
 * `estimated` (applied, but what it compared is not fully supported). The
 * slope-derived limits read `estimated` when a route cell's slope, or for
 * ruggedness its VRM window, used a substituted Horn neighbour; only the
 * exploratory evidence policy allows such cells, since conservative blocks
 * them. The above-ground obstruction limit reads `estimated` when its surface
 * was built from a sample of the scan (under either policy), or when route
 * cells had no above-ground return (exploratory only).
 */
export type TerrainAccessConstraintStatus =
  | 'evaluated' | 'disabled' | 'unavailable' | 'recorded-not-enforced' | 'disclosed' | 'estimated';

/** The route figures {@link terrainAccessConstraintStatus} reads to decide `estimated`. */
export type DerivativeRouteSupport = Pick<RouteDiagnostics,
  | 'derivativeSynthesisedRouteCells' | 'derivativeSynthesisedBoundaryRouteCells'
  | 'derivativeSynthesisedHoleRouteCells' | 'ruggednessSynthesisedRouteCells'>;

/**
 * The per-constraint status a run record carries under `result.constraints`.
 * Without `route` (no route yet) every slope-derived limit reads `evaluated`.
 * With it, longitudinal grade and cross slope read `estimated` when any route
 * cell's slope used a substituted neighbour, and an evaluated ruggedness limit
 * reads `estimated` when any route cell's VRM window holds such a cell. Step
 * height is a raw height difference between two cells and is never estimated.
 * An evaluated obstruction limit reads `estimated` when the surface basis is
 * a sample, or when `obstructionUnevaluatedRouteCells` is above zero. The
 * minimum terrain confidence reads `evaluated` under the `block` unknown
 * policy, where a cell below it is blocked, and `disclosed` under `penalize`,
 * where it only sets the reported share of route cells below it.
 */
export function terrainAccessConstraintStatus(
  profile: TerrainAccessProfile,
  grid: TerrainAccessGrid,
  route: DerivativeRouteSupport | null = null,
  obstructionUnevaluatedRouteCells = 0,
): Readonly<Record<string, TerrainAccessConstraintStatus>> {
  const slopeStatus: TerrainAccessConstraintStatus = (route?.derivativeSynthesisedRouteCells ?? 0) > 0
    ? 'estimated' : 'evaluated';
  const ruggednessStatus: TerrainAccessConstraintStatus = (route?.ruggednessSynthesisedRouteCells ?? 0) > 0
    ? 'estimated' : 'evaluated';
  return {
    longitudinalGrade: slopeStatus,
    crossSlope: slopeStatus,
    stepHeight: 'evaluated',
    // Only the 'block' policy turns the minimum into a hard block; under
    // 'penalize' it changes neither eligibility nor cost and only sets the
    // reported share of route cells below it.
    minimumTerrainConfidence: profile.unknownPolicy === 'block' ? 'evaluated' : 'disclosed',
    vehicleWidth: 'evaluated',
    ruggedness: profile.maxRuggedness == null ? 'disabled' : ruggednessStatus,
    vehicleLength: profile.vehicleLength == null ? 'disabled' : 'recorded-not-enforced',
    aboveGroundObstruction: obstructionStatus(profile, grid, obstructionUnevaluatedRouteCells),
    derivativeSupport: resolveEvidenceGapPolicy(profile) === 'conservative' ? 'evaluated' : 'disclosed',
  };
}

function obstructionStatus(
  profile: TerrainAccessProfile,
  grid: TerrainAccessGrid,
  unevaluatedRouteCells: number,
): TerrainAccessConstraintStatus {
  if (grid.heightAboveGround == null) return 'unavailable';
  if (profile.obstacleHeightThreshold == null) return 'disabled';
  return grid.aboveGroundBasis?.sampled === true || unevaluatedRouteCells > 0 ? 'estimated' : 'evaluated';
}

/**
 * The sentence for each constraint {@link terrainAccessConstraintStatus}
 * marked `estimated`, keyed like `result.constraints`; empty when none is.
 */
export function constraintEstimateStatements(
  constraints: Readonly<Record<string, TerrainAccessConstraintStatus>>,
  route: DerivativeRouteSupport & Pick<RouteDiagnostics, 'cellCount'>,
  grid: Pick<TerrainAccessGrid, 'aboveGroundBasis'> | null = null,
  obstructionUnevaluatedRouteCells = 0,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const order: readonly DerivativeEstimatedConstraint[] = ['crossSlope', 'longitudinalGrade', 'ruggedness'];
  for (const key of order) {
    if (constraints[key] !== 'estimated') continue;
    out[key] = derivativeEstimateStatement(key, {
      routeCells: key === 'ruggedness' ? route.ruggednessSynthesisedRouteCells : route.derivativeSynthesisedRouteCells,
      boundaryRouteCells: route.derivativeSynthesisedBoundaryRouteCells,
      holeRouteCells: route.derivativeSynthesisedHoleRouteCells,
    });
  }
  if (constraints.aboveGroundObstruction === 'estimated') {
    const basis = grid?.aboveGroundBasis;
    out.aboveGroundObstruction = obstructionEstimateStatement({
      sample: basis?.sampled ? basis : null,
      unevaluatedRouteCells: obstructionUnevaluatedRouteCells,
      routeCells: route.cellCount,
    });
  }
  return out;
}

/** What the run does with a cell whose evidence has a gap, per gap, as the record states it. */
export interface EvidenceGapTreatment {
  readonly evidenceGapPolicy: EvidenceGapPolicy;
  /** A cell whose slope used a synthesised neighbour. */
  readonly derivativeSupportPolicy: 'block' | 'disclose';
  /** A cell with no above-ground return; null when no obstruction limit is evaluated. */
  readonly unknownObstructionPolicy: 'block' | 'disclose' | null;
}

/** The evidence-gap treatment a run with `profile` over `grid` applies. */
export function evidenceGapTreatment(profile: TerrainAccessProfile, grid: TerrainAccessGrid): EvidenceGapTreatment {
  const policy = resolveEvidenceGapPolicy(profile);
  const action = policy === 'conservative' ? 'block' : 'disclose';
  const obstructionEvaluated = profile.obstacleHeightThreshold != null && grid.heightAboveGround != null;
  return {
    evidenceGapPolicy: policy,
    derivativeSupportPolicy: action,
    unknownObstructionPolicy: obstructionEvaluated ? action : null,
  };
}

/** The model a run record names, at the version the registry declares. */
export const TERRAIN_ACCESS_MODEL = Object.freeze(methodRef('olv.simulation.terrain-access.astar'));

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
  const prepared = prepareTerrainAccessRun(dtm, scale, profile, params);
  if (!prepared.ok) return prepared;
  const { grid, features, eligibility, basis, gridWarnings, weights } = prepared;

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
  // Cells on the route where an applied obstruction limit had no
  // above-ground return to read: not known to be clear, so the limit is an
  // estimate there.
  const obstructionApplied = grid.heightAboveGround != null && profile.obstacleHeightThreshold != null;
  const obstructionUnevaluatedRouteCells = obstructionApplied
    ? search.path.filter((i) => features.obstruction[i] === 'not-evaluated').length
    : null;
  const constraints = terrainAccessConstraintStatus(profile, grid, diagnostics, obstructionUnevaluatedRouteCells ?? 0);
  const constraintEstimates = constraintEstimateStatements(
    constraints, diagnostics, grid, obstructionUnevaluatedRouteCells ?? 0,
  );
  const gaps = evidenceGapTreatment(profile, grid);
  let derivativeSynthesisedGridCells = 0;
  for (let i = 0; i < features.derivativeSynthesised.length; i++) {
    if (grid.valid[i] === 1 && features.derivativeSynthesised[i] === 1) derivativeSynthesisedGridCells++;
  }
  let gapBlockedCells = 0;
  for (const r of eligibility.reason) if (r === 'derivative-support' || r === 'obstruction-unknown') gapBlockedCells++;
  const map = buildTraversabilityMap(grid, features, eligibility, profile, weights);
  const resultDigest = terrainAccessResultDigest(grid.cols, grid.rows, eligibility.blocked, search.path, search.cost);

  const limitations = [
    ...basisLimitations(basis, 'terrain-access'),
    ...gridWarnings,
    ...modelLimitations(profile, diagnostics),
    ...evidenceGapLimitations(gaps, diagnostics, gapBlockedCells),
    ...Object.values(constraintEstimates),
  ];

  const record = sealRunRecord({
    schemaVersion: 2,
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
      ...(identity.analysisInputDigestScheme !== undefined
        ? { analysisInputDigestScheme: identity.analysisInputDigestScheme } : {}),
      ...(identity.surfaceDigest !== undefined ? { surfaceDigest: identity.surfaceDigest } : {}),
      basis,
    },
    model: { ...TERRAIN_ACCESS_MODEL },
    methods: TERRAIN_ACCESS_METHODS,
    parameters: {
      profile,
      interpolated: params.interpolated,
      maxCells: params.maxCells,
      weights,
      startIndex,
      endIndex,
      evidenceGapPolicy: gaps.evidenceGapPolicy,
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
      fractionMeasured: diagnostics.fractionMeasured,
      fractionInterpolated: diagnostics.fractionInterpolated,
      fractionBelowProfileConfidence: diagnostics.fractionBelowProfileConfidence,
      profileMinimumTerrainConfidence: diagnostics.profileMinimumTerrainConfidence,
      constraints,
      evidenceGapPolicy: gaps.evidenceGapPolicy,
      derivativeSupportPolicy: gaps.derivativeSupportPolicy,
      unknownObstructionPolicy: gaps.unknownObstructionPolicy,
      derivativeSynthesisedGridCells,
      derivativeSynthesisedRouteCells: diagnostics.derivativeSynthesisedRouteCells,
      fractionDerivativeSynthesised: diagnostics.fractionDerivativeSynthesised,
      derivativeSynthesisedBoundaryRouteCells: diagnostics.derivativeSynthesisedBoundaryRouteCells,
      derivativeSynthesisedHoleRouteCells: diagnostics.derivativeSynthesisedHoleRouteCells,
      ruggednessSynthesisedRouteCells: diagnostics.ruggednessSynthesisedRouteCells,
      constraintEstimates,
      evidenceGapBlockedCells: gapBlockedCells,
      obstructionUnevaluatedRouteCells,
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

  const below = diagnostics.fractionBelowProfileConfidence;
  if (below != null && below > 0) {
    out.push(
      `The route crosses cells below the profile's minimum terrain confidence under the '${profile.unknownPolicy}' policy: `
      + `${(below * 100).toFixed(0)}% of route cells are below `
      + `the declared minimum terrain confidence (${profile.minimumTerrainConfidence}). Those cells were `
      + 'not excluded: the minimum is reported here, not enforced, and the cost\'s support term rises '
      + 'as terrain confidence falls whatever the minimum is.',
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

/**
 * What the evidence-gap policy obliges the result to disclose: under
 * exploratory, the route cells whose slope used a synthesised neighbour;
 * under conservative, how many cells the policy blocked. The obstruction
 * cells with no return are disclosed by {@link obstructionEstimateStatement}.
 */
function evidenceGapLimitations(
  gaps: EvidenceGapTreatment,
  diagnostics: RouteDiagnostics,
  gapBlockedCells: number,
): readonly string[] {
  if (gaps.evidenceGapPolicy === 'conservative') {
    if (gapBlockedCells === 0) return [];
    return [
      `The conservative evidence policy blocked ${gapBlockedCells} cells whose slope used a synthesised `
      + 'neighbour (the grid\'s outer ring or beside a void), or, when the ruggedness limit is evaluated, '
      + 'whose ruggedness window holds such a cell, or, when the obstruction limit is evaluated, '
      + 'that have no above-ground return.',
    ];
  }
  const flagged = diagnostics.derivativeSynthesisedRouteCells;
  if (flagged === 0) return [];
  const pct = Math.round((100 * flagged) / diagnostics.cellCount);
  return [
    `${flagged} of ${diagnostics.cellCount} route cells (${pct}%) have a slope and aspect computed with at least `
    + 'one synthesised neighbour (the grid\'s outer ring, or beside a void), so their grade and cross slope are '
    + 'estimates. The exploratory evidence policy allowed them.',
  ];
}
