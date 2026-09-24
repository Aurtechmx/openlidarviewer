/**
 * terrainAccessTraversabilityCost.test.ts: the hard/soft split, and the TA
 * fixtures that exercise it directly — TA-3 (cross-slope trap), TA-6 (NoData
 * corridor), TA-8 (ruggedness), TA-9 (DSM obstruction) — plus the why-not
 * inspector (§12.11) and the traversability map (§12.10).
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_COST_WEIGHTS,
  applyWidthClearance,
  buildTraversabilityMap,
  edgeCost,
  evaluateEdge,
  nodeEligibility,
  prepareTerrainAccessFeatures,
  whyNotEligible,
} from '../src/simulation/terrainAccess/traversabilityCost';
import { gridOf, PERMISSIVE } from './helpers/terrainAccessFixtures';

describe('nodeEligibility', () => {
  it('always blocks NoData, regardless of unknownPolicy', () => {
    const grid = gridOf([[0, null, 0]]);
    for (const unknownPolicy of ['block', 'penalize'] as const) {
      const profile = { ...PERMISSIVE, unknownPolicy };
      const features = prepareTerrainAccessFeatures(grid, profile);
      const { blocked, reason } = nodeEligibility(grid, features, profile);
      expect(blocked[1]).toBe(1);
      expect(reason[1]).toBe('no-data');
    }
  });

  it('TA-6: a NoData corridor blocks under the default policy', () => {
    const grid = gridOf([
      [0, 0, 0],
      [null, null, null],
      [0, 0, 0],
    ]);
    const profile = { ...PERMISSIVE, unknownPolicy: 'block' as const };
    const features = prepareTerrainAccessFeatures(grid, profile);
    const { blocked } = nodeEligibility(grid, features, profile);
    expect(blocked[1 * 3 + 0]).toBe(1);
    expect(blocked[1 * 3 + 1]).toBe(1);
    expect(blocked[1 * 3 + 2]).toBe(1);
  });

  it('respects an ROI mask', () => {
    const grid = gridOf([[0, 0, 0]], { allowed: new Uint8Array([1, 0, 1]) });
    const features = prepareTerrainAccessFeatures(grid, PERMISSIVE);
    const { blocked, reason } = nodeEligibility(grid, features, PERMISSIVE);
    expect(blocked[1]).toBe(1);
    expect(reason[1]).toBe('outside-roi');
  });

  it('blocks low-confidence cells only under unknownPolicy: block', () => {
    const grid = gridOf([[0, 0, 0]], { confidence: new Float32Array([100, 10, 100]) });
    const blockProfile = { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'block' as const };
    const penalizeProfile = { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'penalize' as const };

    const fBlock = prepareTerrainAccessFeatures(grid, blockProfile);
    expect(nodeEligibility(grid, fBlock, blockProfile).blocked[1]).toBe(1);

    const fPenalize = prepareTerrainAccessFeatures(grid, penalizeProfile);
    expect(nodeEligibility(grid, fPenalize, penalizeProfile).blocked[1]).toBe(0);
  });

  it('TA-9: DSM obstruction blocks only when the layer and threshold are both enabled', () => {
    const heightAboveGround = new Float32Array([0, 3, 0]); // 3 m return over the centre cell
    const withDsm = gridOf([[0, 0, 0]], { heightAboveGround });
    const withoutDsm = gridOf([[0, 0, 0]]);

    const thresholded = { ...PERMISSIVE, obstacleHeightThreshold: 2 };
    const unthresholded = { ...PERMISSIVE, obstacleHeightThreshold: null };

    const f1 = prepareTerrainAccessFeatures(withDsm, thresholded);
    expect(nodeEligibility(withDsm, f1, thresholded).blocked[1]).toBe(1); // DSM + threshold ⇒ blocked

    const f2 = prepareTerrainAccessFeatures(withDsm, unthresholded);
    expect(nodeEligibility(withDsm, f2, unthresholded).blocked[1]).toBe(0); // DSM present, no threshold ⇒ inactive

    const f3 = prepareTerrainAccessFeatures(withoutDsm, thresholded);
    expect(nodeEligibility(withoutDsm, f3, thresholded).blocked[1]).toBe(0); // threshold set, no DSM ⇒ inactive
  });

  it('TA-8: ruggedness blocks a cell whose VRM exceeds the declared limit, and does nothing when unset', () => {
    // A checkerboard-like bump pattern gives the centre cell a nonzero VRM.
    const grid = gridOf([
      [0, 0, 0],
      [0, 0, 1],
      [0, 1, 0],
    ]);
    const strict = { ...PERMISSIVE, maxRuggedness: 0.01 };
    const lenient = { ...PERMISSIVE, maxRuggedness: null };

    const fStrict = prepareTerrainAccessFeatures(grid, strict);
    const centreVrm = fStrict.vrm[1 * 3 + 1];
    expect(centreVrm).toBeGreaterThan(0.01);
    expect(nodeEligibility(grid, fStrict, strict).blocked[1 * 3 + 1]).toBe(1);

    const fLenient = prepareTerrainAccessFeatures(grid, lenient);
    expect(nodeEligibility(grid, fLenient, lenient).blocked[1 * 3 + 1]).toBe(0);
  });
});

describe('evaluateEdge / edgeCost', () => {
  it('TA-3: a heading acceptable by total slope alone can still violate cross-slope in one direction', () => {
    // A uniform slope tilted so downslope is due east: z decreases 1 m per metre east.
    const cols = 5;
    const rowsN = 5;
    const rows: number[][] = [];
    for (let r = 0; r < rowsN; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(-c); // -1 tangent east
      rows.push(row);
    }
    const grid = gridOf(rows);
    // Total slope tangent here is 1 (45°). A profile with maxLongitudinalGrade
    // and maxCrossSlope both permitting up to 0.5 (~26.6°) accepts the total
    // slope only along SOME heading, and must reject the cross-slope-only
    // heading (moving along the contour) even though "total slope" (1.0)
    // would itself exceed 0.5 in EITHER interpretation — so this pins that a
    // move along the contour is evaluated on cross slope specifically, and a
    // move straight downslope is evaluated on longitudinal grade specifically,
    // rather than both being rejected (or accepted) by one shared number.
    const profile = { ...PERMISSIVE, maxLongitudinalGrade: 1.5, maxCrossSlope: 0.5 };
    const features = prepareTerrainAccessFeatures(grid, profile);
    const centre = 2 * cols + 2;

    const downslope = evaluateEdge(grid, features, profile, centre, centre + 1, 1, 0); // due east
    expect(downslope.blocked).toBe(false); // longitudinal ~1.0 ≤ 1.5, cross ~0 ≤ 0.5

    const alongContour = evaluateEdge(grid, features, profile, centre, centre + cols, 0, 1); // due north
    expect(alongContour.blocked).toBe(true); // cross ~1.0 > 0.5
    expect(alongContour.reason).toBe('cross-slope');
  });

  it('never returns a cost for a hard-blocked edge', () => {
    const grid = gridOf([[0, 5]]); // 5 m step
    const profile = { ...PERMISSIVE, maxStepHeight: 0.2 };
    const features = prepareTerrainAccessFeatures(grid, profile);
    expect(edgeCost(grid, features, profile, 0, 1, 1, 0)).toBeNull();
  });

  it('cost rises monotonically with utilization of the declared limits', () => {
    const grid = gridOf([[0, 0.05, 0.2]]);
    const profile = { ...PERMISSIVE, maxStepHeight: 1 };
    const features = prepareTerrainAccessFeatures(grid, profile);
    const small = edgeCost(grid, features, profile, 0, 1, 1, 0) as number;
    const big = edgeCost(grid, features, profile, 1, 2, 1, 0) as number;
    expect(big).toBeGreaterThan(small);
  });

  it('weighs support: lower confidence costs more, all else equal', () => {
    const flat = gridOf([[0, 0]]);
    const highConf = { ...flat, confidence: new Float32Array([100, 100]) };
    const lowConf = { ...flat, confidence: new Float32Array([20, 20]) };
    const profile = { ...PERMISSIVE, minimumTerrainConfidence: 0, unknownPolicy: 'penalize' as const };
    const fHigh = prepareTerrainAccessFeatures(highConf, profile);
    const fLow = prepareTerrainAccessFeatures(lowConf, profile);
    const costHigh = edgeCost(highConf, fHigh, profile, 0, 1, 1, 0) as number;
    const costLow = edgeCost(lowConf, fLow, profile, 0, 1, 1, 0) as number;
    expect(costLow).toBeGreaterThan(costHigh);
  });
});

describe('buildTraversabilityMap', () => {
  it('reports five distinct states: unknown, blocked, and the three cost buckets', () => {
    const grid = gridOf([
      [0, null, 0],
      [0, 0, 0],
    ], { allowed: new Uint8Array([1, 1, 1, 1, 0, 1]) });
    const profile = PERMISSIVE;
    const features = prepareTerrainAccessFeatures(grid, profile);
    const eligibility = applyWidthClearance(grid, nodeEligibility(grid, features, profile), profile);
    const map = buildTraversabilityMap(grid, features, eligibility, profile, DEFAULT_COST_WEIGHTS);

    expect(map[1].state).toBe('unknown'); // NoData cell
    expect(map[4].state).toBe('blocked'); // outside ROI
    expect(['low-cost', 'moderate-cost', 'high-cost']).toContain(map[0].state);
  });
});

describe('whyNotEligible', () => {
  it('a node-blocked cell reports its own reason', () => {
    const grid = gridOf([[0, null, 0]]);
    const profile = PERMISSIVE;
    const features = prepareTerrainAccessFeatures(grid, profile);
    const eligibility = nodeEligibility(grid, features, profile);
    const result = whyNotEligible(grid, features, eligibility, profile, 1);
    expect(result.eligible).toBe(false);
    expect(result.category).toBe('unknown'); // no-data ⇒ UNKNOWN/WITHHELD, not BLOCKED
    expect(result.reasons[0].reason).toBe('no-data');
  });

  it('low confidence reports as UNKNOWN/WITHHELD, matching the governing prompt\'s example', () => {
    const grid = gridOf([[0, 0]], { confidence: new Float32Array([100, 10]) });
    const profile = { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'block' as const };
    const features = prepareTerrainAccessFeatures(grid, profile);
    const eligibility = nodeEligibility(grid, features, profile);
    const result = whyNotEligible(grid, features, eligibility, profile, 1);
    expect(result.category).toBe('unknown');
    expect(result.reasons[0].detail).toMatch(/terrain support/);
  });

  it('an eligible cell with no viable heading reports BLOCKED with the closest-miss reason', () => {
    // Every neighbour of the centre is blocked (outside ROI), so the centre
    // itself is node-eligible but has no direction to move in.
    const grid = gridOf([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ], { allowed: new Uint8Array([0, 0, 0, 0, 1, 0, 0, 0, 0]) });
    const profile = PERMISSIVE;
    const features = prepareTerrainAccessFeatures(grid, profile);
    const eligibility = nodeEligibility(grid, features, profile);
    expect(eligibility.blocked[4]).toBe(0); // the centre cell itself is fine
    const result = whyNotEligible(grid, features, eligibility, profile, 4);
    expect(result.eligible).toBe(false);
    expect(result.category).toBe('blocked');
  });

  it('an eligible cell with a viable heading reports eligible', () => {
    const grid = gridOf([[0, 0, 0]]);
    const profile = PERMISSIVE;
    const features = prepareTerrainAccessFeatures(grid, profile);
    const eligibility = nodeEligibility(grid, features, profile);
    const result = whyNotEligible(grid, features, eligibility, profile, 1);
    expect(result.eligible).toBe(true);
    expect(result.category).toBe('eligible');
  });
});
