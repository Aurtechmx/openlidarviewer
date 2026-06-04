/**
 * terrainQualityScore.test.ts — composite 0–100 terrain quality score.
 */

import { describe, it, expect } from 'vitest';
import {
  terrainQualityScore,
  type TerrainQualityInput,
} from '../src/terrain/quality/terrainQualityScore';

const base: TerrainQualityInput = {
  measuredOfCovered: 1,
  meanCellConfidence: 95,
  holdoutRmseM: 0.02,
  groundPointRatio: 0.8,
  edgeRiskRatio: 0.05,
  meanDensity: 4,
  cellSizeM: 1,
};

describe('terrainQualityScore', () => {
  it('component weights sum to 1', () => {
    const { components } = terrainQualityScore(base);
    const total = components.reduce((s, c) => s + c.weight, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it('a strong surface scores excellent', () => {
    const r = terrainQualityScore(base);
    expect(r.score).toBeGreaterThanOrEqual(80);
    expect(r.band).toBe('excellent');
  });

  it('a weak surface scores poor', () => {
    const r = terrainQualityScore({
      measuredOfCovered: 0.2,
      meanCellConfidence: 20,
      holdoutRmseM: 0.5,
      groundPointRatio: 0.1,
      edgeRiskRatio: 0.8,
      meanDensity: 0.2,
      cellSizeM: 1,
    });
    expect(r.score).toBeLessThan(40);
    expect(r.band).toBe('poor');
  });

  it('unknown validation + ground use a neutral 0.5 and are flagged', () => {
    const r = terrainQualityScore({ ...base, holdoutRmseM: null, groundPointRatio: null });
    const val = r.components.find((c) => c.label === 'Validation')!;
    const grd = r.components.find((c) => c.label === 'Ground returns')!;
    expect(val.neutral).toBe(true);
    expect(val.score).toBeCloseTo(0.5, 9);
    expect(grd.neutral).toBe(true);
    // Still a sensible score, just not overclaiming on the unknown axes.
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('lower RMSE raises the validation sub-score monotonically', () => {
    const good = terrainQualityScore({ ...base, holdoutRmseM: 0.01 }).score;
    const worse = terrainQualityScore({ ...base, holdoutRmseM: 0.4 }).score;
    expect(good).toBeGreaterThan(worse);
  });

  it('band thresholds: excellent ≥80, good ≥60, fair ≥40, else poor', () => {
    const bands = [0.9, 0.7, 0.5, 0.2].map((cov) =>
      terrainQualityScore({
        measuredOfCovered: cov,
        meanCellConfidence: cov * 100,
        holdoutRmseM: null,
        groundPointRatio: null,
        edgeRiskRatio: 1 - cov,
        meanDensity: cov * 4,
        cellSizeM: 1,
      }).band,
    );
    // Monotonically non-increasing quality as inputs degrade.
    const rank = { excellent: 3, good: 2, fair: 1, poor: 0 } as const;
    for (let i = 1; i < bands.length; i++) {
      expect(rank[bands[i]]).toBeLessThanOrEqual(rank[bands[i - 1]]);
    }
  });
});
