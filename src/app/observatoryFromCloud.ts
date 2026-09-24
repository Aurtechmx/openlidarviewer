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
  runObservationLedger,
  type ObservationDomain,
  type ObservationLedgerRunResult,
  type RayPartitionChunkEntry,
} from '../observation/ledger';
import { classifyObservationField, type ObservationFieldStation, type ObservationStateCounts } from '../observation/observationField';
import { computeShadowFrontier, type ShadowFrontierResult } from '../observation/shadowFrontier';
import { sealObservationRunRecord, type ObservationRunRecord } from '../observation/runRecord';
import type { ObservationParameters } from '../observation/types';

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

  const entries: RayPartitionChunkEntry[] = [];
  const stationList: AcquisitionStation[] = [];
  const fieldStations: ObservationFieldStation[] = [];
  stations.forEach((station, sourceIndex) => {
    stationList.push(station);
    const build = buildUnstructuredSourceRays(cloud.positions, station, sourceIndex, cloud.sourceOrigin, { kind: 'none' });
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
  const stateOnly = new Map<number, import('../observation/types').ObservationState>();
  for (const [key, decision] of field.stateByKey) stateOnly.set(key, decision.state);
  const frontier = computeShadowFrontier(stateOnly, field.grid, options.voxelEdge, options.metresPerUnit);

  const parameters: ObservationParameters = { ...OBSERVATORY_PARAMETERS, tau_abs: tauAbs, tau_rel: tauRel };
  const record = sealObservationRunRecord({
    schemaVersion: 1,
    id: `obs-${ledgerResult.fieldDigest.slice(0, 12)}`,
    generatedAt: new Date().toISOString(),
    build: options.buildTag,
    source: { filename: options.filename, sourceDigest: sha256(canonicalize(Array.from(cloud.positions.subarray(0, Math.min(cloud.positions.length, 3000))))), basis: 'resident-only', metresPerUnit: options.metresPerUnit },
    domain,
    voxelEdge: options.voxelEdge,
    stations: stationList.map((s, i) => ({ id: s.id, source: s.source, originStatus: s.originStatus, worldTranslation: s.pose.worldTranslation, sourceIndex: i, tauAbs, tauRel })),
    parameters,
    methods: ['olv.observation.rays@1', 'olv.observation.ledger@1', 'olv.observation.states@1', 'olv.observation.shadow-frontier@1'],
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
  };
}
