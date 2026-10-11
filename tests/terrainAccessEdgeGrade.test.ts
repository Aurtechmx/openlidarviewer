/**
 * terrainAccessEdgeGrade.test.ts: an edge's grade includes what the edge
 * itself climbs, the same in both directions.
 *
 * Reading the Horn gradient at the from-cell alone let a move out of a
 * V-valley floor (where the centred gradient is zero) pass as level although
 * the edge rises 0.8 m over 1 m, and blocked the reverse move. The per-edge
 * grade is now the largest of the directional Horn grade at either endpoint
 * and the edge's own rise over run.
 */
import { describe, expect, it } from 'vitest';

import { computeRouteDiagnostics, weightedQuantile } from '../src/simulation/terrainAccess/routeDiagnostics';
import {
  DEFAULT_COST_WEIGHTS, edgeCost, evaluateEdge, prepareTerrainAccessFeatures,
} from '../src/simulation/terrainAccess/traversabilityCost';
import { gridOf, PERMISSIVE } from './helpers/terrainAccessFixtures';

const COLS = 9;
const ROWS = 5;
const valley = gridOf(
  Array.from({ length: ROWS }, () => Array.from({ length: COLS }, (_, c) => 0.8 * Math.abs(c - 4))),
);
const LIMITED = { ...PERMISSIVE, maxLongitudinalGrade: 0.3, maxCrossSlope: 0.3, maxStepHeight: 1 };
const floor = 2 * COLS + 4;

describe('a V-valley, z = 0.8|x|, 1 m cells', () => {
  const features = prepareTerrainAccessFeatures(valley, LIMITED);

  it('blocks the climb out of the floor on grade', () => {
    const e = evaluateEdge(valley, features, LIMITED, floor, floor + 1, 1, 0);
    expect(e.longitudinalGrade).toBeGreaterThanOrEqual(0.8 - 1e-6);
    expect(e.blocked).toBe(true);
    expect(e.reason).toBe('longitudinal-grade');
  });

  it('blocks the descent into the floor too: the grade is symmetric', () => {
    const up = evaluateEdge(valley, features, LIMITED, floor, floor + 1, 1, 0);
    const down = evaluateEdge(valley, features, LIMITED, floor + 1, floor, -1, 0);
    expect(down.blocked).toBe(true);
    expect(down.longitudinalGrade).toBe(up.longitudinalGrade);
    expect(down.crossSlope).toBe(up.crossSlope);
  });

  it('reports a route max grade no lower than the steepest edge rise/run', () => {
    const f = prepareTerrainAccessFeatures(valley, PERMISSIVE);
    const path = [floor - 2, floor - 1, floor, floor + 1, floor + 2];
    const d = computeRouteDiagnostics(valley, f, path, DEFAULT_COST_WEIGHTS, PERMISSIVE);
    let steepest = 0;
    for (let k = 1; k < path.length; k++) {
      steepest = Math.max(steepest, Math.abs(valley.z[path[k]] - valley.z[path[k - 1]]));
    }
    expect(d.maxLongitudinalGrade).toBeGreaterThanOrEqual(steepest - 1e-6);
    expect(d.p95LongitudinalGrade).toBeGreaterThanOrEqual(steepest - 1e-6);
  });
});

describe('route figures are weighted by edge length', () => {
  it('weights the p95 by distance', () => {
    // A long gentle edge outweighs a short steep one.
    expect(weightedQuantile([0.1, 0.9], [99, 1], 0.95)).toBe(0.1);
    expect(weightedQuantile([0.1, 0.9], [1, 1], 0.95)).toBe(0.9);
    expect(weightedQuantile([], [], 0.95)).toBe(0);
  });

  it('cost contributors sum to the route cost less its distance', () => {
    // An anisotropic plane: diagonal and orthogonal edges differ in length.
    const grid = gridOf(
      Array.from({ length: 4 }, (_, r) => Array.from({ length: 4 }, (_, c) => 0.1 * c + 0.05 * r)),
      { cellMetresX: 2, cellMetresY: 1, confidence: new Float32Array(16).fill(80) },
    );
    const features = prepareTerrainAccessFeatures(grid, LIMITED);
    const path = [0, 5, 6, 7, 11];
    let cost = 0;
    let distance = 0;
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1];
      const b = path[k];
      const dx = (b % 4) - (a % 4);
      const dy = Math.floor(b / 4) - Math.floor(a / 4);
      cost += edgeCost(grid, features, LIMITED, a, b, dx, dy) as number;
      distance += Math.hypot(dx * 2, dy);
    }
    const d = computeRouteDiagnostics(grid, features, path, DEFAULT_COST_WEIGHTS, LIMITED);
    const total = d.dominantCostContributors.reduce((s, c) => s + c.total, 0);
    expect(total).toBeCloseTo(cost - distance, 9);
  });
});
