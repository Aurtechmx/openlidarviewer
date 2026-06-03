/**
 * terrainPartition.test.ts
 */

import { describe, it, expect } from 'vitest';
import {
  bboxQuery,
  buildGrid,
  buildNeighborhood,
  buildTilesFromGrid,
  filterResident,
  radiusQuery,
} from '../src/terrain/TerrainPartition';

function pts(xys: ReadonlyArray<[number, number, number]>): Float32Array {
  const out = new Float32Array(xys.length * 3);
  for (let i = 0; i < xys.length; i++) {
    out[i * 3] = xys[i][0];
    out[i * 3 + 1] = xys[i][1];
    out[i * 3 + 2] = xys[i][2];
  }
  return out;
}

describe('buildGrid', () => {
  it('returns an empty grid for an empty buffer', () => {
    const g = buildGrid(new Float32Array(0), 1);
    expect(g.cells.length).toBe(0);
    expect(g.cols).toBe(0);
  });

  it('lays out cols × rows over the bbox', () => {
    const g = buildGrid(pts([[0, 0, 0], [10, 10, 0]]), 5);
    expect(g.cols).toBeGreaterThan(0);
    expect(g.rows).toBeGreaterThan(0);
    expect(g.cellSize).toBe(5);
  });

  it('throws on non-positive cellSize', () => {
    expect(() => buildGrid(pts([[0, 0, 0]]), 0)).toThrow();
  });
});

describe('buildTilesFromGrid', () => {
  it('skips empty cells', () => {
    const positions = pts([[0, 0, 0], [9, 9, 1]]);
    const grid = buildGrid(positions, 5);
    const tiles = buildTilesFromGrid(grid, positions);
    expect(tiles.length).toBe(2);
  });

  it('each tile carries its bounding box', () => {
    const positions = pts([[0, 0, 5], [1, 1, 10], [9, 9, -3]]);
    const grid = buildGrid(positions, 5);
    const tiles = buildTilesFromGrid(grid, positions);
    for (const t of tiles) {
      expect(t.max.z).toBeGreaterThanOrEqual(t.min.z);
    }
  });
});

describe('radiusQuery', () => {
  it('returns only points within the radius', () => {
    const positions = pts([
      [0, 0, 0],
      [1, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
    ]);
    const grid = buildGrid(positions, 2);
    const out = radiusQuery(grid, positions, 0, 0, 2);
    expect(out.length).toBe(2);
  });

  it('returns empty for zero radius', () => {
    const positions = pts([[0, 0, 0]]);
    const grid = buildGrid(positions, 1);
    expect(radiusQuery(grid, positions, 0, 0, 0).length).toBe(0);
  });
});

describe('bboxQuery', () => {
  it('returns points inside the bbox', () => {
    const positions = pts([
      [1, 1, 0],
      [5, 5, 0],
      [-1, -1, 0],
    ]);
    const grid = buildGrid(positions, 2);
    const out = bboxQuery(grid, positions, 0, 0, 6, 6);
    expect(out.length).toBe(2);
  });
});

describe('buildNeighborhood', () => {
  it('centre is excluded from samples', () => {
    const positions = pts([
      [0, 0, 0], // index 0
      [1, 0, 0],
      [-1, 0, 0],
    ]);
    const grid = buildGrid(positions, 1);
    const nh = buildNeighborhood(grid, positions, 0, 5);
    expect(nh.centre.sourceIndex).toBe(0);
    for (const s of nh.samples) expect(s.sourceIndex).not.toBe(0);
  });
});

describe('filterResident', () => {
  it('keeps only resident indices', () => {
    const out = filterResident([1, 2, 3, 4], (i) => i % 2 === 0);
    expect(out).toEqual([2, 4]);
  });
});
