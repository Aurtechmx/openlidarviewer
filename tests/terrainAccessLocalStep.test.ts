/**
 * terrainAccessLocalStep.test.ts: the step of a move is a height
 * discontinuity, not the move's rise. A plane of any slope, on any cell size,
 * has no step; a ledge of height h on any slope has a step of h; a diagonal
 * move cannot slip between the two cells of a one-cell berm or ditch; and
 * the cell diagnostic (local relief) stays the raw footprint maximum.
 */
import { describe, expect, it } from 'vitest';

import {
  computeLocalStep, computeOrthogonalSteps, edgeRise, moveStep, stepOneSided, trendStep,
} from '../src/simulation/terrainAccess/localStep';
import { gradientField } from '../src/simulation/terrainAccess/directionalGrade';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { TERRAIN_ACCESS_NEIGHBOURS, type TerrainAccessGrid } from '../src/simulation/terrainAccess/terrainAccessTypes';
import { gridOf } from './helpers/terrainAccessFixtures';

describe('computeLocalStep (local relief, reported only)', () => {
  it('is the worst discontinuity in the 3×3 footprint, not the average', () => {
    const grid = gridOf([
      [0, 0, 0],
      [0, 0, 2],
      [0, 0, 0],
    ]);
    // Centre cell (1,1) has one neighbour 2 m above it and the rest flat.
    const step = computeLocalStep(grid);
    expect(step[1 * 3 + 1]).toBeCloseTo(2, 6);
  });

  it('is 0 on a perfectly flat footprint', () => {
    const grid = gridOf([
      [5, 5, 5],
      [5, 5, 5],
      [5, 5, 5],
    ]);
    const step = computeLocalStep(grid);
    expect(step[1 * 3 + 1]).toBeCloseTo(0, 6);
  });

  it('skips NoData neighbours rather than treating them as elevation 0', () => {
    const grid = gridOf([
      [null, null, null],
      [null, 5, null],
      [null, null, null],
    ]);
    // Every neighbour of the centre is NoData: nothing to compare against.
    const step = computeLocalStep(grid);
    expect(Number.isNaN(step[1 * 3 + 1])).toBe(true);
  });

  it('is NaN at an invalid cell', () => {
    const grid = gridOf([[5, null, 5]]);
    const step = computeLocalStep(grid);
    expect(Number.isNaN(step[1])).toBe(true);
  });

  it('widens with footprintRadius', () => {
    const grid = gridOf([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 3],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    const centre = 2 * 5 + 2;
    const r1 = computeLocalStep(grid, 1);
    const r2 = computeLocalStep(grid, 2);
    expect(r1[centre]).toBeCloseTo(0, 6); // the 3 m cell is 2 cells away, outside radius 1
    expect(r2[centre]).toBeCloseTo(3, 6);
  });
});

/** The user's DTM cell size, and the others the step must be indifferent to. */
const CELL_SIZES = [0.5, 1, 2.5661413613706827, 5] as const;
const SLOPES_DEG = [2, 6, 10, 19] as const;

/**
 * A rise per cell rounded to 1/4096 m, so every height k·rise on a small grid
 * is exact in Float32 and every difference of two heights is exact: a plane
 * then has a step of exactly 0, and what a test sees is the method, not
 * Float32 rounding. The angle moves by under 0.01° from the nominal one.
 */
const dyadic = (v: number): number => Math.round(v * 4096) / 4096;

/** A `cols × rows` grid with heights f(col, row), square cells of `cell` metres. */
function fnGrid(cols: number, rows: number, cell: number, f: (col: number, row: number) => number | null): TerrainAccessGrid {
  const data: (number | null)[][] = [];
  for (let r = 0; r < rows; r++) {
    const line: (number | null)[] = [];
    for (let c = 0; c < cols; c++) line.push(f(c, r));
    data.push(line);
  }
  return gridOf(data, { cellMetresX: cell, cellMetresY: cell });
}

/** The Horn gradient field the step's two-cell fallback reads, as `prepareTerrainAccessFeatures` builds it. */
function gradientOf(grid: TerrainAccessGrid) {
  const masked = new Float32Array(grid.z.length);
  for (let i = 0; i < masked.length; i++) masked[i] = grid.valid[i] === 0 ? Number.NaN : grid.z[i];
  return gradientField(hornSlopeAspect(masked, grid.cols, grid.rows, grid.cellMetresX, grid.cellMetresY));
}

/** Every in-grid move between two valid cells, as [fromIndex, dx, dy]. */
function everyMove(grid: TerrainAccessGrid): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
        const cc = c + dx;
        const rr = r + dy;
        if (cc < 0 || rr < 0 || cc >= grid.cols || rr >= grid.rows) continue;
        if (grid.valid[r * grid.cols + c] === 0 || grid.valid[rr * grid.cols + cc] === 0) continue;
        out.push([r * grid.cols + c, dx, dy]);
      }
    }
  }
  return out;
}

describe('edgeRise', () => {
  it('is the absolute height difference, symmetric in direction', () => {
    const grid = gridOf([[0, 0.5]]);
    expect(edgeRise(grid, 0, 1)).toBeCloseTo(0.5, 6);
    expect(edgeRise(grid, 1, 0)).toBeCloseTo(0.5, 6);
  });

  it('is NaN when either endpoint is NoData', () => {
    const grid = gridOf([[0, null]]);
    expect(Number.isNaN(edgeRise(grid, 0, 1))).toBe(true);
  });
});

describe('a plane of any slope has no step', () => {
  for (const cell of CELL_SIZES) {
    for (const deg of SLOPES_DEG) {
      it(`${deg}° on ${cell} m cells, every heading and aspect, grid edges included`, () => {
        const t = Math.tan((deg * Math.PI) / 180);
        // Several downslope directions, so diagonal moves meet the slope at
        // every angle, not only along an axis.
        for (const aspectDeg of [0, 30, 45, 90, 135, 200, 315]) {
          const a = (aspectDeg * Math.PI) / 180;
          const riseX = dyadic(t * cell * Math.cos(a));
          const riseY = dyadic(t * cell * Math.sin(a));
          const grid = fnGrid(7, 7, cell, (c, r) => riseX * c + riseY * r);
          const g = gradientOf(grid);
          let worst = 0;
          for (const [i, dx, dy] of everyMove(grid)) worst = Math.max(worst, moveStep(grid, g, i, dx, dy));
          expect(worst).toBeLessThan(1e-6);
        }
      });
    }
  }

  it('a plane that is not exact in Float32 reads a step only at the level of Float32 rounding', () => {
    // 19° on 5 m cells, heights up to about 50 m: the step is then a few
    // units in the last place of the heights, not a fraction of the rise.
    const t = Math.tan((19 * Math.PI) / 180);
    const grid = fnGrid(9, 9, 5, (c, r) => t * 5 * (0.8 * c + 0.6 * r));
    const g = gradientOf(grid);
    let worst = 0;
    for (const [i, dx, dy] of everyMove(grid)) worst = Math.max(worst, moveStep(grid, g, i, dx, dy));
    expect(worst).toBeLessThan(2e-5); // the rise per cell is about 1.7 m
  });

  it('a two-cell strip reads its trend from the Horn gradient, so a plain rise is not a step', () => {
    // No cell beyond either end along the heading: the bracket is the Horn
    // gradient at both ends projected on the move.
    const grid = gridOf([[0, 0.25]]);
    expect(trendStep(grid, gradientOf(grid), 0, 1, 0)).toBeLessThan(1e-6);
  });
});

describe('a ledge reads its own height, whatever the slope it sits on', () => {
  for (const deg of [0, 10] as const) {
    for (const cell of CELL_SIZES) {
      it(`0.5 m ledge on a ${deg}° slope, ${cell} m cells`, () => {
        const rise = dyadic(Math.tan((deg * Math.PI) / 180) * cell);
        // Rows 0–3 below the ledge, rows 4–8 above it; the slope climbs north.
        const grid = fnGrid(9, 9, cell, (_c, r) => rise * r + (r >= 4 ? 0.5 : 0));
        const g = gradientOf(grid);
        const at = (c: number, r: number): number => r * 9 + c;
        // Straight across the ledge, and diagonally across it.
        expect(moveStep(grid, g, at(4, 3), 0, 1)).toBeCloseTo(0.5, 6);
        expect(moveStep(grid, g, at(4, 4), 0, -1)).toBeCloseTo(0.5, 6);
        expect(moveStep(grid, g, at(4, 3), 1, 1)).toBeCloseTo(0.5, 6);
        expect(moveStep(grid, g, at(4, 4), -1, -1)).toBeCloseTo(0.5, 6);
        // Along the ledge, and the moves either side of it, have none: the
        // terrain beyond them explains their rise.
        expect(moveStep(grid, g, at(4, 3), 1, 0)).toBeLessThan(1e-6);
        expect(moveStep(grid, g, at(4, 2), 0, 1)).toBeLessThan(1e-6);
        expect(moveStep(grid, g, at(4, 4), 0, 1)).toBeLessThan(1e-6);
      });
    }
  }

  it('a change of grade is not a step: flat ground meeting a 19° slope on 2.566 m cells', () => {
    // The raw rise of the first move onto the slope is 0.88 m; the mean of the
    // two one-sided rises would still read 0.44 m. The bracket reads 0.
    const cell = 2.5661413613706827;
    const rise = dyadic(Math.tan((19 * Math.PI) / 180) * cell);
    const grid = fnGrid(7, 9, cell, (_c, r) => (r <= 4 ? 0 : rise * (r - 4)));
    const g = gradientOf(grid);
    let worst = 0;
    let twoSided = 0;
    for (const [i, dx, dy] of everyMove(grid)) {
      if (stepOneSided(grid, i, dx, dy)) continue;
      twoSided++;
      worst = Math.max(worst, moveStep(grid, g, i, dx, dy));
    }
    expect(twoSided).toBeGreaterThan(200);
    expect(worst).toBeLessThan(1e-6);
    expect(edgeRise(grid, 4 * 7 + 3, 5 * 7 + 3)).toBeGreaterThan(0.85);
  });

  it('with one side missing, the grade change reads as a step and the move says so', () => {
    // A diagonal from the grid's west edge onto the break: nothing behind it,
    // the slope ahead. One-sided, it errs towards blocking, and is flagged.
    const cell = 2.5661413613706827;
    const rise = dyadic(Math.tan((19 * Math.PI) / 180) * cell);
    const grid = fnGrid(7, 9, cell, (_c, r) => (r <= 4 ? 0 : rise * (r - 4)));
    const from = 3 * 7 + 0;
    expect(stepOneSided(grid, from, 1, 1)).toBe(true);
    expect(moveStep(grid, gradientOf(grid), from, 1, 1)).toBeCloseTo(rise, 6);
    expect(stepOneSided(grid, 3 * 7 + 3, 0, 1)).toBe(false);
  });

  it('documented limit: a level move between two risers one cell apart reads the smaller riser', () => {
    // 0 → 0.4 (riser) → 0.4 (tread) → 0.7 (riser) → 0.7: the tread move is
    // level, but both moves beside it rise, so no single change of grade
    // explains it.
    const grid = gridOf([[0, 0, 0.4, 0.4, 0.7, 0.7]]);
    const g = gradientOf(grid);
    expect(moveStep(grid, g, 2, 1, 0)).toBeCloseTo(0.3, 6);
    expect(moveStep(grid, g, 1, 1, 0)).toBeCloseTo(0.4, 6);
    expect(moveStep(grid, g, 3, 1, 0)).toBeCloseTo(0.3, 6);
  });

  it('is NaN when either endpoint is NoData', () => {
    const grid = gridOf([[0, 0, null, 0]]);
    expect(Number.isNaN(moveStep(grid, gradientOf(grid), 1, 1, 0))).toBe(true);
  });

  it('the precomputed orthogonal steps give exactly the step computed move by move, off-grid moves included', () => {
    let seed = 11;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const grid = fnGrid(9, 7, 2.5661413613706827, (c, r) => (c === 4 && r === 2 ? null : 3 * next() + 0.2 * r));
    const g = gradientOf(grid);
    const steps = computeOrthogonalSteps(grid, g);
    for (let i = 0; i < grid.cols * grid.rows; i++) {
      for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
        const cached = moveStep(grid, g, i, dx, dy, steps);
        const computed = moveStep(grid, g, i, dx, dy);
        if (Number.isNaN(computed)) expect(Number.isNaN(cached)).toBe(true);
        else expect(cached).toBe(computed);
      }
    }
  });

  it('a move and its reverse have the same step, exactly', () => {
    // Deterministic rough terrain with a hole.
    let seed = 7;
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const grid = fnGrid(8, 8, 2.5661413613706827, (c, r) => (c === 3 && r === 5 ? null : 2 * next() + 0.3 * c));
    const g = gradientOf(grid);
    for (const [i, dx, dy] of everyMove(grid)) {
      const row = Math.floor(i / grid.cols);
      const j = (row + dy) * grid.cols + (i - row * grid.cols) + dx;
      expect(moveStep(grid, g, j, -dx, -dy)).toBe(moveStep(grid, g, i, dx, dy));
    }
  });
});

describe('a diagonal move passes between its two corner cells', () => {
  // A one-cell-wide berm or ditch along the diagonal col = row: a move from
  // (col 7, row 8) to (col 8, row 7) crosses it with both corners on it and
  // none of the four cells its straight trend reads.
  for (const h of [2, -2, 0.5]) {
    it(`a one-cell ${h > 0 ? 'berm' : 'ditch'} of ${Math.abs(h)} m blocks the diagonal it runs across`, () => {
      const grid = fnGrid(16, 16, 2.5661413613706827, (c, r) => (c === r ? h : 0));
      const g = gradientOf(grid);
      const from = 8 * 16 + 7;
      expect(trendStep(grid, g, from, 1, -1)).toBeLessThan(1e-6); // the straight trend alone misses it
      expect(moveStep(grid, g, from, 1, -1)).toBeCloseTo(Math.abs(h), 6);
      expect(moveStep(grid, g, 7 * 16 + 8, -1, 1)).toBeCloseTo(Math.abs(h), 6);
    });
  }

  it('a single high cell at one corner leaves the other corner open', () => {
    const grid = fnGrid(9, 9, 1, (c, r) => (c === 5 && r === 4 ? 2 : 0));
    const g = gradientOf(grid);
    // (4,4) → (5,5): corners (5,4), which is 2 m up, and (4,5), which is flat.
    expect(moveStep(grid, g, 4 * 9 + 4, 1, 1)).toBeLessThan(1e-6);
    // The high cell itself is a 2 m step from any side.
    expect(moveStep(grid, g, 4 * 9 + 4, 1, 0)).toBeCloseTo(2, 6);
    expect(moveStep(grid, g, 3 * 9 + 5, 0, 1)).toBeCloseTo(2, 6);
  });

  it('a corner with no elevation is not a way past; the other corner decides', () => {
    // (col 2, row 1) is NoData; (col 1, row 2) is the ditch bottom. Every way
    // from (1,1) to (2,2) that has an elevation crosses the ditch.
    const grid = fnGrid(5, 5, 1, (c, r) => (c === 2 && r === 1 ? null : (c === 1 && r === 2 ? -1 : 0)));
    const g = gradientOf(grid);
    expect(moveStep(grid, g, 1 * 5 + 1, 1, 1)).toBeCloseTo(1, 6);
  });
});
