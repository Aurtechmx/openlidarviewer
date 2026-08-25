/**
 * acquisitionCoverage.test.ts
 *
 * Known-truth fixtures for the ray-coverage core. Every grid here is NON-SQUARE
 * (7 columns by 5 rows), so a transposed index cannot pass by symmetry.
 *
 * The verdicts under test are about RAY COVERAGE only. No assertion below reads
 * a no return as a property of a surface, and occlusion is not modelled by the
 * code or by these fixtures.
 */

import { describe, it, expect } from 'vitest';
import {
  CellState,
  cellIndexOf,
  NO_RECORD,
  tallyCellStates,
  type CellStateValue,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from '../src/model/OrganizedRange';
import { PointCloud } from '../src/model/PointCloud';
import { buildDsm } from '../src/terrain/surface/buildDsm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import {
  buildAcquisitionCoverage,
  coverageAtWorldPoint,
  type CoverageVerdict,
} from '../src/model/acquisitionCoverage';

const WIDTH = 7;
const HEIGHT = 5;
const AZIMUTH_0 = 0.2;
const AZIMUTH_STEP = 0.11;
const POLAR_0 = 1.15;
const POLAR_STEP = 0.07;
const RANGE = 6;

type Vec3 = readonly [number, number, number];

/** The world direction the fixture grid assigns to a cell, up axis 'z'. */
function directionOf(row: number, column: number): Vec3 {
  const azimuth = AZIMUTH_0 + AZIMUTH_STEP * column;
  const polar = POLAR_0 + POLAR_STEP * row;
  return [
    Math.sin(polar) * Math.cos(azimuth),
    Math.sin(polar) * Math.sin(azimuth),
    Math.cos(polar),
  ];
}

function pointOf(origin: Vec3, row: number, column: number, range = RANGE): Vec3 {
  const d = directionOf(row, column);
  return [origin[0] + d[0] * range, origin[1] + d[1] * range, origin[2] + d[2] * range];
}

interface Fixture {
  readonly frame: OrganizedRangeFrame;
  readonly positions: readonly Vec3[];
}

/**
 * Build one setup. `states` maps a cell to a non-default state; every other cell
 * is a valid return that produced a record, which is what the angular extent is
 * fitted from.
 */
function makeFixture(
  id: string,
  origin: Vec3,
  states: ReadonlyMap<string, CellStateValue>,
): Fixture {
  const cells = WIDTH * HEIGHT;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(NO_RECORD);
  const positions: Vec3[] = [];
  for (let row = 0; row < HEIGHT; row++) {
    for (let column = 0; column < WIDTH; column++) {
      const idx = cellIndexOf(row, column, WIDTH);
      const override = states.get(`${row},${column}`);
      if (override !== undefined) {
        cellState[idx] = override;
        continue;
      }
      cellToRecord[idx] = positions.length;
      positions.push(pointOf(origin, row, column));
    }
  }
  return {
    frame: {
      id,
      sourceKind: 'ptx-grid',
      width: WIDTH,
      height: HEIGHT,
      cellState,
      cellToRecord,
      acquisitionPose: { worldTranslation: origin, localPositionSource: 'not-applicable' },
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
    },
    positions,
  };
}

function setOf(...frames: OrganizedRangeFrame[]): OrganizedRangeSet {
  return {
    kind: 'organized-range',
    frames,
    organization: frames.length > 1 ? 'multi-grid' : 'organized-grid',
  };
}

const ORIGIN: Vec3 = [10, -20, 30];

/** A grid where a few cells carry states other than a valid return. */
const MIXED_STATES = new Map<string, CellStateValue>([
  ['2,3', CellState.NO_RETURN],
  ['3,1', CellState.NOT_DECODED],
  ['1,3', CellState.NO_RETURN],
  ['4,6', CellState.SOURCE_RECORD_MISSING],
  ['0,0', CellState.SOURCE_INVALID],
]);

function verdictAtCell(row: number, column: number): CoverageVerdict {
  const fixture = makeFixture('a', ORIGIN, MIXED_STATES);
  const index = buildAcquisitionCoverage(setOf(fixture.frame), {
    recordPosition: (r) => fixture.positions[r] ?? null,
  });
  const p = pointOf(ORIGIN, row, column, 12);
  return coverageAtWorldPoint(index, p[0], p[1], p[2]);
}

describe('acquisition ray coverage', () => {
  it('reads a no-return cell inside a setup grid as interrogated', () => {
    expect(verdictAtCell(2, 3)).toBe('interrogated');
  });

  it('reads a valid-return cell as interrogated', () => {
    expect(verdictAtCell(2, 2)).toBe('interrogated');
  });

  it('reads a source-invalid cell as interrogated: a record existed, so a ray was fired', () => {
    expect(verdictAtCell(0, 0)).toBe('interrogated');
  });

  it('reads a not-decoded cell as uninterrogated: a sampling decision is not an observation', () => {
    expect(verdictAtCell(3, 1)).toBe('uninterrogated');
  });

  it('reads a source-record-missing cell as uninterrogated', () => {
    expect(verdictAtCell(4, 6)).toBe('uninterrogated');
  });

  it('distinguishes a cell from its transpose on a non-square grid', () => {
    // (3,1) is not decoded; (1,3) is a no return. A transposed lookup would
    // swap these two verdicts, and a transposed FIT would lose both.
    expect(verdictAtCell(3, 1)).toBe('uninterrogated');
    expect(verdictAtCell(1, 3)).toBe('interrogated');
  });

  it('reads a direction outside every grid as uninterrogated', () => {
    const fixture = makeFixture('a', ORIGIN, MIXED_STATES);
    const index = buildAcquisitionCoverage(setOf(fixture.frame), {
      recordPosition: (r) => fixture.positions[r] ?? null,
    });
    // Well past the last column, and well above the first row.
    const beyondColumn = pointOf(ORIGIN, 2, WIDTH + 9, 12);
    expect(coverageAtWorldPoint(index, beyondColumn[0], beyondColumn[1], beyondColumn[2])).toBe(
      'uninterrogated',
    );
    const beyondRow = pointOf(ORIGIN, -8, 3, 12);
    expect(coverageAtWorldPoint(index, beyondRow[0], beyondRow[1], beyondRow[2])).toBe(
      'uninterrogated',
    );
    // Straight down from the setup is outside a grid that never looks there.
    expect(coverageAtWorldPoint(index, ORIGIN[0], ORIGIN[1], ORIGIN[2] - 50)).toBe(
      'uninterrogated',
    );
  });

  it('lets one setup cover what another misses', () => {
    const a = makeFixture('a', ORIGIN, MIXED_STATES);
    // A second setup one metre away, whose grid is entirely valid returns, so
    // it describes the direction the first setup left not decoded.
    const originB: Vec3 = [ORIGIN[0] + 1, ORIGIN[1], ORIGIN[2]];
    const b = makeFixture('b', originB, new Map());

    const target = pointOf(ORIGIN, 3, 1, 12);
    const onlyA = buildAcquisitionCoverage(setOf(a.frame), {
      recordPosition: (r) => a.positions[r] ?? null,
    });
    expect(coverageAtWorldPoint(onlyA, target[0], target[1], target[2])).toBe('uninterrogated');

    const both = buildAcquisitionCoverage(setOf(a.frame, b.frame), {
      recordPosition: (r) => {
        // Both frames index their own record stream in this fixture; the second
        // setup's grid is dense, so its records cover the whole array.
        return b.positions[r] ?? a.positions[r] ?? null;
      },
    });
    expect(coverageAtWorldPoint(both, target[0], target[1], target[2])).toBe('interrogated');
  });

  it('says indeterminate, never uninterrogated, for a cloud with no acquisition grid', () => {
    const index = buildAcquisitionCoverage(undefined, { recordPosition: () => null });
    expect(index).toBeNull();
    expect(coverageAtWorldPoint(index, 1, 2, 3)).toBe('indeterminate');
  });

  it('refuses a frame whose declared grid is larger than the buffer that exists', () => {
    const fixture = makeFixture('a', ORIGIN, MIXED_STATES);
    const lying: OrganizedRangeFrame = { ...fixture.frame, width: 40_000, height: 30_000 };
    const index = buildAcquisitionCoverage(setOf(lying), {
      recordPosition: (r) => fixture.positions[r] ?? null,
    });
    expect(index?.setups).toHaveLength(0);
    expect(index?.unfittedFrames).toBe(1);
    expect(coverageAtWorldPoint(index, 1, 2, 3)).toBe('indeterminate');
  });

  it('says indeterminate for a frame with no acquisition pose', () => {
    const fixture = makeFixture('a', ORIGIN, MIXED_STATES);
    const poseless: OrganizedRangeFrame = { ...fixture.frame, acquisitionPose: undefined };
    const index = buildAcquisitionCoverage(setOf(poseless), {
      recordPosition: (r) => fixture.positions[r] ?? null,
    });
    expect(index?.unfittedFrames).toBe(1);
    expect(coverageAtWorldPoint(index, 1, 2, 3)).toBe('indeterminate');
  });
});

describe('ordinary clouds pay nothing', () => {
  const points: TerrainPoint[] = [];
  for (let i = 0; i < 400; i++) {
    points.push({ x: (i % 20) * 0.5, y: Math.floor(i / 20) * 0.5, z: Math.sin(i) });
  }
  const spec = { originH1: 0, originH2: 0, cols: 12, rows: 9, cellSizeM: 0.9 };

  it('returns null for a cloud with no acquisition grid, without reading a record', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'plain.las',
    });
    let reads = 0;
    const index = buildAcquisitionCoverage(cloud.organizedRange, {
      recordPosition: () => {
        reads++;
        return null;
      },
    });
    expect(index).toBeNull();
    expect(reads).toBe(0);
  });

  it('leaves the surface raster byte-identical whether or not coverage was prepared', () => {
    const before = buildDsm(points, { grid: spec });
    const fixture = makeFixture('a', ORIGIN, MIXED_STATES);
    buildAcquisitionCoverage(setOf(fixture.frame), {
      recordPosition: (r) => fixture.positions[r] ?? null,
    });
    const after = buildDsm(points, { grid: spec });
    expect(new Uint8Array(after.z.buffer)).toEqual(new Uint8Array(before.z.buffer));
    expect(new Uint8Array(after.coverage.buffer)).toEqual(new Uint8Array(before.coverage.buffer));
  });
});
