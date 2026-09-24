/**
 * observatoryStrength.test.ts — O6: `olv.observation.strength` (SPEC §2.5,
 * §5.5, OB-STR-01/02).
 *
 * Groups:
 *  - the component-oracle group replays `validation/observatory/oracle/
 *    strength-lattice.json` through `computeStrengthComponents` and compares
 *    against `strength.py`'s frozen, independently-derived expectations
 *    (this phase's own exit evidence, per SPEC §10's O6 row);
 *  - the end-to-end group builds F1's wall through the REAL ray builder
 *    (`buildGriddedSourceRays`) and ledger traversal (`runObservationLedger`),
 *    then computes the wall voxel's own strength components from the real
 *    `ObservationLedgerRow` plus real hitting-ray samples accumulated by
 *    `accumulateStrengthHitSamples` off the very same `ObservationRayChunk`
 *    the ledger consumed — not hand-fed counters;
 *  - the multi-return group builds a real 3-return-per-pulse chunk (the same
 *    `buildCellReturns`/CSR shape `observatoryFixtureF5F6F16.test.ts`'s F16
 *    group uses) and confirms `accumulateStrengthHitSamples` samples a voxel
 *    hit only by the ray's 2nd return, and that every row's strength
 *    hit-sample count equals its ledger `hit` counter exactly, over both F1
 *    (single-return) and this multi-return fixture.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import {
  CellState,
  buildCellReturns,
  cellIndexOf,
  tallyCellStates,
  type CellReturnInput,
  type OrganizedRangeFrame,
} from '../src/model/OrganizedRange';
import { buildGriddedSourceRays, type GriddedRayCoverage } from '../src/observation/rays';
import { clipRayToDomain, domainGrid, packVoxelKey, runObservationLedger, type ObservationDomain, type RayPartitionChunkEntry, type RayPartitionInput } from '../src/observation/ledger';
import {
  accumulateStrengthHitSamples,
  computeConsistency,
  computeStrengthComponents,
  computeStrengthComposite,
  countStrengthSources,
  fitNormalFromResidentPoints,
  mergeStrengthHitSamples,
  saturatedSources,
  SOURCES_SATURATION_CAP_EXAMPLE,
  type StrengthHitSample,
  type StrengthRangeBand,
} from '../src/observation/strength';

type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// component oracle: strength-lattice.json vs strength.py's frozen expectations
// ---------------------------------------------------------------------------

interface LatticeCase {
  readonly id: string;
  readonly counters: { readonly hit: number; readonly pass: number };
  readonly perSource: readonly { readonly sourceIndex: number; readonly hit: number }[];
  readonly samples: readonly { readonly sourceIndex: number; readonly direction: Vec3; readonly range: number }[];
  readonly normal: Vec3 | null;
  readonly rangeBand: StrengthRangeBand;
}

interface ExpectedCase {
  readonly id: string;
  readonly expected: {
    readonly sources: number;
    readonly angularSpread: number | null;
    readonly incidence: number | null;
    readonly rangeFit: number | null;
    readonly consistency: number | null;
  };
}

const ORACLE_DIR = join(__dirname, '..', 'validation', 'observatory', 'oracle');
const EXPECTED_DIR = join(__dirname, '..', 'validation', 'observatory', 'expected');

const lattice: { readonly cases: readonly LatticeCase[] } = JSON.parse(readFileSync(join(ORACLE_DIR, 'strength-lattice.json'), 'utf8'));
const expected: { readonly results: readonly ExpectedCase[] } = JSON.parse(readFileSync(join(EXPECTED_DIR, 'strength-lattice.expected.json'), 'utf8'));

/** `null` in the frozen JSON means the oracle computed NaN (JSON has no NaN literal); this asserts the same duality. */
function expectMatchesNullableNaN(actual: number, expectedValue: number | null): void {
  if (expectedValue === null) {
    expect(Number.isNaN(actual)).toBe(true);
  } else {
    expect(actual).toBeCloseTo(expectedValue, 9);
  }
}

describe('OB-STR-01 component oracle — strength-lattice.json vs strength.py', () => {
  expect(lattice.cases.length).toBe(expected.results.length);

  for (let i = 0; i < lattice.cases.length; i++) {
    const c = lattice.cases[i]!;
    const e = expected.results[i]!;

    it(`${c.id}: matches the independent Python oracle`, () => {
      expect(e.id).toBe(c.id);
      const row = { counters: { hit: c.counters.hit, pass: c.counters.pass, behind: 0, noReturn: 0, saturated: false }, perSource: c.perSource.map((s) => ({ sourceIndex: s.sourceIndex, hit: s.hit, pass: 0, behind: 0, noReturn: 0, saturated: false, notDecoded: false })) };
      const samples: StrengthHitSample[] = c.samples.map((s) => ({ sourceIndex: s.sourceIndex, direction: s.direction, range: s.range }));
      const components = computeStrengthComponents(row, samples, c.normal, c.rangeBand);

      expect(components.sources).toBe(e.expected.sources);
      expectMatchesNullableNaN(components.angularSpread, e.expected.angularSpread);
      expectMatchesNullableNaN(components.incidence, e.expected.incidence);
      expectMatchesNullableNaN(components.rangeFit, e.expected.rangeFit);
      expectMatchesNullableNaN(components.consistency, e.expected.consistency);
    });
  }
});

// ---------------------------------------------------------------------------
// unit coverage: sources/consistency helpers, saturating map, composite, normal fit
// ---------------------------------------------------------------------------

describe('countStrengthSources / computeConsistency — read straight off ledger counters', () => {
  it('counts only sources with hit > 0', () => {
    const row = { perSource: [{ sourceIndex: 0, hit: 3 }, { sourceIndex: 1, hit: 0 }, { sourceIndex: 2, hit: 1 }] as any };
    expect(countStrengthSources(row)).toBe(2);
  });

  it('consistency is hit/(hit+pass), NaN when both are zero', () => {
    expect(computeConsistency({ counters: { hit: 3, pass: 1, behind: 0, noReturn: 0, saturated: false } })).toBeCloseTo(0.75, 12);
    expect(Number.isNaN(computeConsistency({ counters: { hit: 0, pass: 0, behind: 0, noReturn: 0, saturated: false } }))).toBe(true);
  });
});

describe('saturatedSources — §2.5\'s worked saturating-map example', () => {
  it('caps at SOURCES_SATURATION_CAP_EXAMPLE (3) by default', () => {
    expect(saturatedSources(0)).toBe(0);
    expect(saturatedSources(1)).toBeCloseTo(1 / 3, 12);
    expect(saturatedSources(3)).toBe(1);
    expect(saturatedSources(10)).toBe(1);
    expect(SOURCES_SATURATION_CAP_EXAMPLE).toBe(3);
  });

  it('honours a caller-declared cap (OB-STR-02: the cap is recorded, not fixed forever)', () => {
    expect(saturatedSources(2, 4)).toBe(0.5);
  });

  it('rejects a non-positive cap', () => {
    expect(() => saturatedSources(1, 0)).toThrow();
  });
});

describe('computeStrengthComposite — OB-STR-02: never shown without its weights', () => {
  const weights = { sources: 1, angularSpread: 1, incidence: 1, rangeFit: 1, consistency: 1 };

  it('is the declared weighted mean of the bounded components', () => {
    const components = { sources: 3, angularSpread: 0.5, incidence: 0.8, rangeFit: 1, consistency: 0.9 };
    const composite = computeStrengthComposite(components, weights);
    expect(composite.weights).toBe(weights);
    expect(composite.components).toBe(components);
    // saturatedSources(3) = 1, so the mean is (1+0.5+0.8+1+0.9)/5.
    expect(composite.index).toBeCloseTo((1 + 0.5 + 0.8 + 1 + 0.9) / 5, 12);
  });

  it('excludes a NaN component from both the sum and the weight total, rather than treating it as zero', () => {
    const components = { sources: 0, angularSpread: Number.NaN, incidence: Number.NaN, rangeFit: 1, consistency: 1 };
    const composite = computeStrengthComposite(components, weights);
    // Only rangeFit and consistency (and saturatedSources(0)=0) contribute.
    expect(composite.index).toBeCloseTo((0 + 1 + 1) / 3, 12);
  });

  it('is NaN when every [0,1]-bounded component is NaN and sources carries no weight', () => {
    // `sources` is always a real integer (never NaN itself); zeroing its
    // weight isolates the "nothing else to average" case this asserts.
    const components = { sources: 0, angularSpread: Number.NaN, incidence: Number.NaN, rangeFit: Number.NaN, consistency: Number.NaN };
    const composite = computeStrengthComposite(components, { ...weights, sources: 0 });
    expect(Number.isNaN(composite.index)).toBe(true);
  });
});

describe('fitNormalFromResidentPoints — symEig3 over a mean-centred covariance', () => {
  it('fits the normal of a flat XY plane as ±Z', () => {
    // A small grid of points on z=2, x/y varying: the smallest-eigenvalue
    // eigenvector must be (0, 0, ±1).
    const positions = new Float32Array([0, 0, 2, 1, 0, 2, 0, 1, 2, 1, 1, 2, 0.5, 0.5, 2]);
    const normal = fitNormalFromResidentPoints(positions, [0, 1, 2, 3, 4]);
    expect(normal).not.toBeNull();
    expect(Math.abs(normal![0])).toBeCloseTo(0, 6);
    expect(Math.abs(normal![1])).toBeCloseTo(0, 6);
    expect(Math.abs(normal![2])).toBeCloseTo(1, 6);
  });

  it('returns null for fewer than 3 points', () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    expect(fitNormalFromResidentPoints(positions, [0, 1])).toBeNull();
  });

  it('returns null for a degenerate (collinear) neighbourhood', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(fitNormalFromResidentPoints(positions, [0, 1, 2])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// end-to-end: F1's wall through the real ray builder + real ledger
// ---------------------------------------------------------------------------

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}
function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function station(id: string, origin: Vec3): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin, localPositionSource: 'not-applicable' }, recordRange: { start: 0, end: 0 }, originStatus: 'DECLARED' };
}

const RAYS_PER_PROBE = 5; // matches OB-ST-THRESHOLDS n_min

function buildRepeatedRayCells(range: number): { readonly frame: OrganizedRangeFrame } {
  const width = RAYS_PER_PROBE;
  const height = 1;
  const cells = width * height;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells);
  const geometricRange = new Float32Array(cells).fill(range);
  for (let i = 0; i < cells; i++) cellToRecord[i] = i;
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
  return { frame };
}

function azimuthPolarOf(direction: Vec3): { readonly azimuth: number; readonly polar: number } {
  return { azimuth: Math.atan2(direction[1], direction[0]), polar: Math.acos(direction[2]) };
}

describe('F1 end-to-end — real ray builder + real ledger feed real strength components', () => {
  const domain: ObservationDomain = { min: [-1, -6, -1], max: [16, 6, 6] };
  const voxelEdge = 0.5;
  const wallDomain: ObservationDomain = { min: [5, -2, 0], max: [5.2, 2, 3] };
  const origin: Vec3 = [0, 0, 0];
  const direction = normalize(subtract([5.1, 0, 1.5], origin));
  const wallClip = clipRayToDomain(origin, direction, 0, Infinity, wallDomain);
  if (wallClip === null) throw new Error('test setup: the chosen direction must hit the wall');
  const wallEntryRange = wallClip.tEntry;

  const { azimuth, polar } = azimuthPolarOf(direction);
  const { frame } = buildRepeatedRayCells(wallEntryRange);
  const coverage: GriddedRayCoverage = { azimuth0: azimuth, azimuthStep: 0, polar0: polar, polarStep: 0 };
  const build = buildGriddedSourceRays(frame, station('station-1', origin), 0, coverage, { kind: 'none' });
  expect(build.returnedChunks.length).toBe(1);
  const chunk = build.returnedChunks[0]!;

  const tauAbs = voxelEdge / 2;
  const tauRel = 0;
  const entry: RayPartitionChunkEntry = { sourceIndex: 0, chunk, tauAbs, tauRel };
  const input: RayPartitionInput = { domain, voxelEdge, stations: [station('station-1', origin)], returnedChunks: [entry], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const wallPoint: Vec3 = [origin[0] + direction[0] * wallEntryRange, origin[1] + direction[1] * wallEntryRange, origin[2] + direction[2] * wallEntryRange];
  const wallKey = packVoxelKey(
    Math.floor((wallPoint[0] - domain.min[0]) / voxelEdge),
    Math.floor((wallPoint[1] - domain.min[1]) / voxelEdge),
    Math.floor((wallPoint[2] - domain.min[2]) / voxelEdge),
    grid.nx,
    grid.ny,
  );
  const wallRow = result.rows.find((r) => r.key === wallKey);

  it('the real ledger produced a row at the wall voxel with hit evidence', () => {
    expect(wallRow).toBeDefined();
    expect(wallRow!.counters.hit).toBeGreaterThan(0);
  });

  it('accumulateStrengthHitSamples, off the SAME chunk the ledger consumed, finds real hit samples at the wall voxel', () => {
    const raw = accumulateStrengthHitSamples(chunk, 0, origin, domain, voxelEdge, tauAbs, tauRel, grid.nx, grid.ny);
    const byVoxel = mergeStrengthHitSamples([raw]);
    const wallSamples = byVoxel.get(wallKey) ?? [];
    expect(wallSamples.length).toBe(RAYS_PER_PROBE);
    for (const s of wallSamples) {
      expect(s.range).toBeCloseTo(wallEntryRange, 6);
      expect(s.direction[0]).toBeCloseTo(direction[0], 6);
    }

    // The wall's real normal (perpendicular to the thin box, x in [5, 5.2])
    // is +-X; the ray travels mostly +X, so |cos i| should read high (a
    // near-perpendicular hit) once fed through the real components.
    const components = computeStrengthComponents(wallRow!, wallSamples, [-1, 0, 0], {});
    expect(components.sources).toBe(1);
    expect(components.consistency).toBeGreaterThan(0.9); // p_solid-band evidence: this voxel classifies SURFACE upstream (see observatoryFixturesO5EndToEnd.test.ts)
    expect(components.angularSpread).toBeCloseTo(0, 6); // one physical direction, repeated: no spread at all.
    expect(components.incidence).toBeGreaterThan(0.9); // near head-on hit.
    expect(components.rangeFit).toBe(1); // unbounded band: every hit counts.
  });

  it('is invariant to splitting the same chunk into partitions before accumulating (matches F9\'s own partition-invariance reading)', () => {
    const whole = mergeStrengthHitSamples([accumulateStrengthHitSamples(chunk, 0, origin, domain, voxelEdge, tauAbs, tauRel, grid.nx, grid.ny)]);
    const n = chunk.originIndex.length;
    const half = Math.ceil(n / 2);
    const chunkA = { originIndex: chunk.originIndex.slice(0, half), direction: chunk.direction.slice(0, half * 3), range: chunk.range.slice(0, half), returnOffset: chunk.returnOffset.slice(0, half) };
    const chunkB = { originIndex: chunk.originIndex.slice(half), direction: chunk.direction.slice(half * 3), range: chunk.range.slice(half), returnOffset: chunk.returnOffset.slice(half) };
    const split = mergeStrengthHitSamples([
      accumulateStrengthHitSamples(chunkA, 0, origin, domain, voxelEdge, tauAbs, tauRel, grid.nx, grid.ny),
      accumulateStrengthHitSamples(chunkB, 0, origin, domain, voxelEdge, tauAbs, tauRel, grid.nx, grid.ny),
    ]);
    const wholeSamples = whole.get(wallKey) ?? [];
    const splitSamples = split.get(wallKey) ?? [];
    expect(splitSamples.length).toBe(wholeSamples.length);

    const componentsWhole = computeStrengthComponents(wallRow!, wholeSamples, [-1, 0, 0], {});
    const componentsSplit = computeStrengthComponents(wallRow!, splitSamples, [-1, 0, 0], {});
    expect(componentsSplit.angularSpread).toBeCloseTo(componentsWhole.angularSpread, 12);
    expect(componentsSplit.incidence).toBeCloseTo(componentsWhole.incidence, 12);
    expect(componentsSplit.rangeFit).toBe(componentsWhole.rangeFit);
  });
});

// ---------------------------------------------------------------------------
// multi-return: a voxel hit only by a ray's 2nd (or later) return
// ---------------------------------------------------------------------------

/**
 * Builds a real 3-return-per-pulse chunk, `RAYS_PER_PROBE` identical pulses
 * (one physical direction, repeated for `n_min`), each declaring returns at
 * `ranges` (ascending `returnIndex`), through the SAME `buildCellReturns` /
 * `buildGriddedSourceRays` path `observatoryFixtureF5F6F16.test.ts`'s F16
 * group drives — not a hand-assembled `ObservationRayChunk`.
 */
function buildMultiReturnEntry(
  sourceIndex: number,
  origin: Vec3,
  direction: Vec3,
  ranges: readonly number[],
  voxelEdge: number,
): { readonly entry: RayPartitionChunkEntry; readonly chunk: ObservationRayChunkLike } {
  const width = RAYS_PER_PROBE;
  const height = 1;
  const cells = width * height;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(-1);
  const entries: CellReturnInput[] = [];
  let record = 0;
  for (let column = 0; column < width; column++) {
    const idx = cellIndexOf(0, column, width);
    cellToRecord[idx] = record;
    for (let returnIndex = 0; returnIndex < ranges.length; returnIndex++) {
      entries.push({ row: 0, column, record: record++, returnIndex, returnCount: ranges.length, sourceRange: ranges[returnIndex]! });
    }
  }
  const built = buildCellReturns(width, height, entries);
  const frame: OrganizedRangeFrame = {
    id: 'multi-return-probe',
    sourceKind: 'e57-structured',
    width,
    height,
    cellState,
    cellToRecord,
    returnCellStart: built.returnCellStart,
    returnRecord: built.returnRecord,
    returnIndex: built.returnIndex,
    returnCountDeclared: built.returnCountDeclared,
    returnSourceRange: built.returnSourceRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
  const { azimuth, polar } = azimuthPolarOf(direction);
  const coverage: GriddedRayCoverage = { azimuth0: azimuth, azimuthStep: 0, polar0: polar, polarStep: 0 };
  const build = buildGriddedSourceRays(frame, station('multi-return-station', origin), sourceIndex, coverage, { kind: 'none' });
  expect(build.returnedChunks.length).toBe(1);
  expect(build.returnTable).toBeDefined();
  const chunk = build.returnedChunks[0]!;
  const tauAbs = voxelEdge / 2;
  const entry: RayPartitionChunkEntry = {
    sourceIndex,
    chunk,
    tauAbs,
    tauRel: 0,
    returnTable: build.returnTable,
    returnCounts: build.returnTable!.countByRay,
  };
  return { entry, chunk };
}

type ObservationRayChunkLike = ReturnType<typeof buildGriddedSourceRays>['returnedChunks'][number];

function voxelKeyOf(point: Vec3, domain: ObservationDomain, voxelEdge: number, grid: { readonly nx: number; readonly ny: number }): number {
  return packVoxelKey(
    Math.floor((point[0] - domain.min[0]) / voxelEdge),
    Math.floor((point[1] - domain.min[1]) / voxelEdge),
    Math.floor((point[2] - domain.min[2]) / voxelEdge),
    grid.nx,
    grid.ny,
  );
}

describe('multi-return — a voxel hit only by the 2nd (or later) return gets finite angular/incidence/range components', () => {
  const domain: ObservationDomain = { min: [-1, -2, -2], max: [15, 2, 2] };
  const voxelEdge = 1;
  const origin: Vec3 = [0, 0, 0];
  const direction: Vec3 = [1, 0, 0];
  const ranges = [3, 6, 9]; // tauAbs = 0.5: windows [2.5,3.5], [5.5,6.5], [8.5,9.5], well separated.

  const { entry, chunk } = buildMultiReturnEntry(0, origin, direction, ranges, voxelEdge);
  const input: RayPartitionInput = { domain, voxelEdge, stations: [station('multi-return-station', origin)], returnedChunks: [entry], notReadChunks: [] };
  const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
  if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

  const grid = domainGrid(domain, voxelEdge);
  const secondReturnPoint: Vec3 = [origin[0] + direction[0] * ranges[1]!, origin[1] + direction[1] * ranges[1]!, origin[2] + direction[2] * ranges[1]!];
  const secondReturnKey = voxelKeyOf(secondReturnPoint, domain, voxelEdge, grid);
  const firstReturnKey = voxelKeyOf([ranges[0]!, 0, 0], domain, voxelEdge, grid);
  const thirdReturnKey = voxelKeyOf([ranges[2]!, 0, 0], domain, voxelEdge, grid);

  it('the three returns land in three distinct voxels (test setup sanity)', () => {
    expect(new Set([firstReturnKey, secondReturnKey, thirdReturnKey]).size).toBe(3);
  });

  it("the ledger counts a real hit at the 2nd return's voxel, from the multi-return window alone", () => {
    const row = result.rows.find((r) => r.key === secondReturnKey);
    expect(row).toBeDefined();
    expect(row!.counters.hit).toBe(RAYS_PER_PROBE);
  });

  it('accumulateStrengthHitSamples, given the returnTable, samples the 2nd-return-only voxel and yields finite components', () => {
    const raw = accumulateStrengthHitSamples(chunk, 0, origin, domain, voxelEdge, entry.tauAbs, entry.tauRel, grid.nx, grid.ny, entry.returnTable, entry.returnCounts);
    const byVoxel = mergeStrengthHitSamples([raw]);
    const samples = byVoxel.get(secondReturnKey) ?? [];
    expect(samples.length).toBe(RAYS_PER_PROBE);
    for (const s of samples) expect(s.range).toBeCloseTo(ranges[1]!, 6);

    const row = result.rows.find((r) => r.key === secondReturnKey)!;
    const components = computeStrengthComponents(row, samples, [-1, 0, 0], {});
    expect(Number.isNaN(components.angularSpread)).toBe(false);
    expect(Number.isNaN(components.incidence)).toBe(false);
    expect(Number.isNaN(components.rangeFit)).toBe(false);
    expect(components.rangeFit).toBe(1);
  });

  it('WITHOUT the returnTable (single-range reading), the 2nd-return-only voxel gets no sample at all — the bug this phase fixes', () => {
    const raw = accumulateStrengthHitSamples(chunk, 0, origin, domain, voxelEdge, entry.tauAbs, entry.tauRel, grid.nx, grid.ny);
    const byVoxel = mergeStrengthHitSamples([raw]);
    expect(byVoxel.get(secondReturnKey) ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// invariant: strength hit-sample count == ledger hit counter, every voxel
// ---------------------------------------------------------------------------

function assertSampleCountMatchesLedgerHits(
  rows: readonly { readonly key: number; readonly counters: { readonly hit: number } }[],
  byVoxel: ReadonlyMap<number, readonly unknown[]>,
): void {
  for (const row of rows) {
    const count = byVoxel.get(row.key)?.length ?? 0;
    expect(count, `voxel ${row.key}: strength sample count vs ledger hit counter`).toBe(row.counters.hit);
  }
}

describe('OB-INV-style: strength hit-sample count equals the ledger hit counter, per voxel', () => {
  it('holds for F1 (single-return)', () => {
    const domain: ObservationDomain = { min: [-1, -6, -1], max: [16, 6, 6] };
    const voxelEdge = 0.5;
    const wallDomain: ObservationDomain = { min: [5, -2, 0], max: [5.2, 2, 3] };
    const origin: Vec3 = [0, 0, 0];
    const direction = normalize(subtract([5.1, 0, 1.5], origin));
    const wallClip = clipRayToDomain(origin, direction, 0, Infinity, wallDomain)!;
    const wallEntryRange = wallClip.tEntry;
    const { azimuth, polar } = azimuthPolarOf(direction);
    const { frame } = buildRepeatedRayCells(wallEntryRange);
    const build = buildGriddedSourceRays(frame, station('station-1', origin), 0, { azimuth0: azimuth, azimuthStep: 0, polar0: polar, polarStep: 0 }, { kind: 'none' });
    const chunk = build.returnedChunks[0]!;
    const tauAbs = voxelEdge / 2;
    const entry: RayPartitionChunkEntry = { sourceIndex: 0, chunk, tauAbs, tauRel: 0 };
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station('station-1', origin)], returnedChunks: [entry], notReadChunks: [] };
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
    if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

    const grid = domainGrid(domain, voxelEdge);
    const raw = accumulateStrengthHitSamples(chunk, 0, origin, domain, voxelEdge, tauAbs, 0, grid.nx, grid.ny);
    const byVoxel = mergeStrengthHitSamples([raw]);
    assertSampleCountMatchesLedgerHits(result.rows, byVoxel);
  });

  it('holds for a real multi-return fixture (3 returns/pulse)', () => {
    const domain: ObservationDomain = { min: [-1, -2, -2], max: [15, 2, 2] };
    const voxelEdge = 1;
    const origin: Vec3 = [0, 0, 0];
    const direction: Vec3 = [1, 0, 0];
    const { entry, chunk } = buildMultiReturnEntry(0, origin, direction, [3, 6, 9], voxelEdge);
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station('multi-return-station', origin)], returnedChunks: [entry], notReadChunks: [] };
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
    if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

    const grid = domainGrid(domain, voxelEdge);
    const raw = accumulateStrengthHitSamples(chunk, 0, origin, domain, voxelEdge, entry.tauAbs, entry.tauRel, grid.nx, grid.ny, entry.returnTable, entry.returnCounts);
    const byVoxel = mergeStrengthHitSamples([raw]);
    assertSampleCountMatchesLedgerHits(result.rows, byVoxel);
  });

  it('the invariant is partition-invariant too: splitting the multi-return chunk in two still matches the (unpartitioned) ledger per voxel', () => {
    const domain: ObservationDomain = { min: [-1, -2, -2], max: [15, 2, 2] };
    const voxelEdge = 1;
    const origin: Vec3 = [0, 0, 0];
    const direction: Vec3 = [1, 0, 0];
    const { entry, chunk } = buildMultiReturnEntry(0, origin, direction, [3, 6, 9], voxelEdge);
    const input: RayPartitionInput = { domain, voxelEdge, stations: [station('multi-return-station', origin)], returnedChunks: [entry], notReadChunks: [] };
    const result = runObservationLedger(input, { declaredStepBudget: 1_000_000 });
    if (result.status !== 'ok') throw new Error(`test setup: runObservationLedger refused (${result.reason})`);

    const grid = domainGrid(domain, voxelEdge);
    const n = chunk.originIndex.length;
    const half = Math.ceil(n / 2);
    const returnTable = entry.returnTable!;
    const returnCounts = entry.returnCounts!;
    // Whole-ray granularity split: returnOffset/returnCounts stay valid per ray regardless of which sub-chunk a ray lands in, since they index into the SAME shared returnTable.
    const chunkA = { originIndex: chunk.originIndex.slice(0, half), direction: chunk.direction.slice(0, half * 3), range: chunk.range.slice(0, half), returnOffset: chunk.returnOffset.slice(0, half) };
    const chunkB = { originIndex: chunk.originIndex.slice(half), direction: chunk.direction.slice(half * 3), range: chunk.range.slice(half), returnOffset: chunk.returnOffset.slice(half) };
    const countsA = returnCounts.slice(0, half);
    const countsB = returnCounts.slice(half);

    const raw = mergeStrengthHitSamples([
      accumulateStrengthHitSamples(chunkA, 0, origin, domain, voxelEdge, entry.tauAbs, entry.tauRel, grid.nx, grid.ny, returnTable, countsA),
      accumulateStrengthHitSamples(chunkB, 0, origin, domain, voxelEdge, entry.tauAbs, entry.tauRel, grid.nx, grid.ny, returnTable, countsB),
    ]);
    assertSampleCountMatchesLedgerHits(result.rows, raw);
  });
});
