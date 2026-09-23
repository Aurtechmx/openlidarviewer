/**
 * depressionInventory.test.ts: depressions are catalogued individually, not
 * folded into one grid-wide total.
 *
 * The properties checked here are the ones a total-only summary hides:
 *
 *   raw mode lists sink candidates, not extents it never measured
 *   conditioned mode groups raised cells into depressions, largest first
 *   two equal-size depressions still order deterministically
 *   the outlet elevation is the depression's own rim, not a neighbour's
 *   the horizontal-scale gate withholds area the same way the rest of a run does
 *
 * `notchedBowl` is the same fixture `priorityFlood.test.ts` and
 * `flowPulseRunner.test.ts` use: its spill behaviour (only the pit rises, to
 * the inner ring at 4) is already established there, so the expected numbers
 * here — one filled cell, fill depth 4, outlet 4 — are read off that fixture
 * rather than asserted on faith.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { depressionInventory } from '../src/simulation/flowPulse/depressionInventory';
import { d8Flow } from '../src/simulation/flowPulse/d8Flow';
import { filledCells, priorityFlood } from '../src/simulation/flowPulse/priorityFlood';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function gridOf(rows: readonly (readonly (number | null)[])[]): FlowGrid {
  const h = rows.length;
  const w = rows[0].length;
  const z = new Float32Array(w * h);
  const valid = new Uint8Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      valid[r * w + c] = 1;
    }
  }
  return { z, valid, cols: w, rows: h, cellMetresX: 1, cellMetresY: 1 };
}

/**
 * TF-2 (Bowl): a pit inside a rim with one notch, read from the fixture
 * `fieldSimulationOracleAgreement.test.ts` already cross-checks against the
 * Python oracle, so the raw-vs-filled story below and the oracle agreement
 * describe the identical committed grid rather than two hand-typed copies.
 */
const BOWL_FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', 'validation', 'field-simulation',
  'fixtures', 'bowl-notched.json',
);
const notchedBowl = (): FlowGrid => {
  const spec = JSON.parse(readFileSync(BOWL_FIXTURE, 'utf8')) as { z: readonly (readonly (number | null)[])[] };
  return gridOf(spec.z);
};

/** Two copies of notchedBowl, six columns apart, so their filled cells never touch. */
const twoBowls = () => gridOf([
  [5, 5, 3, 5, 5, 5, 5, 5, 3, 5, 5],
  [5, 4, 4, 4, 5, 5, 5, 4, 4, 4, 5],
  [5, 4, 0, 4, 5, 5, 5, 4, 0, 4, 5],
  [5, 4, 4, 4, 5, 5, 5, 4, 4, 4, 5],
  [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
]);

describe('raw mode lists sink candidates, not depression extents', () => {
  it('reports the one sink as a one-cell candidate with no fill depth or outlet', () => {
    const grid = notchedBowl();
    const inv = depressionInventory(grid, null, null, true);
    expect(inv.sinkCount).toBe(1);
    expect(inv.filledCellCount).toBe(0);
    expect(inv.depressions).toHaveLength(1);
    const [d] = inv.depressions;
    expect(d.rank).toBe(1);
    expect(d.cells).toBe(1);
    expect(d.areaM2).toBe(1);
    expect(d.maxFillDepth).toBeNull();
    expect(d.outletElevation).toBeNull();
    expect(d.seedCell).toBe(2 * 5 + 2); // row 2, col 2
  });

  it('withholds area when the horizontal scale is unresolved, cell count intact', () => {
    const inv = depressionInventory(notchedBowl(), null, null, false);
    expect(inv.depressions[0].cells).toBe(1);
    expect(inv.depressions[0].areaM2).toBeNull();
  });

  it('reports no depressions on a surface with nowhere to pit', () => {
    const ramp = gridOf([[3, 2, 1], [3, 2, 1], [3, 2, 1]]);
    const inv = depressionInventory(ramp, null, null, true);
    expect(inv.sinkCount).toBe(0);
    expect(inv.depressions).toHaveLength(0);
  });
});

describe('conditioned mode groups raised cells into depressions', () => {
  it('finds the one filled depression, its fill depth and its rim elevation', () => {
    const grid = notchedBowl();
    const conditioned = priorityFlood(grid);
    const filled = filledCells(grid, conditioned);
    const inv = depressionInventory(grid, conditioned, filled, true);

    expect(inv.sinkCount).toBe(1); // still read off the raw surface
    expect(inv.filledCellCount).toBe(1); // only the pit itself rose
    expect(inv.depressions).toHaveLength(1);

    const [d] = inv.depressions;
    expect(d.cells).toBe(1);
    expect(d.areaM2).toBe(1);
    expect(d.maxFillDepth).toBe(4); // 0 -> 4, the inner ring's elevation
    expect(d.outletElevation).toBe(4); // the inner ring is the pit's whole rim

    expect(inv.largestCells).toBe(1);
    expect(inv.largestAreaM2).toBe(1);
    expect(inv.largestMaxFillDepth).toBe(4);
    expect(inv.largestOutletElevation).toBe(4);
  });

  it('reports the raw sink count from the unconditioned surface even when routing conditioned', () => {
    // d8Flow over the RAW grid must agree with what depressionInventory reports,
    // independent of what the caller's own routing pass used.
    const grid = notchedBowl();
    expect(d8Flow(grid).sinkCount).toBe(1);
    const conditioned = priorityFlood(grid);
    const filled = filledCells(grid, conditioned);
    expect(depressionInventory(grid, conditioned, filled, true).sinkCount).toBe(1);
  });

  it('keeps two depressions separate and orders them deterministically when tied on size', () => {
    const grid = twoBowls();
    const conditioned = priorityFlood(grid);
    const filled = filledCells(grid, conditioned);
    const inv = depressionInventory(grid, conditioned, filled, true);

    expect(inv.sinkCount).toBe(2);
    expect(inv.filledCellCount).toBe(2);
    expect(inv.depressions).toHaveLength(2);

    // Both depressions are identical in shape (one cell, depth 4, outlet 4),
    // so only the deterministic position tie-break can order them: the pit at
    // column 2 (linear index 24) must rank before the pit at column 8 (30).
    const [first, second] = inv.depressions;
    expect(first.seedCell).toBe(2 * 11 + 2);
    expect(second.seedCell).toBe(2 * 11 + 8);
    expect(first.rank).toBe(1);
    expect(second.rank).toBe(2);
    for (const d of [first, second]) {
      expect(d.cells).toBe(1);
      expect(d.maxFillDepth).toBe(4);
      expect(d.outletElevation).toBe(4);
    }
  });

  it('reports no depressions when conditioning ran but nothing needed raising', () => {
    const ramp = gridOf([[3, 2, 1], [3, 2, 1], [3, 2, 1]]);
    const conditioned = priorityFlood(ramp);
    const filled = filledCells(ramp, conditioned);
    const inv = depressionInventory(ramp, conditioned, filled, true);
    expect(inv.filledCellCount).toBe(0);
    expect(inv.depressions).toHaveLength(0);
    expect(inv.largestCells).toBe(0);
    expect(inv.largestAreaM2).toBeNull();
  });
});
