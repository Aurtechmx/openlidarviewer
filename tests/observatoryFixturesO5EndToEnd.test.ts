/**
 * observatoryFixturesO5EndToEnd.test.ts — F1, F2, F3 and F7 through the REAL
 * pipeline: the ray builder (O3, `rays.ts`), the ledger and DDA traversal
 * (O4, `ledger.ts`'s `runObservationLedger`), and the classifier (O5,
 * `observationField.ts`), run end to end, asserting the same states
 * `tests/observatoryFixturesO5.test.ts`'s hand-supplied-counter tests
 * already established.
 *
 * `observatoryFixturesO5.test.ts`'s own header explains why it feeds
 * `classifyObservationField` with hand-picked counters rather than driving
 * the full pipeline a second time: OB-RAY/OB-LED are O3/O4's own exit
 * evidence, scored elsewhere. That test proves the CLASSIFIER is correct
 * given some ledger. It does not prove the ray builder and the ledger
 * actually PRODUCE that ledger from each fixture's declared geometry. This
 * file closes that gap: every ray below is built by `buildGriddedSourceRays`
 * from a real `OrganizedRangeFrame`, accumulated by `runObservationLedger`'s
 * real DDA traversal, and only THEN classified.
 *
 * Every probe voxel here is found by walking the SAME physical ray a real
 * instrument would fire (one direction, repeated `RAYS_PER_PROBE` times for
 * `n_min`), rather than by asserting independent, disconnected points: the
 * wall (`SURFACE`), the space in front of it (`OBSERVED_EMPTY`) and the room
 * behind it (`SHADOWED`) are three regions of ONE traversed ray, exactly as
 * SPEC's hit/pass/behind model describes a single ray's own windowing
 * (§2.1), not three separately declared facts.
 */
import { describe, expect, it } from 'vitest';

import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import { CellState, NO_RECORD, tallyCellStates, type OrganizedRangeFrame } from '../src/model/OrganizedRange';
import { buildGriddedSourceRays, type GriddedRayCoverage } from '../src/observation/rays';
import {
  clipRayToDomain,
  computeFieldDigest,
  domainGrid,
  mergePartialLedgers,
  packVoxelKey,
  runObservationLedger,
  traverseRayChunks,
  type ObservationDomain,
  type PartialLedger,
  type RayPartitionChunkEntry,
  type RayPartitionInput,
} from '../src/observation/ledger';
import type { ObservationRayChunk } from '../src/observation/rays';
import { classifyObservationField, type ObservationFieldStation } from '../src/observation/observationField';
import type { ObservationParameters } from '../src/observation/types';

const PARAMS: Pick<ObservationParameters, 'p_solid' | 'p_empty' | 'n_min'> = { p_solid: 0.9, p_empty: 0.1, n_min: 5 };
// OB-ST-THRESHOLDS: tau_abs = h/2. tau_rel = 0 here (no fitted angular step
// exists for these hand-built directions; SPEC's own formula needs one, and
// this file tests the ledger/classifier, not that derivation).
const tauAbsFor = (voxelEdge: number): number => voxelEdge / 2;

type Vec3 = readonly [number, number, number];

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}
function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function pointAt(origin: Vec3, direction: Vec3, t: number): Vec3 {
  return [origin[0] + direction[0] * t, origin[1] + direction[1] * t, origin[2] + direction[2] * t];
}
/** rays.ts's `writeDirectionFromAngles` (upAxis 'z'), inverted: azimuth/polar (radians) that reproduce `direction` exactly under that same formula. */
function azimuthPolarOf(direction: Vec3): { readonly azimuth: number; readonly polar: number } {
  return { azimuth: Math.atan2(direction[1], direction[0]), polar: Math.acos(direction[2]) };
}
function voxelKeyOf(point: Vec3, domain: ObservationDomain, voxelEdge: number, grid: { readonly nx: number; readonly ny: number }): number {
  const ix = Math.floor((point[0] - domain.min[0]) / voxelEdge);
  const iy = Math.floor((point[1] - domain.min[1]) / voxelEdge);
  const iz = Math.floor((point[2] - domain.min[2]) / voxelEdge);
  return packVoxelKey(ix, iy, iz, grid.nx, grid.ny);
}

function station(id: string, origin: Vec3): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin, localPositionSource: 'not-applicable' }, recordRange: { start: 0, end: 0 }, originStatus: 'DECLARED' };
}

const RAYS_PER_PROBE = 5; // == n_min

/**
 * A real `OrganizedRangeFrame` of `RAYS_PER_PROBE` identical grid cells, all
 * `VALID_RETURN` at `range` (a finite returned ray) or all `NO_RETURN` (a
 * no-return ray) when `range` is omitted — repeated cells to reach `n_min`
 * rays through ONE real grid, not `n_min` separately declared facts. Fed
 * through the actual `buildGriddedSourceRays` (OB-RAY-01), not constructed
 * by hand.
 */
function buildRepeatedRayCells(range: number | null): { readonly frame: OrganizedRangeFrame; readonly coverage: GriddedRayCoverage } {
  const width = RAYS_PER_PROBE;
  const height = 1;
  const cells = width * height;
  const isNoReturn = range === null;
  const cellState = new Uint8Array(cells).fill(isNoReturn ? CellState.NO_RETURN : CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(isNoReturn ? NO_RECORD : 0);
  const geometricRange = new Float32Array(cells).fill(isNoReturn ? Number.NaN : (range as number));
  if (!isNoReturn) for (let i = 0; i < cells; i++) cellToRecord[i] = i;
  const frame: OrganizedRangeFrame = {
    id: 'probe',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    geometricRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
  // Every cell shares one direction (azimuthStep/polarStep 0): the coverage
  // itself is filled in by each call site from its own chosen direction.
  return { frame, coverage: { azimuth0: 0, azimuthStep: 0, polar0: 0, polarStep: 0 } };
}

function chunkEntryFor(sourceIndex: number, origin: Vec3, direction: Vec3, range: number | null, voxelEdge: number, maxRange?: number): RayPartitionChunkEntry {
  const { azimuth, polar } = azimuthPolarOf(direction);
  const { frame } = buildRepeatedRayCells(range);
  const build = buildGriddedSourceRays(frame, station('s', origin), sourceIndex, { azimuth0: azimuth, azimuthStep: 0, polar0: polar, polarStep: 0 }, { kind: 'none' });
  expect(build.returnedChunks.length).toBe(1); // RAYS_PER_PROBE rays fit in one ObservationRayChunk (well under RAY_CHUNK_SIZE)
  expect(build.returnedChunks[0].originIndex.length).toBe(RAYS_PER_PROBE);
  return { sourceIndex, chunk: build.returnedChunks[0], tauAbs: tauAbsFor(voxelEdge), tauRel: 0, maxRange };
}

/** Splits one `ObservationRayChunk` into `n` contiguous sub-chunks (whole-ray granularity), the same shape F9's own `buildF9Chunks` produces. */
function splitChunkIntoChunks(chunk: ObservationRayChunk, n: number): ObservationRayChunk[] {
  const total = chunk.originIndex.length;
  const per = Math.ceil(total / n);
  const out: ObservationRayChunk[] = [];
  for (let start = 0; start < total; start += per) {
    const end = Math.min(start + per, total);
    out.push({
      originIndex: chunk.originIndex.slice(start, end),
      direction: chunk.direction.slice(start * 3, end * 3),
      range: chunk.range.slice(start, end),
      returnOffset: chunk.returnOffset.slice(start, end),
    });
  }
  return out;
}

/** F9's own reading (1, 2, 5 in-process partitions of the same deterministic chunk list) applied to a real entry's own chunk, asserting `fieldDigest` is identical across partition counts. */
function assertFieldDigestInvariantToPartitionCount(domain: ObservationDomain, voxelEdge: number, stations: readonly AcquisitionStation[], entry: RayPartitionChunkEntry, expectedDigest: string): void {
  const digestInput: Pick<RayPartitionInput, 'domain' | 'voxelEdge' | 'stations' | 'returnedChunks'> = { domain, voxelEdge, stations, returnedChunks: [entry] };
  for (const partitionCount of [1, 2, 5]) {
    const chunks = splitChunkIntoChunks(entry.chunk, partitionCount);
    const partials: PartialLedger[] = chunks.map((chunk) => traverseRayChunks({ domain, voxelEdge, stations, returnedChunks: [{ ...entry, chunk }], notReadChunks: [] }));
    const merged = mergePartialLedgers(partials);
    const digest = computeFieldDigest(digestInput, merged);
    expect(digest, `fieldDigest differs at partition count ${partitionCount}`).toBe(expectedDigest);
  }
}

// ---------------------------------------------------------------------------
// F1 — one station, wall in front of an open room, through the real pipeline
// ---------------------------------------------------------------------------

describe('F1 end-to-end — real ray builder + real ledger, then classifyObservationField', () => {
  const domain: ObservationDomain = { min: [-1, -6, -1], max: [16, 6, 6] };
  const voxelEdge = 0.5;
  const wallDomain: ObservationDomain = { min: [5, -2, 0], max: [5.2, 2, 3] };
  const origin: Vec3 = [0, 0, 0];
  // Toward (5.1, 0, 1.5) — inside the wall's own box, well inside the
  // declared elevation band [-30, 45] (its elevation is ~16.4 deg).
  const direction = normalize(subtract([5.1, 0, 1.5], origin));
  const wallClip = clipRayToDomain(origin, direction, 0, Infinity, wallDomain);
  if (wallClip === null) throw new Error('test setup: the chosen direction must hit the wall');
  const wallEntryRange = wallClip.tEntry; // the real near-face intersection distance

  const stationS1: AcquisitionStation = station('station-1', origin);
  const entry = chunkEntryFor(0, origin, direction, wallEntryRange, voxelEdge) as RayPartitionChunkEntry;
  const input: RayPartitionInput = { domain, voxelEdge, stations: [stationS1], returnedChunks: [entry], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const fieldStation: ObservationFieldStation = { sourceIndex: 0, origin, azimuthDeg: [0, 360], elevationDeg: [-30, 45] };
  const field = classifyObservationField(domain, voxelEdge, result.rows, [fieldStation], PARAMS);

  const wallPoint = pointAt(origin, direction, wallEntryRange);
  const frontPoint = pointAt(origin, direction, wallEntryRange - 2); // well before the hit window (tau = h/2 = 0.25)
  const behindPoint = pointAt(origin, direction, wallEntryRange + 2); // well beyond it, still inside the room
  const outsidePoint: Vec3 = [2, 0, 5]; // elevation ~68 deg > 45: no ray built there at all

  it('the real ledger actually produced rows (sanity: this is not an empty run)', () => {
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('wall hit -> SURFACE, in front -> OBSERVED_EMPTY, behind the wall -> SHADOWED, above the band -> UNADDRESSED', () => {
    expect(field.stateByKey.get(voxelKeyOf(wallPoint, domain, voxelEdge, grid))?.state).toBe('SURFACE');
    expect(field.stateByKey.get(voxelKeyOf(frontPoint, domain, voxelEdge, grid))?.state).toBe('OBSERVED_EMPTY');
    expect(field.stateByKey.get(voxelKeyOf(behindPoint, domain, voxelEdge, grid))?.state).toBe('SHADOWED');
    expect(field.stateByKey.get(voxelKeyOf(outsidePoint, domain, voxelEdge, grid))?.state).toBe('UNADDRESSED');
  });

  it('fieldDigest of this end-to-end run is invariant to 1/2/5 partitions (F9\'s own reading)', () => {
    assertFieldDigestInvariantToPartitionCount(domain, voxelEdge, [stationS1], entry, result.fieldDigest);
  });
});

// ---------------------------------------------------------------------------
// F2 — a second station behind the wall, through the real pipeline
// ---------------------------------------------------------------------------

describe('F2 end-to-end — a second station resolves the former shadow in aggregate, not in isolation', () => {
  const domain: ObservationDomain = { min: [-1, -6, -1], max: [16, 6, 6] };
  const voxelEdge = 0.5;
  const wallDomain: ObservationDomain = { min: [5, -2, 0], max: [5.2, 2, 3] };
  const origin1: Vec3 = [0, 0, 0];
  const direction1 = normalize(subtract([5.1, 0, 1.5], origin1));
  const wallClip = clipRayToDomain(origin1, direction1, 0, Infinity, wallDomain)!;
  const behindPoint = pointAt(origin1, direction1, wallClip.tEntry + 2);

  const origin2: Vec3 = [10, 0, 1];
  const direction2 = normalize(subtract(behindPoint, origin2));
  const range2 = Math.hypot(...subtract(behindPoint, origin2));

  const station1 = station('station-1', origin1);
  const station2 = station('station-2', origin2);
  const entry1 = chunkEntryFor(0, origin1, direction1, wallClip.tEntry, voxelEdge) as RayPartitionChunkEntry;
  const entry2 = chunkEntryFor(1, origin2, direction2, range2, voxelEdge) as RayPartitionChunkEntry;
  const input: RayPartitionInput = { domain, voxelEdge, stations: [station1, station2], returnedChunks: [entry1, entry2], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const key = voxelKeyOf(behindPoint, domain, voxelEdge, grid);
  const fieldStation1: ObservationFieldStation = { sourceIndex: 0, origin: origin1, azimuthDeg: [0, 360], elevationDeg: [-30, 45] };
  const fieldStation2: ObservationFieldStation = { sourceIndex: 1, origin: origin2, azimuthDeg: [0, 360], elevationDeg: [-89, 89] };

  it('the aggregate view resolves the former shadow to SURFACE', () => {
    const field = classifyObservationField(domain, voxelEdge, result.rows, [fieldStation1, fieldStation2], PARAMS);
    expect(field.stateByKey.get(key)?.state).toBe('SURFACE');
  });

  it("station 1's own isolated view still shows SHADOWED at the same voxel", () => {
    const isolated = classifyObservationField(domain, voxelEdge, result.rows, [fieldStation1], PARAMS);
    expect(isolated.stateByKey.get(key)?.state).toBe('SHADOWED');
  });
});

// ---------------------------------------------------------------------------
// F3 — a box present for A, absent for B, through the real pipeline
// ---------------------------------------------------------------------------

describe('F3 end-to-end — CONFLICT lists both disagreeing sources', () => {
  const domain: ObservationDomain = { min: [-1, -4, -1], max: [13, 4, 4] };
  const voxelEdge = 0.5;
  const boxDomain: ObservationDomain = { min: [5, -1, 0], max: [7, 1, 2] };
  const originA: Vec3 = [0, 0, 1];
  const originB: Vec3 = [12, 0, 1];
  const directionA: Vec3 = [1, 0, 0];
  const directionB: Vec3 = [-1, 0, 0];

  const clipA = clipRayToDomain(originA, directionA, 0, Infinity, boxDomain)!; // A's near face
  const rangeA = clipA.tEntry;
  // B passes through the box (entering its own near face at x=7) and
  // continues to an actual return further along, past the box's far side
  // from A (x=5): the box's near-A voxel is only ever crossed before B's own
  // hit window, giving it pass-evidence for B.
  const rangeB = Math.hypot(...subtract([-0.5, 0, 1], originB));

  const stationA = station('station-A', originA);
  const stationB = station('station-B', originB);
  const entryA = chunkEntryFor(0, originA, directionA, rangeA, voxelEdge) as RayPartitionChunkEntry;
  const entryB = chunkEntryFor(1, originB, directionB, rangeB, voxelEdge) as RayPartitionChunkEntry;
  const input: RayPartitionInput = { domain, voxelEdge, stations: [stationA, stationB], returnedChunks: [entryA, entryB], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const conflictPoint = pointAt(originA, directionA, rangeA);
  const key = voxelKeyOf(conflictPoint, domain, voxelEdge, grid);
  const fieldStationA: ObservationFieldStation = { sourceIndex: 0, origin: originA, azimuthDeg: [0, 360], elevationDeg: [-45, 45] };
  const fieldStationB: ObservationFieldStation = { sourceIndex: 1, origin: originB, azimuthDeg: [0, 360], elevationDeg: [-45, 45] };

  it("A's near-face voxel resolves to CONFLICT, with both source indices and counts recorded", () => {
    const field = classifyObservationField(domain, voxelEdge, result.rows, [fieldStationA, fieldStationB], PARAMS);
    const decision = field.stateByKey.get(key);
    expect(decision?.state).toBe('CONFLICT');
    expect([decision?.conflict?.solidSourceIndex, decision?.conflict?.emptySourceIndex].sort()).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// F7 — a pocket beyond the declared maximum range, through the real pipeline
// ---------------------------------------------------------------------------

describe('F7 end-to-end — a real no-return ray past maxRange never reaches the pocket', () => {
  const domain: ObservationDomain = { min: [-1, -4, -1], max: [11, 4, 4] };
  const voxelEdge = 0.5;
  const origin: Vec3 = [0, 0, 1];
  const direction: Vec3 = [1, 0, 0]; // elevation 0, inside the declared [-10, 10] band
  const maxRange = 5;

  const stationF7 = station('station-1', origin);
  const entry = chunkEntryFor(0, origin, direction, null, voxelEdge, maxRange) as RayPartitionChunkEntry;
  const input: RayPartitionInput = { domain, voxelEdge, stations: [stationF7], returnedChunks: [entry], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const pocketPoint: Vec3 = [9, 0, 1]; // range 9 from the origin, past maxRange (5)
  const key = voxelKeyOf(pocketPoint, domain, voxelEdge, grid);
  const fieldStation: ObservationFieldStation = { sourceIndex: 0, origin, azimuthDeg: [0, 360], elevationDeg: [-10, 10], maxRange };

  it("REGRESSION (this phase's own fix): a no-return ray's traversal stops at the declared maxRange, not the domain bound — the pocket gets no row at all", () => {
    const rowAtPocket = result.rows.find((r) => r.key === key);
    expect(rowAtPocket).toBeUndefined();
  });

  it('an in-range voxel on the same ray still gets noReturn evidence (the fix does not blank the whole ray)', () => {
    const nearPoint: Vec3 = [2, 0, 1];
    const nearKey = voxelKeyOf(nearPoint, domain, voxelEdge, grid);
    const nearRow = result.rows.find((r) => r.key === nearKey);
    expect(nearRow?.counters.noReturn).toBeGreaterThan(0);
  });

  it('classifies the pocket UNADDRESSED, never SHADOWED', () => {
    const field = classifyObservationField(domain, voxelEdge, result.rows, [fieldStation], PARAMS);
    expect(field.stateByKey.get(key)?.state).toBe('UNADDRESSED');
  });
});
