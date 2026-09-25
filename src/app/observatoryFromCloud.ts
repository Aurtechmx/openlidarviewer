/**
 * observatoryFromCloud.ts — the O9 coordinator's own glue between a loaded
 * `PointCloud` and the pure `src/observation` kernel (O1-O8).
 *
 * `src/observation` is DOM/three-free by construction (OB-INT-01) and never
 * reads a `PointCloud`; something has to turn a live scan's resident points
 * and its `AcquisitionStations` sidecar (OB-INT-02) into the kernel's own ray
 * and ledger inputs. This module is that translation, and nothing else: it
 * calls `buildUnstructuredSourceRays`, `runObservationLedger`,
 * `classifyObservationField`, `computeShadowFrontier` and
 * `sealObservationRunRecord` exactly as `tests/observatoryFixturesO5EndToEnd.test.ts`
 * already exercises them, over the scan's own declared stations.
 *
 * BASIS IS RESIDENT-ONLY, ALWAYS, HERE. `buildUnstructuredSourceRays` builds
 * one ray per RESIDENT record (no per-cell no-return state, no fitted
 * angular step) — the same "resident-only" `TerrainCoverageMode` bucket the
 * terrain module already uses for a streamed-but-not-fully-walked source
 * (`src/terrain/TerrainContracts.ts`). This module never claims `full`
 * coverage or `measured` authority for anything it produces; the run record's
 * `source.basis` always reads `'resident-only'`, and every station's angular
 * domain is declared unbounded (full sphere, no range limit) because an
 * unstructured build carries no narrower declared domain to test against —
 * a documented, not fabricated, limitation (SPEC §1.3/§9.3 "no-return
 * path" and "resident-only" wording).
 *
 * A source with no declared stations (`PointCloudOptions.acquisitionStations`
 * absent or empty) is INELIGIBLE, reported as such rather than silently
 * skipped: SPEC's own eligibility table (§1.3) requires an honest per-format
 * statement, not a default run over an invented single station.
 */
import { sha256, canonicalize } from '../render/measure/auditLog';
import type { AcquisitionStation, AcquisitionStationSet } from '../model/AcquisitionStations';
import { buildUnstructuredSourceRays } from '../observation/rays';
import {
  domainGrid,
  packVoxelKey,
  runObservationLedger,
  type ObservationDomain,
  type ObservationLedgerRow,
  type ObservationLedgerRunResult,
  type RayPartitionChunkEntry,
} from '../observation/ledger';
import { classifyObservationField, type ObservationFieldStation, type ObservationStateCounts } from '../observation/observationField';
import { computeShadowFrontier, type ShadowFrontierResult } from '../observation/shadowFrontier';
import { sealObservationRunRecord, type ObservationRunRecord } from '../observation/runRecord';
import type { ObservationParameters, ObservationState } from '../observation/types';
import { VoxelMomentAccumulator } from '../observation/incidence';
import { DEFAULT_COVERAGE_GAIN_PARAMETERS, type ObservationInstrumentModel, type PlanningField } from '../observation/coverageGain';
import { planStations, type StationPlanningResult } from '../observation/stationSuggestion';

/** OB-ST-THRESHOLDS.protocol.json's preregistered constants, plus the resident-only fallback for the two range-dependent terms (no fitted angular step exists for an unstructured build; see the module header). */
export const OBSERVATORY_PARAMETERS: Omit<ObservationParameters, 'tau_abs' | 'tau_rel'> = {
  p_solid: 0.9,
  p_empty: 0.1,
  n_min: 5,
};

/** A cloud shaped just enough for this module — never the concrete `PointCloud` class, so a test can supply a plain object. */
export interface ObservatoryCloudInput {
  readonly positions: Float32Array;
  readonly sourceOrigin: readonly [number, number, number];
  readonly acquisitionStations?: AcquisitionStationSet;
  bounds(): { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
}

export type ObservatoryEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: 'no-stations' | 'empty-domain' };

/** SPEC §1.3's eligibility test for this coordinator: declared stations, and a non-degenerate bounds box. */
export function observatoryEligibility(cloud: ObservatoryCloudInput): ObservatoryEligibility {
  const stations = cloud.acquisitionStations?.stations ?? [];
  if (stations.length === 0) return { eligible: false, reason: 'no-stations' };
  const b = cloud.bounds();
  if (!(b.max[0] > b.min[0]) || !(b.max[1] > b.min[1]) || !(b.max[2] > b.min[2])) {
    return { eligible: false, reason: 'empty-domain' };
  }
  return { eligible: true };
}

export interface ObservatoryRunOptions {
  /** Domain voxel edge in the cloud's own local unit (usually metres). */
  readonly voxelEdge: number;
  readonly declaredStepBudget: number;
  readonly filename: string | null;
  readonly metresPerUnit: number | null;
  readonly buildTag: string;
  /** Coverage Gain planning (OB-GAIN-01/04). Omitted fields take {@link defaultPlanningModel}'s values; `false` skips planning. */
  readonly planning?: false | {
    readonly model?: Partial<ObservationInstrumentModel>;
    readonly stationCount?: number;
    readonly candidateSpacing?: number;
    readonly candidateCap?: number;
  };
}

/** Suggested stations per greedy pass when the run does not declare a count. */
export const DEFAULT_SUGGESTED_STATION_COUNT = 2;

/**
 * The instrument model planning uses when the user declares none: 1.5 m
 * above the standing surface, 0.5 m minimum range, the domain diagonal as
 * maximum range, a full vertical sweep and a 5° planning step. Metre values
 * are converted to the source unit when it is known; when it is not, they are
 * read as source units (OB-INV-10) and the record says so.
 */
export function defaultPlanningModel(domain: ObservationDomain, metresPerUnit: number | null): ObservationInstrumentModel {
  const perUnit = metresPerUnit ?? 1;
  const diagonal = Math.hypot(domain.max[0] - domain.min[0], domain.max[1] - domain.min[1], domain.max[2] - domain.min[2]);
  const minRange = 0.5 / perUnit;
  return {
    heightAboveSurface: 1.5 / perUnit,
    minRange,
    maxRange: Math.max(diagonal, minRange * 2),
    verticalFieldOfViewDegrees: 180,
    angularStepDegrees: 5,
    sameAsSourceIndex: null,
  };
}

/**
 * Coverage Gain over the classified field. Surface normals for the incidence
 * term and the standing-surface test come from the resident points of each
 * `SURFACE` voxel (`incidence.ts`). Suggested stations are never added to the
 * ledger or the station list (OB-INV-05).
 */
function planOverField(
  positions: Float32Array,
  sourceOrigin: readonly [number, number, number],
  domain: ObservationDomain,
  voxelEdge: number,
  stateByKey: ReadonlyMap<number, ObservationState>,
  rows: readonly ObservationLedgerRow[],
  stations: readonly AcquisitionStation[],
  options: ObservatoryRunOptions,
): StationPlanningResult | null {
  if (options.planning === false) return null;
  const grid = domainGrid(domain, voxelEdge);
  const moments = new VoxelMomentAccumulator();
  const p = positions;
  const [ox, oy, oz] = sourceOrigin;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const ix = Math.floor((p[i]! + ox - domain.min[0]) / voxelEdge);
    const iy = Math.floor((p[i + 1]! + oy - domain.min[1]) / voxelEdge);
    const iz = Math.floor((p[i + 2]! + oz - domain.min[2]) / voxelEdge);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= grid.nx || iy >= grid.ny || iz >= grid.nz) continue;
    const key = packVoxelKey(ix, iy, iz, grid.nx, grid.ny);
    if (stateByKey.get(key) === 'SURFACE') moments.add(key, p[i]!, p[i + 1]!, p[i + 2]!);
  }
  const rowByKey = new Map(rows.map((r) => [r.key, r] as const));
  const field: PlanningField = { domain, voxelEdge, grid, stateByKey, rowByKey, normalByKey: moments.normals() };
  const model = { ...defaultPlanningModel(domain, options.metresPerUnit), ...(options.planning?.model ?? {}) };
  const horizontal = Math.max(domain.max[0] - domain.min[0], domain.max[1] - domain.min[1]);
  return planStations({
    field,
    model,
    declaredBySource: stations.map(() => null),
    parameters: {
      ...DEFAULT_COVERAGE_GAIN_PARAMETERS,
      candidateCap: options.planning?.candidateCap ?? 16,
      p_solid: OBSERVATORY_PARAMETERS.p_solid,
      candidateSpacing: options.planning?.candidateSpacing ?? Math.max(4 * voxelEdge, horizontal / 6),
    },
    stationCount: options.planning?.stationCount ?? DEFAULT_SUGGESTED_STATION_COUNT,
    basis: 'resident-only',
    stations: stations.map((s) => ({ id: s.id, originStatus: s.originStatus })),
  });
}

export type ObservatoryRunOutcome =
  | {
      readonly status: 'ok';
      readonly record: ObservationRunRecord;
      readonly stateByKey: ReadonlyMap<number, { readonly state: string }>;
      readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
      readonly domain: ObservationDomain;
      readonly voxelEdge: number;
      readonly frontier: ShadowFrontierResult;
      /** The raw ledger rows, kept only so the export bundle (OB-EXP-01) can re-derive `field.bin` without a second traversal. */
      readonly rows: readonly import('../observation/ledger').ObservationLedgerRow[];
      /** Coverage Gain candidates and suggested stations, or `null` when planning was skipped. */
      readonly planning?: StationPlanningResult | null;
    }
  | { readonly status: 'ineligible'; readonly reason: 'no-stations' | 'empty-domain' }
  | { readonly status: 'refused'; readonly reason: ObservationLedgerRunResult extends { status: 'refused'; reason: infer R } ? R : never };

/**
 * Run the whole O1-O8 pipeline over `cloud`'s resident points and declared
 * stations, resident-only basis, unbounded per-station angular domain.
 *
 * Pure with respect to the DOM: reads only the cloud shape above and returns
 * a value; it never touches three.js, the viewer or any panel state. The
 * caller (`observatoryRunner.ts`) owns staleness, cancellation and the
 * overlay.
 */
export function runObservatoryOverCloud(
  cloud: ObservatoryCloudInput,
  options: ObservatoryRunOptions,
): ObservatoryRunOutcome {
  const eligibility = observatoryEligibility(cloud);
  if (!eligibility.eligible) return { status: 'ineligible', reason: eligibility.reason };

  const stations = cloud.acquisitionStations!.stations;
  const bounds = cloud.bounds();
  // `ledger.ts` traverses against each station's own `pose.worldTranslation`
  // (Float64 WORLD frame, `docs/coordinate-precision.md`), so the domain box
  // must be declared in that same frame — `cloud.bounds()` is LOCAL
  // (recentred) coordinates, and `cloud.sourceOrigin` is exactly the
  // world-minus-local offset every point was shifted by at load.
  const domain: ObservationDomain = {
    min: [bounds.min[0] + cloud.sourceOrigin[0], bounds.min[1] + cloud.sourceOrigin[1], bounds.min[2] + cloud.sourceOrigin[2]],
    max: [bounds.max[0] + cloud.sourceOrigin[0], bounds.max[1] + cloud.sourceOrigin[1], bounds.max[2] + cloud.sourceOrigin[2]],
  };
  const tauAbs = options.voxelEdge / 2;
  const tauRel = 0; // resident-only: no fitted angular step to derive it from (module header).

  const positions = cloud.positions;
  const entries: RayPartitionChunkEntry[] = [];
  const stationList: AcquisitionStation[] = [];
  const fieldStations: ObservationFieldStation[] = [];
  stations.forEach((station, sourceIndex) => {
    stationList.push(station);
    const build = buildUnstructuredSourceRays(positions, station, sourceIndex, cloud.sourceOrigin, { kind: 'none' });
    for (const chunk of build.returnedChunks) {
      entries.push({ sourceIndex, chunk, tauAbs, tauRel });
    }
    fieldStations.push({
      sourceIndex,
      origin: station.pose.worldTranslation,
      azimuthDeg: [0, 360],
      elevationDeg: [-90, 90],
    });
  });

  const ledgerResult = runObservationLedger(
    { domain, voxelEdge: options.voxelEdge, stations: stationList, returnedChunks: entries, notReadChunks: [] },
    { declaredStepBudget: options.declaredStepBudget },
  );
  if (ledgerResult.status === 'refused') {
    return { status: 'refused', reason: ledgerResult.reason as never };
  }

  const field = classifyObservationField(domain, options.voxelEdge, ledgerResult.rows, fieldStations, OBSERVATORY_PARAMETERS);
  const stateOnly = new Map<number, ObservationState>();
  for (const [key, decision] of field.stateByKey) stateOnly.set(key, decision.state);
  const frontier = computeShadowFrontier(stateOnly, field.grid, options.voxelEdge, options.metresPerUnit);
  const planning = planOverField(positions, cloud.sourceOrigin, domain, options.voxelEdge, stateOnly, ledgerResult.rows, stationList, options);

  const parameters: ObservationParameters = { ...OBSERVATORY_PARAMETERS, tau_abs: tauAbs, tau_rel: tauRel };
  const record = sealObservationRunRecord({
    schemaVersion: 1,
    id: `obs-${ledgerResult.fieldDigest.slice(0, 12)}`,
    generatedAt: new Date().toISOString(),
    build: options.buildTag,
    source: { filename: options.filename, sourceDigest: sha256(canonicalize(Array.from(positions.subarray(0, Math.min(positions.length, 3000))))), basis: 'resident-only', metresPerUnit: options.metresPerUnit },
    domain,
    voxelEdge: options.voxelEdge,
    stations: stationList.map((s, i) => ({ id: s.id, source: s.source, originStatus: s.originStatus, worldTranslation: s.pose.worldTranslation, sourceIndex: i, tauAbs, tauRel })),
    parameters,
    methods: [
      'olv.observation.rays@1', 'olv.observation.ledger@1', 'olv.observation.states@1', 'olv.observation.shadow-frontier@1',
      ...(planning ? ['olv.observation.coverage-gain@1', 'olv.observation.station-suggestion@1'] : []),
    ],
    fieldDigest: ledgerResult.fieldDigest,
    stateCounts: field.stateCounts as ObservationStateCounts,
    frontier: {
      frontierVoxelCount: frontier.frontierVoxelKeys.length,
      areaSquareMetres: frontier.areaSquareMetres,
      adjacentToShadowed: frontier.adjacentToShadowed,
      adjacentToUnaddressed: frontier.adjacentToUnaddressed,
      adjacentToNoReturnPath: frontier.adjacentToNoReturnPath,
    },
    rejectionRatio: ledgerResult.rejectionRatio,
    limitations: [
      'resident-only basis: rays are built from resident points, not the source\'s own no-return declarations',
      'every station\'s angular domain is treated as unbounded (no fitted acquisition coverage for this source)',
    ],
    processingManifestHead: null,
  });

  return {
    status: 'ok',
    record,
    stateByKey: field.stateByKey,
    grid: field.grid,
    domain,
    voxelEdge: options.voxelEdge,
    frontier,
    rows: ledgerResult.rows,
    planning,
  };
}
