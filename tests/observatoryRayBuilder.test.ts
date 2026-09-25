/**
 * observatoryRayBuilder.test.ts — OB-RAY-01, OB-RAY-02, OB-RAY-04, OB-RAY-05
 * (docs/observatory/SPEC.md §5.1, phase O3).
 *
 * F5/F6/F16's ray-level fixtures live in
 * `tests/observatoryFixtureF5F6F16.test.ts`; this file covers the rest of
 * the ray builder's declared behaviour directly, on hand-built frames.
 */
import { describe, expect, it } from 'vitest';
import {
  CellState,
  NO_RECORD,
  buildCellReturns,
  cellIndexOf,
  tallyCellStates,
  type CellReturnInput,
  type CellStateValue,
  type OrganizedRangeFrame,
} from '../src/model/OrganizedRange';
import type { AcquisitionStation } from '../src/model/AcquisitionStations';
import {
  RAY_CHUNK_SIZE,
  buildGriddedSourceRays,
  buildUnstructuredSourceRays,
  type GriddedRayCoverage,
  type GriddedRayPositions,
} from '../src/observation/rays';

const STATION_ORIGIN: readonly [number, number, number] = [10, -20, 30];

function station(overrides?: Partial<AcquisitionStation>): AcquisitionStation {
  return {
    id: 'station-1',
    source: 'ptx-block',
    pose: { worldTranslation: STATION_ORIGIN, localPositionSource: 'not-applicable' },
    recordRange: { start: 0, end: 0 },
    originStatus: 'DECLARED',
    ...overrides,
  };
}

const COVERAGE: GriddedRayCoverage = {
  azimuth0: 0.2,
  azimuthStep: 0.11,
  polar0: 1.15,
  polarStep: 0.07,
};

function unitLength(v: readonly [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** A width×height grid, every cell VALID_RETURN with a declared geometricRange, unless overridden. */
function makeGridFrame(
  width: number,
  height: number,
  overrides: ReadonlyMap<string, CellStateValue>,
): OrganizedRangeFrame {
  const cells = width * height;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(NO_RECORD);
  const geometricRange = new Float32Array(cells).fill(Number.NaN);
  let record = 0;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const idx = cellIndexOf(row, column, width);
      const state = overrides.get(`${row},${column}`);
      if (state !== undefined) {
        cellState[idx] = state;
        continue;
      }
      cellToRecord[idx] = record++;
      geometricRange[idx] = 5 + row * 0.5 + column * 0.25;
    }
  }
  return {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    geometricRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
}

describe('OB-RAY-01 — gridded VALID_RETURN', () => {
  it('every VALID_RETURN cell yields a finite Float32 range and a unit-length direction', () => {
    const frame = makeGridFrame(3, 3, new Map());
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' });
    expect(build.returnedChunks).toHaveLength(1);
    const chunk = build.returnedChunks[0]!;
    expect(chunk.range.length).toBe(9);
    for (let k = 0; k < 9; k++) {
      expect(Number.isFinite(chunk.range[k])).toBe(true);
      const d: [number, number, number] = [chunk.direction[k * 3]!, chunk.direction[k * 3 + 1]!, chunk.direction[k * 3 + 2]!];
      expect(unitLength(d)).toBeCloseTo(1, 5);
      expect(chunk.originIndex[k]).toBe(0);
    }
    expect(build.notReadChunks).toHaveLength(0);
    expect(build.excludedCount).toBe(0);
    expect(build.returnTable).toBeUndefined();
  });

  it('falls back to a Float64 position-derived range when geometricRange is absent (structured E57 / PCD)', () => {
    const width = 2;
    const height = 1;
    const cellState = new Uint8Array([CellState.VALID_RETURN, CellState.VALID_RETURN]);
    const cellToRecord = new Int32Array([0, 1]);
    const frame: OrganizedRangeFrame = {
      id: 'scan-1',
      sourceKind: 'e57-structured',
      width,
      height,
      cellState,
      cellToRecord,
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
    };
    const cloudSourceOrigin: readonly [number, number, number] = [100, 200, 300];
    // Record positions are SOURCE-LOCAL (relative to cloudSourceOrigin). Placing
    // record 0 exactly 4m along +x from the station, in WORLD terms, means its
    // source-local coordinate is (stationWorld + [4,0,0]) - cloudSourceOrigin.
    const stationWorld = STATION_ORIGIN;
    const p0: [number, number, number] = [
      stationWorld[0] + 4 - cloudSourceOrigin[0],
      stationWorld[1] - cloudSourceOrigin[1],
      stationWorld[2] - cloudSourceOrigin[2],
    ];
    const p1: [number, number, number] = [
      stationWorld[0] - cloudSourceOrigin[0],
      stationWorld[1] + 3 - cloudSourceOrigin[1],
      stationWorld[2] - cloudSourceOrigin[2],
    ];
    const positions = Float32Array.from([...p0, ...p1]);
    const fallback: GriddedRayPositions = { sourceLocal: positions, cloudSourceOrigin };
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' }, fallback);
    const chunk = build.returnedChunks[0]!;
    expect(chunk.range[0]).toBeCloseTo(4, 4);
    expect(chunk.range[1]).toBeCloseTo(3, 4);
  });

  it('throws rather than inventing a range when neither geometricRange nor fallback positions exist', () => {
    const width = 1;
    const height = 1;
    const cellState = new Uint8Array([CellState.VALID_RETURN]);
    const cellToRecord = new Int32Array([0]);
    const frame: OrganizedRangeFrame = {
      id: 'scan-1',
      sourceKind: 'e57-structured',
      width,
      height,
      cellState,
      cellToRecord,
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
    };
    expect(() => buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' })).toThrow();
  });

  it('excludes, rather than returns a zero/NaN range, a cell whose fallback position is coincident with the station', () => {
    const width = 2;
    const height = 1;
    const cellState = new Uint8Array([CellState.VALID_RETURN, CellState.VALID_RETURN]);
    const cellToRecord = new Int32Array([0, 1]);
    const frame: OrganizedRangeFrame = {
      id: 'scan-1',
      sourceKind: 'e57-structured',
      width,
      height,
      cellState,
      cellToRecord,
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
    };
    const cloudSourceOrigin: readonly [number, number, number] = [0, 0, 0];
    const stationWorld = STATION_ORIGIN;
    // Record 0 sits exactly at the station: a degenerate, zero-length range.
    // Record 1 is a normal 5m return.
    const p0: [number, number, number] = [stationWorld[0], stationWorld[1], stationWorld[2]];
    const p1: [number, number, number] = [stationWorld[0] + 5, stationWorld[1], stationWorld[2]];
    const positions = Float32Array.from([...p0, ...p1]);
    const fallback: GriddedRayPositions = { sourceLocal: positions, cloudSourceOrigin };
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' }, fallback);
    expect(build.excludedCount).toBe(1);
    const returnedCount = build.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(returnedCount).toBe(1);
    expect(build.returnedChunks[0]!.range[0]).toBeCloseTo(5, 4);
  });
});

describe('OB-RAY-01 — SOURCE_INVALID / SOURCE_RECORD_MISSING give no ray but are counted', () => {
  it('excludedCount equals stateCounts[SOURCE_INVALID] + stateCounts[SOURCE_RECORD_MISSING]', () => {
    const overrides = new Map<string, CellStateValue>([
      ['0,0', CellState.SOURCE_INVALID],
      ['1,1', CellState.SOURCE_RECORD_MISSING],
      ['2,2', CellState.SOURCE_RECORD_MISSING],
    ]);
    const frame = makeGridFrame(3, 3, overrides);
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' });
    expect(build.excludedCount).toBe(3);
    expect(
      frame.diagnostics.stateCounts[CellState.SOURCE_INVALID] +
        frame.diagnostics.stateCounts[CellState.SOURCE_RECORD_MISSING],
    ).toBe(3);
    // Neither state contributes a ray to either pool: 9 cells, 3 excluded, 6 returned.
    const returnedCount = build.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(returnedCount).toBe(6);
    expect(build.notReadChunks).toHaveLength(0);
  });
});

describe('OB-RAY-02 — posed unstructured points', () => {
  it('direction is normalize(hit - origin) and range is the Float64 distance, computed before recentring', () => {
    const cloudSourceOrigin: readonly [number, number, number] = [1000, 2000, 3000];
    const stationWorld: readonly [number, number, number] = [1010, 2005, 3000];
    const st = station({
      pose: { worldTranslation: stationWorld, localPositionSource: 'not-applicable' },
      recordRange: { start: 0, end: 2 },
      source: 'e57-scan',
    });
    // Record 0: 3m along +x from the station, in world terms.
    const p0World: readonly [number, number, number] = [stationWorld[0] + 3, stationWorld[1], stationWorld[2]];
    // Record 1: 4m along +y from the station.
    const p1World: readonly [number, number, number] = [stationWorld[0], stationWorld[1] + 4, stationWorld[2]];
    const positions = Float32Array.from([
      p0World[0] - cloudSourceOrigin[0],
      p0World[1] - cloudSourceOrigin[1],
      p0World[2] - cloudSourceOrigin[2],
      p1World[0] - cloudSourceOrigin[0],
      p1World[1] - cloudSourceOrigin[1],
      p1World[2] - cloudSourceOrigin[2],
    ]);
    const build = buildUnstructuredSourceRays(positions, st, 2, cloudSourceOrigin, { kind: 'none' });
    expect(build.notReadChunks).toHaveLength(0);
    const chunk = build.returnedChunks[0]!;
    expect(chunk.originIndex.length).toBe(2);
    expect(chunk.originIndex[0]).toBe(2);
    expect(chunk.range[0]).toBeCloseTo(3, 4);
    expect(chunk.range[1]).toBeCloseTo(4, 4);
    expect(chunk.direction[0]).toBeCloseTo(1, 4); // +x
    expect(chunk.direction[1]).toBeCloseTo(0, 4);
    expect(chunk.direction[2]).toBeCloseTo(0, 4);
    expect(chunk.direction[3]).toBeCloseTo(0, 4);
    expect(chunk.direction[4]).toBeCloseTo(1, 4); // +y
    expect(chunk.direction[5]).toBeCloseTo(0, 4);
  });

  it('never produces a not-read ray (NO_RETURN_PATH is unavailable for unstructured sources)', () => {
    const st = station({ recordRange: { start: 0, end: 3 } });
    const positions = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const cloudSourceOrigin: readonly [number, number, number] = [0, 0, 0];
    const build = buildUnstructuredSourceRays(positions, st, 0, cloudSourceOrigin, { kind: 'none' });
    expect(build.notReadChunks).toEqual([]);
    expect(build.returnTable).toBeUndefined();
  });
});

describe('OB-RAY-04 — bounded chunking', () => {
  it('a source with more than RAY_CHUNK_SIZE rays splits into multiple chunks, none exceeding RAY_CHUNK_SIZE', () => {
    const total = RAY_CHUNK_SIZE + 10;
    const st = station({ recordRange: { start: 0, end: total } });
    const positions = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      // Spread points so every direction is non-degenerate.
      positions[i * 3] = 1 + (i % 7);
      positions[i * 3 + 1] = 1 + (i % 5);
      positions[i * 3 + 2] = 1;
    }
    const build = buildUnstructuredSourceRays(positions, st, 0, [0, 0, 0], { kind: 'none' });
    expect(build.returnedChunks.length).toBeGreaterThan(1);
    let sum = 0;
    for (const chunk of build.returnedChunks) {
      expect(chunk.originIndex.length).toBeLessThanOrEqual(RAY_CHUNK_SIZE);
      sum += chunk.originIndex.length;
    }
    expect(sum).toBe(total);
    expect(build.returnedChunks[build.returnedChunks.length - 1]!.originIndex.length).toBe(10);
  });
});

describe('OB-RAY-05 — grid-stride subsampling', () => {
  it('skips every cell off the k-th row/column, and the field carries the input k, never basis full', () => {
    const frame = makeGridFrame(6, 6, new Map());
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'grid-stride', k: 3 });
    expect(build.subsampling).toEqual({ kind: 'grid-stride', k: 3 });
    // rows/columns 0 and 3 survive -> 2x2 = 4 rays, and nothing excluded (a
    // skipped cell contributes to neither pool nor the exclusion count).
    const returnedCount = build.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(returnedCount).toBe(4);
    expect(build.excludedCount).toBe(0);
  });
});

describe('OB-RAY-05 — hash-threshold subsampling', () => {
  it('is deterministic: two runs with the same threshold and record indices produce byte-identical ray sets', () => {
    const st = station({ recordRange: { start: 0, end: 200 } });
    const positions = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      positions[i * 3] = 1 + (i % 11);
      positions[i * 3 + 1] = 1 + (i % 13);
      positions[i * 3 + 2] = 1;
    }
    const sub = { kind: 'hash-threshold' as const, threshold: 0.3 };
    const a = buildUnstructuredSourceRays(positions, st, 0, [0, 0, 0], sub);
    const b = buildUnstructuredSourceRays(positions, st, 0, [0, 0, 0], sub);
    expect(a.returnedChunks.length).toBe(b.returnedChunks.length);
    for (let i = 0; i < a.returnedChunks.length; i++) {
      expect(a.returnedChunks[i]!.originIndex).toEqual(b.returnedChunks[i]!.originIndex);
      expect(a.returnedChunks[i]!.direction).toEqual(b.returnedChunks[i]!.direction);
      expect(a.returnedChunks[i]!.range).toEqual(b.returnedChunks[i]!.range);
    }
    // A real threshold strictly between 0 and 1 must exclude at least one of
    // 200 records and keep at least one, or the fixture proves nothing.
    const keptCount = a.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(keptCount).toBeGreaterThan(0);
    expect(keptCount).toBeLessThan(200);
  });
});

/** One VALID_RETURN cell whose CSR span holds two returns: the first at `firstRange` (null = none declared), the second at 9. */
function twoReturnCellFrame(firstRange: number | null): OrganizedRangeFrame {
  const entries: CellReturnInput[] = [
    { row: 0, column: 0, record: 0, returnIndex: 0, returnCount: 2, sourceRange: firstRange },
    { row: 0, column: 0, record: 1, returnIndex: 1, returnCount: 2, sourceRange: 9 },
  ];
  const built = buildCellReturns(1, 1, entries);
  const cellState = new Uint8Array([CellState.VALID_RETURN]);
  return {
    id: 'scan-1',
    sourceKind: 'e57-structured',
    width: 1,
    height: 1,
    cellState,
    cellToRecord: new Int32Array([0]),
    returnCellStart: built.returnCellStart,
    returnRecord: built.returnRecord,
    returnIndex: built.returnIndex,
    returnCountDeclared: built.returnCountDeclared,
    returnSourceRange: built.returnSourceRange,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
}

describe('OB-RAY-03 — multi-return ray/return-table shape (unit-level, ahead of F16)', () => {
  it('one VALID_RETURN cell with a two-return CSR span contributes one ray and a two-entry return table group', () => {
    const frame = twoReturnCellFrame(8);
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' });
    expect(build.returnedChunks[0]!.originIndex.length).toBe(1);
    expect(build.returnTable).toBeDefined();
    expect(build.returnTable!.countByRay).toEqual(Uint16Array.from([2]));
    expect(Array.from(build.returnTable!.range)).toEqual([8, 9]);
    expect(build.returnedChunks[0]!.range[0]).toBeCloseTo(8, 5);
    expect(build.returnedChunks[0]!.returnOffset[0]).toBe(0);
  });

  it('excludes a multi-return cell whose primary (start-entry) range is degenerate, and leaves the return table untouched for it', () => {
    const frame = twoReturnCellFrame(null);
    const cloudSourceOrigin: readonly [number, number, number] = [0, 0, 0];
    const stationWorld = STATION_ORIGIN;
    // Record 0 (the start entry, no declared sourceRange) sits exactly at the
    // station: a degenerate, zero-length derived range.
    const positions = Float32Array.from([
      stationWorld[0],
      stationWorld[1],
      stationWorld[2],
      stationWorld[0] + 9,
      stationWorld[1],
      stationWorld[2],
    ]);
    const fallback: GriddedRayPositions = { sourceLocal: positions, cloudSourceOrigin };
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' }, fallback);
    expect(build.excludedCount).toBe(1);
    expect(build.returnedChunks).toHaveLength(0);
    expect(build.returnTable).toBeDefined();
    expect(build.returnTable!.range.length).toBe(0);
    expect(build.returnTable!.countByRay.length).toBe(0);
  });

  it('return-table buffers stay correctly indexed across a NO_RETURN cell, an excluded cell and two multi-return cells in one walk', () => {
    const width = 2;
    const height = 2;
    // Row-major: (0,0) NO_RETURN, (0,1) VALID_RETURN x3, (1,0) SOURCE_INVALID, (1,1) VALID_RETURN x1.
    const cellState = new Uint8Array([
      CellState.NO_RETURN,
      CellState.VALID_RETURN,
      CellState.SOURCE_INVALID,
      CellState.VALID_RETURN,
    ]);
    const cellToRecord = new Int32Array([NO_RECORD, 10, NO_RECORD, 13]);
    const entries: CellReturnInput[] = [
      { row: 0, column: 1, record: 10, returnIndex: 0, returnCount: 3, sourceRange: 1 },
      { row: 0, column: 1, record: 11, returnIndex: 1, returnCount: 3, sourceRange: 2 },
      { row: 0, column: 1, record: 12, returnIndex: 2, returnCount: 3, sourceRange: 3 },
      { row: 1, column: 1, record: 13, returnIndex: 0, returnCount: 1, sourceRange: 4 },
    ];
    const built = buildCellReturns(width, height, entries);
    const frame: OrganizedRangeFrame = {
      id: 'scan-1',
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
    const build = buildGriddedSourceRays(frame, station(), 0, COVERAGE, { kind: 'none' });
    expect(build.excludedCount).toBe(1);
    const returnedCount = build.returnedChunks.reduce((n, c) => n + c.originIndex.length, 0);
    expect(returnedCount).toBe(3); // NO_RETURN ray + two VALID_RETURN rays.
    expect(build.returnTable).toBeDefined();
    expect(build.returnTable!.countByRay).toEqual(Uint16Array.from([0, 3, 1]));
    expect(Array.from(build.returnTable!.range)).toEqual([1, 2, 3, 4]);
  });
});
