/**
 * field.ts: builds each O11 scenario's committed field
 * (validation/protocols/observatory-o11-v1.md). Room scenes run the real
 * kernel (rays, ledger, states, frontier) over the returns
 * `castO11Returns` produces; a strided scene hands the skipped records to the
 * ledger as not-read rays. The stress scene is the synthetic field
 * `buildO11StressStates` declares.
 *
 * The result is dense: one state index per voxel, x fastest, plus one
 * frontier flag per voxel, which is what both overlay arms read.
 */
import { buildO11StressStates, castO11Returns, type O11RoomScenario, type O11Scenario } from '../../../scripts/lib/observatoryO11Scenarios.mjs';
import { buildUnstructuredSourceRays } from '../../../src/observation/rays';
import { domainGrid, runObservationLedger, type ObservationDomain, type RayPartitionChunkEntry } from '../../../src/observation/ledger';
import { classifyObservationField, type ObservationFieldStation } from '../../../src/observation/observationField';
import { computeShadowFrontier } from '../../../src/observation/shadowFrontier';
import { OBSERVATION_STATES, type ObservationState } from '../../../src/observation/types';
import type { AcquisitionStation } from '../../../src/model/AcquisitionStations';
import { OBSERVATORY_PARAMETERS } from '../../../src/app/observatoryFromCloud';

export interface DenseField {
  readonly id: string;
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number };
  readonly voxelEdge: number;
  /** Index into `OBSERVATION_STATES`, one per voxel, x fastest. */
  readonly states: Uint8Array;
  /** 1 where the voxel is on the shadow frontier. */
  readonly frontier: Uint8Array;
  readonly returns: number;
  readonly notReadRays: number;
  readonly buildMs: number;
}

const STATE_INDEX = new Map<ObservationState, number>(OBSERVATION_STATES.map((s, i) => [s, i]));

function station(id: string, origin: readonly [number, number, number], start: number, end: number): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin }, recordRange: { start, end }, originStatus: 'DECLARED' } as AcquisitionStation;
}

function roomField(scene: O11RoomScenario): DenseField {
  const t0 = performance.now();
  const { positions, recordRanges } = castO11Returns(scene);
  const domain: ObservationDomain = { min: scene.room.minCorner, max: scene.room.maxCorner };
  const tauAbs = scene.voxelEdge / 2;
  const returnedChunks: RayPartitionChunkEntry[] = [];
  const notReadChunks: { sourceIndex: number; chunk: RayPartitionChunkEntry['chunk'] }[] = [];
  const stations: AcquisitionStation[] = [];
  const fieldStations: ObservationFieldStation[] = [];
  let notReadRays = 0;
  scene.stations.forEach((s, sourceIndex) => {
    const range = recordRanges[sourceIndex]!;
    // Strided read: every `stride`-th record is read; the rest are passed as not-read rays.
    const kept: number[] = [];
    const skipped: number[] = [];
    for (let r = range.start; r < range.end; r++) ((r - range.start) % scene.stride === 0 ? kept : skipped).push(r);
    const pack = (records: number[]) => {
      const out = new Float32Array(records.length * 3);
      records.forEach((r, i) => { out[i * 3] = positions[r * 3]!; out[i * 3 + 1] = positions[r * 3 + 1]!; out[i * 3 + 2] = positions[r * 3 + 2]!; });
      return out;
    };
    const st = station(s.id, s.origin, 0, kept.length);
    stations.push(st);
    for (const chunk of buildUnstructuredSourceRays(pack(kept), st, sourceIndex, [0, 0, 0], { kind: 'none' }).returnedChunks) {
      returnedChunks.push({ sourceIndex, chunk, tauAbs, tauRel: 0 });
    }
    if (skipped.length > 0) {
      notReadRays += skipped.length;
      const skippedStation = station(s.id, s.origin, 0, skipped.length);
      for (const chunk of buildUnstructuredSourceRays(pack(skipped), skippedStation, sourceIndex, [0, 0, 0], { kind: 'none' }).returnedChunks) {
        notReadChunks.push({ sourceIndex, chunk });
      }
    }
    fieldStations.push({ sourceIndex, origin: s.origin, azimuthDeg: [0, 360], elevationDeg: [-90, 90] });
  });
  const ledger = runObservationLedger(
    { domain, voxelEdge: scene.voxelEdge, stations, returnedChunks, notReadChunks },
    { declaredStepBudget: 2_000_000_000 },
  );
  if (ledger.status === 'refused') throw new Error(`O11 ${scene.id}: the ledger refused the run (${String(ledger.reason)})`);
  const field = classifyObservationField(domain, scene.voxelEdge, ledger.rows, fieldStations, OBSERVATORY_PARAMETERS);
  const grid = domainGrid(domain, scene.voxelEdge);
  const n = grid.nx * grid.ny * grid.nz;
  const states = new Uint8Array(n).fill(STATE_INDEX.get('UNADDRESSED')!);
  const stateOnly = new Map<number, ObservationState>();
  for (const [key, decision] of field.stateByKey) {
    states[key] = STATE_INDEX.get(decision.state)!;
    stateOnly.set(key, decision.state);
  }
  const frontier = new Uint8Array(n);
  for (const key of computeShadowFrontier(stateOnly, grid, scene.voxelEdge, 1).frontierVoxelKeys) frontier[key] = 1;
  return { id: scene.id, grid, voxelEdge: scene.voxelEdge, states, frontier, returns: positions.length / 3, notReadRays, buildMs: performance.now() - t0 };
}

export function buildScenarioField(scene: O11Scenario): DenseField {
  if (scene.kind === 'room') return roomField(scene);
  const t0 = performance.now();
  const states = buildO11StressStates(scene, OBSERVATION_STATES.length - 1); // every state but OUTSIDE_DOMAIN
  const frontier = new Uint8Array(states.length);
  const shadowed = STATE_INDEX.get('SHADOWED')!;
  // Frontier in the stress field: a shadowed voxel with a non-shadowed x neighbour.
  for (let i = 1; i < states.length; i++) if (states[i] === shadowed && states[i - 1] !== shadowed) frontier[i] = 1;
  return { id: scene.id, grid: scene.grid, voxelEdge: scene.voxelEdge, states, frontier, returns: 0, notReadRays: 0, buildMs: performance.now() - t0 };
}
