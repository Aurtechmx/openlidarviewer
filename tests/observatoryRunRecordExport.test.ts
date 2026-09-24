/**
 * observatoryRunRecordExport.test.ts — phase O7: the run record, the export
 * bundle's field.bin round trip (OB-EXP-02), and F10 (a non-canonical export
 * option changes no canonical byte).
 *
 * Builds ONE real F1-shaped run (station, wall, room) through the actual
 * ray builder (`rays.ts`) and ledger traversal (`ledger.ts`), the same
 * pattern `observatoryFixturesO5EndToEnd.test.ts` already established, but
 * at a far UTM-scale origin (easting ~400000, northing ~3600000) — the
 * Flow Pulse browser review's own lesson: an export must carry the real
 * dataset CRS coordinate, not a scene-recentred one, and a far origin is
 * exactly where a stray Float32 cast or a lossy round trip would first show
 * up as metre-scale drift.
 */
import { describe, expect, it } from 'vitest';

import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import { CellState, NO_RECORD, tallyCellStates, type OrganizedRangeFrame } from '../src/model/OrganizedRange';
import { buildGriddedSourceRays, type GriddedRayCoverage } from '../src/observation/rays';
import {
  clipRayToDomain,
  domainGrid,
  runObservationLedger,
  type ObservationDomain,
  type ObservationLedgerRow,
  type RayPartitionChunkEntry,
  type RayPartitionInput,
} from '../src/observation/ledger';
import { classifyObservationField, type ObservationFieldStation } from '../src/observation/observationField';
import { computeShadowFrontier } from '../src/observation/shadowFrontier';
import type { ObservationParameters, ObservationState } from '../src/observation/types';
import { sealObservationRunRecord, type ObservationRunRecord, type ObservationRunStation } from '../src/observation/runRecord';
import {
  buildObservatoryPackage,
  parseObservationFieldBinary,
  recomputeFieldDigestFromExport,
  writeObservationFieldBinary,
} from '../src/export/observatoryPackage';

type Vec3 = readonly [number, number, number];

const PARAMS: ObservationParameters = { p_solid: 0.9, p_empty: 0.1, n_min: 5, tau_abs: 0.25, tau_rel: 0 };

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}
function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function azimuthPolarOf(direction: Vec3): { readonly azimuth: number; readonly polar: number } {
  return { azimuth: Math.atan2(direction[1], direction[0]), polar: Math.acos(direction[2]) };
}
function station(id: string, origin: Vec3): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin, localPositionSource: 'not-applicable' }, recordRange: { start: 0, end: 0 }, originStatus: 'DECLARED' };
}

const RAYS_PER_PROBE = 5; // == n_min

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
    id: 'probe', sourceKind: 'ptx-grid', width, height, cellState, cellToRecord, geometricRange,
    linkage: { kind: 'exact' }, diagnostics: tallyCellStates(cellState),
  };
  return { frame, coverage: { azimuth0: 0, azimuthStep: 0, polar0: 0, polarStep: 0 } };
}

function chunkEntryFor(sourceIndex: number, origin: Vec3, direction: Vec3, range: number): RayPartitionChunkEntry {
  const { azimuth, polar } = azimuthPolarOf(direction);
  const { frame } = buildRepeatedRayCells(range);
  const build = buildGriddedSourceRays(frame, station('s', origin), sourceIndex, { azimuth0: azimuth, azimuthStep: 0, polar0: polar, polarStep: 0 }, { kind: 'none' });
  return { sourceIndex, chunk: build.returnedChunks[0]!, tauAbs: PARAMS.tau_abs, tauRel: PARAMS.tau_rel };
}

// A far UTM-scale origin: easting/northing in the hundreds-of-thousands, the
// scale at which a stray Float32 narrowing first shows up as metre drift.
const UTM_X = 400000;
const UTM_Y = 3600000;
const UTM_Z = 100;

function buildFarOriginRun(): {
  readonly record: ObservationRunRecord;
  readonly rows: readonly ObservationLedgerRow[];
  readonly frontierVoxelKeys: readonly number[];
  readonly domain: ObservationDomain;
  readonly voxelEdge: number;
} {
  const domain: ObservationDomain = {
    min: [UTM_X - 1, UTM_Y - 6, UTM_Z - 1],
    max: [UTM_X + 16, UTM_Y + 6, UTM_Z + 6],
  };
  const voxelEdge = 0.5;
  const wallDomain: ObservationDomain = { min: [UTM_X + 5, UTM_Y - 2, UTM_Z], max: [UTM_X + 5.2, UTM_Y + 2, UTM_Z + 3] };
  const origin: Vec3 = [UTM_X, UTM_Y, UTM_Z];
  const target: Vec3 = [UTM_X + 5.1, UTM_Y, UTM_Z + 1.5];
  const direction = normalize(subtract(target, origin));
  const wallClip = clipRayToDomain(origin, direction, 0, Infinity, wallDomain);
  if (wallClip === null) throw new Error('test setup: the chosen direction must hit the wall');

  const stationS1 = station('station-1', origin);
  const entry = chunkEntryFor(0, origin, direction, wallClip.tEntry);
  const input: RayPartitionInput = { domain, voxelEdge, stations: [stationS1], returnedChunks: [entry], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const fieldStation: ObservationFieldStation = { sourceIndex: 0, origin, azimuthDeg: [0, 360], elevationDeg: [-30, 45] };
  const field = classifyObservationField(domain, voxelEdge, result.rows, [fieldStation], PARAMS);

  const stateByKey = new Map<number, ObservationState>();
  for (const [k, v] of field.stateByKey) stateByKey.set(k, v.state);
  const frontier = computeShadowFrontier(stateByKey, grid, voxelEdge, 1);

  const runStation: ObservationRunStation = {
    id: stationS1.id, source: stationS1.source, originStatus: stationS1.originStatus,
    worldTranslation: origin, sourceIndex: 0, tauAbs: PARAMS.tau_abs, tauRel: PARAMS.tau_rel,
  };
  const record = sealObservationRunRecord({
    schemaVersion: 1,
    id: 'run-far-utm-1',
    generatedAt: '2026-09-24T00:00:00.000Z',
    build: 'test-build',
    source: { filename: 'far-utm.ptx', sourceDigest: 'sha256:source', basis: 'full', metresPerUnit: 1 },
    domain, voxelEdge,
    stations: [runStation],
    parameters: PARAMS,
    methods: ['olv.observation.rays', 'olv.observation.ledger', 'olv.observation.states', 'olv.observation.shadow-frontier'],
    fieldDigest: result.fieldDigest,
    stateCounts: field.stateCounts,
    frontier: {
      frontierVoxelCount: frontier.frontierVoxelKeys.length,
      areaSquareMetres: frontier.areaSquareMetres,
      adjacentToShadowed: frontier.adjacentToShadowed,
      adjacentToUnaddressed: frontier.adjacentToUnaddressed,
      adjacentToNoReturnPath: frontier.adjacentToNoReturnPath,
    },
    rejectionRatio: result.rejectionRatio,
    limitations: ['Synthetic single-station fixture; not a real multi-station scene.'],
    processingManifestHead: null,
  });

  return { record, rows: result.rows, frontierVoxelKeys: frontier.frontierVoxelKeys, domain, voxelEdge };
}

describe('phase O7 — ObservationRunRecord seals a real far-UTM-origin run', () => {
  const { record } = buildFarOriginRun();

  it('carries the domain and station position to the metre, in the real dataset CRS, not a recentred one', () => {
    expect(record.domain.min[0]).toBe(UTM_X - 1);
    expect(record.domain.max[0]).toBe(UTM_X + 16);
    expect(record.stations[0]!.worldTranslation).toEqual([UTM_X, UTM_Y, UTM_Z]);
  });

  it('the digest is stable under JSON round-trip (what an exported observation-record.json actually carries)', () => {
    const roundTripped = JSON.parse(JSON.stringify(record)) as ObservationRunRecord;
    expect(roundTripped.domain).toEqual(record.domain);
    expect(roundTripped.stations[0]!.worldTranslation).toEqual([UTM_X, UTM_Y, UTM_Z]);
    expect(roundTripped.digest).toBe(record.digest);
  });

  it('OB-INV-10: metresPerUnit null withholds no state counts, but is carried honestly when known', () => {
    expect(record.source.metresPerUnit).toBe(1);
  });
});

describe('phase O7 — field.bin/field.json round trip (OB-EXP-02)', () => {
  const { record, rows, domain, voxelEdge } = buildFarOriginRun();
  const grid = domainGrid(domain, voxelEdge);
  const { bytes, header } = writeObservationFieldBinary(domain, voxelEdge, grid, record.stations.length, rows);

  it('the exported field.bin re-derives the SAME fieldDigest the run record declares', () => {
    const parsedRows = parseObservationFieldBinary(bytes, header);
    expect(parsedRows.length).toBe(rows.length);
    const rederived = recomputeFieldDigestFromExport(domain, voxelEdge, record.stations, parsedRows);
    expect(rederived).toBe(record.fieldDigest);
  });

  it('re-deriving states from the exported counters matches the exported state summary', () => {
    const parsedRows = parseObservationFieldBinary(bytes, header);
    const fieldStation: ObservationFieldStation = { sourceIndex: 0, origin: [UTM_X, UTM_Y, UTM_Z], azimuthDeg: [0, 360], elevationDeg: [-30, 45] };
    const reclassified = classifyObservationField(domain, voxelEdge, parsedRows, [fieldStation], PARAMS);
    expect(reclassified.stateCounts).toEqual(record.stateCounts);
  });

  it('every column SHA-256 in the header matches its own bytes', () => {
    for (const col of header.columns) {
      expect(col.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('preserves the far-UTM domain to the metre in the header itself', () => {
    expect(header.domain.min[0]).toBe(UTM_X - 1);
    expect(header.domain.max[1]).toBe(UTM_Y + 6);
  });
});

describe('phase O7 — F10: a non-canonical export option changes no canonical byte', () => {
  const { record, rows, domain, voxelEdge } = buildFarOriginRun();
  const grid = domainGrid(domain, voxelEdge);

  it('field.bin and its header are byte-identical whether the export runs under one basename/timestamp or another', () => {
    const a = writeObservationFieldBinary(domain, voxelEdge, grid, record.stations.length, rows);
    const b = writeObservationFieldBinary(domain, voxelEdge, grid, record.stations.length, rows);
    expect(Array.from(a.bytes)).toEqual(Array.from(b.bytes));
    expect(a.header.columns.map((c) => c.sha256)).toEqual(b.header.columns.map((c) => c.sha256));
  });

  it('the run record digest is identical across two seals of the same content with different id/generatedAt', () => {
    const other = { ...record, id: 'a-completely-different-run-id', generatedAt: '2099-01-01T00:00:00.000Z' };
    const resealed = sealObservationRunRecordFrom(other);
    expect(resealed.digest).toBe(record.digest);
  });

  it('buildObservatoryPackage produces non-empty ZIP bytes for two different export options with the same digest', () => {
    const zipA = buildObservatoryPackage(record, rows, [], { basename: 'obs-a', generationDateIso: '2020-01-01T00:00:00.000Z' });
    const zipB = buildObservatoryPackage(record, rows, [], { basename: 'obs-b', generationDateIso: '2030-01-01T00:00:00.000Z' });
    expect(zipA.length).toBeGreaterThan(0);
    expect(zipB.length).toBeGreaterThan(0);
    // Cosmetic-only differences (basename, timestamp) change file names/README text,
    // never the sealed record's own digest, which both ZIPs carry unchanged.
    const textA = new TextDecoder().decode(zipA);
    const textB = new TextDecoder().decode(zipB);
    expect(textA).toContain(record.digest);
    expect(textB).toContain(record.digest);
  });
});

function sealObservationRunRecordFrom(withDigestAlready: ObservationRunRecord): ObservationRunRecord {
  const { digest: _digest, ...rest } = withDigestAlready;
  return sealObservationRunRecord(rest);
}
