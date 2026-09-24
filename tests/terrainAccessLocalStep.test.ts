/**
 * terrainAccessLocalStep.test.ts: the step metric answers what it says it
 * answers — the worst discontinuity in a declared footprint, and the exact
 * pairwise form used to gate one move (TA-4).
 */
import { describe, expect, it } from 'vitest';

import { computeLocalStep, edgeStep } from '../src/simulation/terrainAccess/localStep';
import { gridOf } from './helpers/terrainAccessFixtures';

describe('computeLocalStep', () => {
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

describe('edgeStep', () => {
  it('is the absolute pairwise discontinuity, symmetric in direction', () => {
    const grid = gridOf([[0, 0.5]]);
    expect(edgeStep(grid, 0, 1)).toBeCloseTo(0.5, 6);
    expect(edgeStep(grid, 1, 0)).toBeCloseTo(0.5, 6);
  });

  it('is NaN when either endpoint is NoData', () => {
    const grid = gridOf([[0, null]]);
    expect(Number.isNaN(edgeStep(grid, 0, 1))).toBe(true);
  });

  it('TA-4: a one-cell discontinuity greater than the declared max step is the exact edge value that blocks passage', () => {
    const grid = gridOf([[0, 0.5]]);
    const maxStepHeight = 0.2;
    expect(edgeStep(grid, 0, 1)).toBeGreaterThan(maxStepHeight);
  });
});
