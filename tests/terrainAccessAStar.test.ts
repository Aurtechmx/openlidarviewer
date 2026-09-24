/**
 * terrainAccessAStar.test.ts: §12.8 — deterministic search that never crosses
 * a blocked cell, plus TA-1 (flat plane), TA-4 (step barrier) and TA-5 (a
 * point-like path exists, a width-aware one does not).
 */
import { describe, expect, it } from 'vitest';

import { aStarTerrain } from '../src/simulation/terrainAccess/aStarTerrain';
import {
  DEFAULT_COST_WEIGHTS, applyWidthClearance, nodeEligibility, prepareTerrainAccessFeatures,
} from '../src/simulation/terrainAccess/traversabilityCost';
import type { TerrainAccessGrid, TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import { gridOf, PERMISSIVE } from './helpers/terrainAccessFixtures';

/** Build eligibility + features for a grid/profile in one call, for brevity. */
function setup(grid: TerrainAccessGrid, profile: TerrainAccessProfile) {
  const features = prepareTerrainAccessFeatures(grid, profile);
  const eligibility = applyWidthClearance(grid, nodeEligibility(grid, features, profile), profile);
  return { features, eligibility };
}

describe('TA-1: flat plane', () => {
  it('finds a near-straight route with a reasonable cost close to the Euclidean distance', () => {
    const rowsData: number[][] = Array.from({ length: 9 }, () => Array(9).fill(0));
    const grid = gridOf(rowsData);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const start = 0;
    const end = 8 * 9 + 8;
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, start, end, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('FOUND');
    const euclidean = Math.hypot(8, 8);
    expect(result.cost as number).toBeCloseTo(euclidean, 1);
    // A near-straight route uses close to the minimum number of 8-connected
    // steps (8 diagonal steps between opposite corners of a 9×9 grid).
    expect(result.path.length).toBeLessThanOrEqual(9);
  });
});

describe('refusal-adjacent outcomes', () => {
  it('START_BLOCKED when the start cell has no elevation', () => {
    const grid = gridOf([[null, 0, 0]]);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 2, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('START_BLOCKED');
    expect(result.path).toEqual([]);
  });

  it('END_BLOCKED when the end cell has no elevation', () => {
    const grid = gridOf([[0, 0, null]]);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 2, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('END_BLOCKED');
  });

  it('NO_ROUTE when start and end are geometrically disconnected', () => {
    const grid = gridOf([
      [0, null, 0],
      [null, null, null],
      [0, null, 0],
    ]);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 8, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('NO_ROUTE');
  });
});

describe('TA-4: step barrier', () => {
  it('a one-cell discontinuity above the declared max step blocks passage', () => {
    // A 1×3 corridor with a 1 m step between cells 1 and 2.
    const grid = gridOf([[0, 0, 1]]);
    const profile = { ...PERMISSIVE, maxStepHeight: 0.2 };
    const { features, eligibility } = setup(grid, profile);
    const result = aStarTerrain(grid, features, eligibility, profile, 0, 2, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('NO_ROUTE');
  });

  it('the same corridor is passable once the step is within the limit', () => {
    const grid = gridOf([[0, 0, 0.1]]);
    const profile = { ...PERMISSIVE, maxStepHeight: 0.2 };
    const { features, eligibility } = setup(grid, profile);
    const result = aStarTerrain(grid, features, eligibility, profile, 0, 2, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('FOUND');
  });
});

describe('TA-5: gap narrower than vehicle width', () => {
  // Two wall segments at column 1, rows 0 and 2, leaving exactly one open
  // cell between them: (row 1, col 1) — the pinch point a wide vehicle
  // cannot clear.
  //   . X . .
  //   . . . .   (row 1, col 1 is the only way through column 1)
  //   . X . .
  const allowed = new Uint8Array([
    1, 0, 1, 1,
    1, 1, 1, 1,
    1, 0, 1, 1,
  ]);
  const pinch = 1 * 4 + 1;

  it('a point-like (zero-width) path exists through the gap', () => {
    const grid = gridOf(Array.from({ length: 3 }, () => Array(4).fill(0)), { allowed });
    const profile = { ...PERMISSIVE, vehicleWidth: 0 };
    const { features, eligibility } = setup(grid, profile);
    const result = aStarTerrain(grid, features, eligibility, profile, 0, 3, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('FOUND');
    expect(result.path).toContain(pinch); // the route has to cross column 1 through the one open cell
  });

  it('a width-aware path does not exist once the vehicle cannot clear the gap', () => {
    const grid = gridOf(Array.from({ length: 3 }, () => Array(4).fill(0)), { allowed });
    const profile = { ...PERMISSIVE, vehicleWidth: 2.5 }; // half-width 1.25 m > the 1 m clearance
    const { features, eligibility } = setup(grid, profile);
    const result = aStarTerrain(grid, features, eligibility, profile, 0, 3, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).not.toBe('FOUND');
  });
});

describe('never crosses a blocked cell', () => {
  it('no cell in a FOUND path is a cell nodeEligibility blocked', () => {
    const grid = gridOf([
      [0, 0, 0, 0, 0],
      [0, null, null, null, 0],
      [0, 0, 0, 0, 0],
    ]);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 4, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('FOUND');
    for (const cell of result.path) expect(eligibility.blocked[cell]).toBe(0);
  });

  it('adversarial: forcing a straight line through a blocked cell finds no route rather than tunnelling', () => {
    // A wall spans the entire width except it is IMPASSABLE (no gap at all).
    const grid = gridOf([
      [0, 0, 0],
      [null, null, null],
      [0, 0, 0],
    ]);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const result = aStarTerrain(grid, features, eligibility, PERMISSIVE, 1, 7, DEFAULT_COST_WEIGHTS);
    expect(result.outcome).toBe('NO_ROUTE');
    expect(result.path).toEqual([]);
  });
});

describe('determinism', () => {
  it('repeated searches over the same inputs return byte-identical paths', () => {
    const rowsData: number[][] = Array.from({ length: 6 }, (_, r) => Array.from({ length: 6 }, (_, c) => (r + c) % 3));
    const grid = gridOf(rowsData);
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const a = aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 35, DEFAULT_COST_WEIGHTS);
    const b = aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 35, DEFAULT_COST_WEIGHTS);
    expect(a.path).toEqual(b.path);
    expect(a.cost).toEqual(b.cost);
  });

  it('a fully symmetric cost surface still yields one reproducible route via the documented tie-break', () => {
    const grid = gridOf(Array.from({ length: 5 }, () => Array(5).fill(0))); // perfectly flat: every route costs the same
    const { features, eligibility } = setup(grid, PERMISSIVE);
    const paths = Array.from({ length: 5 }, () =>
      aStarTerrain(grid, features, eligibility, PERMISSIVE, 0, 24, DEFAULT_COST_WEIGHTS).path);
    for (const p of paths) expect(p).toEqual(paths[0]);
  });
});
