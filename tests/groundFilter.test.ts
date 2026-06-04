/**
 * groundFilter.test.ts
 *
 * Phase A1 unit specs for the SMRF ground classifier. Exercises the
 * algorithm against a synthetic scene with known ground truth (flat
 * earth + an occluding building block + isolated tree returns) so the
 * assertions are about recall/precision, not eyeballed output. Also
 * pins the morphology helpers directly.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyGroundSmrf,
  inpaintNearest,
  morphOpen,
  surfaceSlope,
  type GroundFilterParams,
} from '../src/terrain/ground/groundFilter';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const PARAMS: GroundFilterParams = {
  cellSizeM: 1,
  maxWindowCells: 5,
  slope: 0.15,
  elevationThresholdM: 0.5,
  scalingFactorM: 0,
};

/**
 * 21x21 m flat ground at z=0, 1 m spacing. A 5x5 m building (x,y in
 * 8..12) occludes the ground beneath it — those cells carry ONLY roof
 * returns at z=6 (the realistic, harder case). Two isolated tree
 * returns at z=10 sit over otherwise-ground cells.
 */
function buildScene(): {
  points: TerrainPoint[];
  groundIdx: number[];
  roofIdx: number[];
  treeIdx: number[];
} {
  const points: TerrainPoint[] = [];
  const groundIdx: number[] = [];
  const roofIdx: number[] = [];
  const treeIdx: number[] = [];
  const inBuilding = (x: number, y: number) => x >= 8 && x <= 12 && y >= 8 && y <= 12;
  for (let x = 0; x <= 20; x++) {
    for (let y = 0; y <= 20; y++) {
      if (inBuilding(x, y)) {
        roofIdx.push(points.length);
        points.push({ x, y, z: 6 });
      } else {
        groundIdx.push(points.length);
        points.push({ x, y, z: 0 });
      }
    }
  }
  // Two trees over ground cells (the ground point below them already
  // exists in groundIdx).
  treeIdx.push(points.length);
  points.push({ x: 3, y: 3, z: 10 });
  treeIdx.push(points.length);
  points.push({ x: 16, y: 4, z: 10 });
  return { points, groundIdx, roofIdx, treeIdx };
}

describe('classifyGroundSmrf', () => {
  it('classifies flat ground with high recall', () => {
    const { points, groundIdx } = buildScene();
    const res = classifyGroundSmrf(points, PARAMS);
    const recalled = groundIdx.filter((i) => res.isGround[i] === 1).length;
    expect(recalled / groundIdx.length).toBeGreaterThanOrEqual(0.98);
  });

  it('rejects building roof returns over occluded ground', () => {
    const { points, roofIdx } = buildScene();
    const res = classifyGroundSmrf(points, PARAMS);
    const rejected = roofIdx.filter((i) => res.isGround[i] === 0).length;
    expect(rejected / roofIdx.length).toBeGreaterThanOrEqual(0.9);
  });

  it('the elevation-threshold cap stops a loose tolerance admitting low objects on slopes', () => {
    // Tilted ground (slope 0.3) plus a flat object ~3 m above the surface.
    const pts: TerrainPoint[] = [];
    const obj: number[] = [];
    for (let x = 0; x <= 20; x++) for (let y = 0; y <= 20; y++) pts.push({ x, y, z: 0.3 * x });
    for (let x = 9; x <= 11; x++)
      for (let y = 9; y <= 11; y++) {
        obj.push(pts.length);
        pts.push({ x, y, z: 0.3 * x + 3 });
      }
    // A high slope-scaling factor would, uncapped, inflate the tolerance to
    // ~15 m on this slope and swallow the object as "ground".
    const base = {
      cellSizeM: 1,
      maxWindowCells: 5,
      slope: 0.3,
      elevationThresholdM: 0.5,
      scalingFactorM: 50,
    } as const;
    const objGround = (r: { isGround: Uint8Array }): number =>
      obj.filter((i) => r.isGround[i] === 1).length;
    const uncapped = classifyGroundSmrf(pts, { ...base, maxElevationThresholdM: Infinity });
    const capped = classifyGroundSmrf(pts, { ...base, maxElevationThresholdM: 0.5 });
    expect(objGround(uncapped)).toBeGreaterThan(objGround(capped));
    expect(objGround(capped)).toBe(0); // the cap excludes the object entirely
  });

  it('rejects isolated tree returns', () => {
    const { points, treeIdx } = buildScene();
    const res = classifyGroundSmrf(points, PARAMS);
    for (const i of treeIdx) expect(res.isGround[i]).toBe(0);
  });

  it('pulls the ground surface down under the building (opening removes it)', () => {
    const { points } = buildScene();
    const res = classifyGroundSmrf(points, PARAMS);
    // Building centre is x=10,y=10 → col=10,row=10 (origin 0, cell 1).
    const centre = 10 * res.cols + 10;
    expect(res.groundSurface[centre]).toBeLessThan(1);
  });

  it('is deterministic (same input → identical output)', () => {
    const { points } = buildScene();
    const a = classifyGroundSmrf(points, PARAMS);
    const b = classifyGroundSmrf(points, PARAMS);
    expect(Array.from(a.isGround)).toEqual(Array.from(b.isGround));
    expect(Array.from(a.groundSurface)).toEqual(Array.from(b.groundSurface));
  });

  it('carries the honesty/coverage envelope', () => {
    const { points } = buildScene();
    const res = classifyGroundSmrf(points, PARAMS);
    expect(res.coverage).toBe('full');
    expect(res.sourcePointCount).toBe(points.length);
    expect(res.analyzedPointCount).toBe(points.length);
    expect(res.groundPointCount).toBeGreaterThan(0);
    expect(Array.isArray(res.warnings)).toBe(true);
  });
});

describe('classifyGroundSmrf — degenerate inputs', () => {
  it('returns an empty, warned result for no points', () => {
    const res = classifyGroundSmrf([], PARAMS);
    expect(res.sourcePointCount).toBe(0);
    expect(res.isGround.length).toBe(0);
    expect(res.warnings.join(' ')).toMatch(/no points/i);
  });

  it('skips non-finite points and warns', () => {
    const points: TerrainPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: Number.NaN, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    ];
    const res = classifyGroundSmrf(points, PARAMS);
    expect(res.analyzedPointCount).toBe(2);
    expect(res.warnings.join(' ')).toMatch(/non-finite/i);
    // The NaN point must not be marked ground.
    expect(res.isGround[1]).toBe(0);
  });

  it('clamps invalid params with a warning', () => {
    const points: TerrainPoint[] = [{ x: 0, y: 0, z: 0 }];
    const res = classifyGroundSmrf(points, { ...PARAMS, cellSizeM: 0 });
    expect(res.warnings.join(' ')).toMatch(/cellSizeM/i);
  });

  it('respects a Y-up vertical axis', () => {
    // Same flat scene but elevation lives on Y; X,Z are horizontal.
    const points: TerrainPoint[] = [];
    for (let x = 0; x <= 5; x++) {
      for (let zc = 0; zc <= 5; zc++) points.push({ x, y: 0, z: zc });
    }
    points.push({ x: 2, y: 8, z: 2 }); // a "tree" high on Y
    const res = classifyGroundSmrf(points, { ...PARAMS, verticalAxis: 'y' });
    expect(res.isGround[res.isGround.length - 1]).toBe(0);
  });
});

describe('inpaintNearest', () => {
  it('fills empty cells from the single seeded cell', () => {
    const cols = 3;
    const rows = 3;
    const grid = new Float32Array(cols * rows).fill(NaN);
    const had = new Uint8Array(cols * rows);
    grid[4] = 7; // centre
    had[4] = 1;
    const out = inpaintNearest(grid, had, cols, rows);
    for (let i = 0; i < out.length; i++) expect(out[i]).toBe(7);
  });

  it('returns zeros when no cell has data', () => {
    const out = inpaintNearest(new Float32Array(4).fill(NaN), new Uint8Array(4), 2, 2);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });
});

describe('morphOpen', () => {
  it('removes an isolated spike', () => {
    const cols = 5;
    const rows = 5;
    const grid = new Float32Array(cols * rows).fill(0);
    grid[2 * cols + 2] = 10; // centre spike
    const opened = morphOpen(grid, cols, rows, 1);
    expect(opened[2 * cols + 2]).toBeCloseTo(0, 5);
  });

  it('preserves a broad plateau larger than the window', () => {
    const cols = 7;
    const rows = 7;
    const grid = new Float32Array(cols * rows).fill(0);
    // 5x5 plateau of height 5 in the centre.
    for (let r = 1; r <= 5; r++) for (let c = 1; c <= 5; c++) grid[r * cols + c] = 5;
    const opened = morphOpen(grid, cols, rows, 1);
    expect(opened[3 * cols + 3]).toBeCloseTo(5, 5); // centre survives radius-1 opening
  });
});

describe('surfaceSlope', () => {
  it('is zero on a flat surface and positive on a step', () => {
    const cols = 3;
    const rows = 1;
    const flat = new Float32Array([1, 1, 1]);
    const step = new Float32Array([0, 0, 2]);
    expect(surfaceSlope(flat, cols, rows, 1)[1]).toBe(0);
    expect(surfaceSlope(step, cols, rows, 1)[2]).toBeGreaterThan(0);
  });
});
