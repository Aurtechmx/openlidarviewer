/**
 * flowDepressionFlats.test.ts: a flat is not a depression.
 *
 * Priority-Flood with an epsilon lifts cells that are level with their spill
 * parent so D8 has a descent across a flat. Barnes, Lehman & Mulla (2014)
 * separate that from filling: a cell is in a depression only when its
 * original height is strictly below the level it was reached from. These
 * pin that a plateau reports no depression and no fill, and that a real
 * bowl keeps its depth without the epsilon chain added on.
 */
import { describe, expect, it } from 'vitest';

import { depressionInventory } from '../src/simulation/flowPulse/depressionInventory';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import { filledCells, priorityFlood } from '../src/simulation/flowPulse/priorityFlood';

const SIZE = 41;

function gridFrom(fn: (col: number, row: number) => number): FlowGrid {
  const n = SIZE * SIZE;
  const z = new Float32Array(n);
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) z[row * SIZE + col] = fn(col, row);
  }
  return { z, valid: new Uint8Array(n).fill(1), cols: SIZE, rows: SIZE, cellMetresX: 1, cellMetresY: 1 };
}

describe('a level plateau draining over one edge', () => {
  const grid = gridFrom((col) => (col === 0 ? 99 : 100));
  const conditioned = priorityFlood(grid, { epsilon: 0.001 });

  it('raises no cell as fill and reports zero fill depth', () => {
    expect(conditioned.cellsRaised).toBe(0);
    expect(conditioned.maxFillDepth).toBe(0);
    expect(conditioned.fillDepthSum).toBe(0);
  });

  it('still lifts the flat by the epsilon gradient, counted separately', () => {
    // Interior plateau cells, i.e. every non-boundary cell (39 x 39 = 1521)
    // minus the 39 in column 1 that the 99 m edge reaches from below.
    expect(conditioned.flatCellsResolved).toBe(1482);
  });

  it('inventories no depression', () => {
    const inv = depressionInventory(grid, conditioned, filledCells(grid, conditioned), true);
    expect(inv.depressions.length).toBe(0);
    expect(inv.filledCellCount).toBe(0);
    expect(inv.largestMaxFillDepth).toBeNull();
  });
});

describe('a real bowl', () => {
  // A 5 m deep cone, centred, on a gently tilted plane so its rim has a
  // single lowest spill point.
  const grid = gridFrom((col, row) => 10 - Math.max(0, 5 - Math.hypot(col - 20, row - 20)) + 0.01 * col);
  const conditioned = priorityFlood(grid, { epsilon: 0.001 });
  const inv = depressionInventory(grid, conditioned, filledCells(grid, conditioned), true);

  it('is one depression whose depth is the spill level minus the floor', () => {
    expect(inv.depressions.length).toBe(1);
    const d = inv.depressions[0];
    // Floor: 5 + 0.2 = 5.2 m. Spill level: the rim's lowest point.
    const floor = grid.z[20 * SIZE + 20];
    expect(d.outletElevation).not.toBeNull();
    expect(d.maxFillDepth).toBeCloseTo((d.outletElevation as number) - floor, 5);
    expect(d.maxFillDepth).toBeCloseTo(4.95, 5);
  });

  it('agrees with the grid-wide maximum and is not inflated by epsilon', () => {
    expect(conditioned.maxFillDepth).toBeCloseTo(inv.depressions[0].maxFillDepth as number, 6);
    // Epsilon chain across 69 cells would add up to ~0.069 m: none of it is depth.
    expect(conditioned.maxFillDepth).toBeLessThan(4.951);
  });
});
