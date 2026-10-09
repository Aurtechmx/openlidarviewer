/**
 * An RMSE confidence interval is reported only when a block bootstrap ran over
 * at least two scored blocks. Otherwise the result says it is unavailable and
 * why, and no consumer prints endpoints for it.
 */
import { describe, it, expect } from 'vitest';
import {
  spatialBlockHoldout, type XYZ, type SurfaceModel,
} from '../src/terrain/validate/spatialBlockHoldout';
import { blockedCiClause } from '../src/terrain/validate/holdoutCiText';

/** Two 10-wide blocks side by side, 20 points each. */
function twoBlocks(): XYZ[] {
  const pts: XYZ[] = [];
  for (let b = 0; b < 2; b++) {
    for (let i = 0; i < 20; i++) pts.push({ x: b * 10 + (i % 10), y: Math.floor(i / 10) * 3, z: 10 });
  }
  return pts;
}

/** Predicts z+offset only for points with x below `limit`; null elsewhere. */
function model(offset: number, limit = Infinity): SurfaceModel {
  return { fit() {}, predict: (x) => (x < limit ? 10 + offset : null) };
}

const base = { blockSize: 10, seed: 3, bootstrapN: 200 };
const fmt = (n: number): string => n.toFixed(2);

describe('hold-out RMSE interval status', () => {
  it('one scored block of two occupied: unavailable, no endpoints', () => {
    const r = spatialBlockHoldout(twoBlocks(), model(2, 10), base);
    expect(r.rmse).toBeCloseTo(2, 12);
    expect(r.n).toBe(20);
    expect(r.uncovered).toBe(20);
    expect(r.uncoveredFraction).toBe(0.5);
    expect(r.scoredBlocks).toBe(1);
    expect(r.ciStatus).toBe('unavailable');
    expect(r.ciUnavailableReason).toBe('one-scored-block');
    expect(r.ciLow).toBeNull();
    expect(r.ciHigh).toBeNull();
    const text = blockedCiClause(r, fmt);
    expect(text).toBe('Confidence interval unavailable: only one block was scored');
    expect(text).not.toMatch(/2\.00/);
  });

  it('no supported block: unavailable with no-residuals', () => {
    const r = spatialBlockHoldout(twoBlocks(), model(2, -1), base);
    expect(r.n).toBe(0);
    expect(r.ciStatus).toBe('unavailable');
    expect(r.ciUnavailableReason).toBe('no-residuals');
    expect(r.ciLow).toBeNull();
    expect(r.ciHigh).toBeNull();
    expect(r.uncoveredFraction).toBe(1);
  });

  it('bootstrap disabled: unavailable even with several scored blocks', () => {
    const r = spatialBlockHoldout(twoBlocks(), model(2), { ...base, bootstrapN: 0 });
    expect(r.scoredBlocks).toBe(2);
    expect(r.ciStatus).toBe('unavailable');
    expect(r.ciUnavailableReason).toBe('bootstrap-disabled');
    expect(r.ciLow).toBeNull();
    expect(blockedCiClause(r, fmt)).toBe('Confidence interval unavailable: the bootstrap was disabled');
  });

  it('identical residuals over several blocks: a computed zero-width interval', () => {
    const r = spatialBlockHoldout(twoBlocks(), model(2), base);
    expect(r.ciStatus).toBe('computed');
    expect(r.ciUnavailableReason).toBeNull();
    expect(r.ciLow).toBeCloseTo(2, 12);
    expect(r.ciHigh).toBeCloseTo(2, 12);
    expect(blockedCiClause(r, fmt)).toBe('95% CI 2.00-2.00');
  });

  it('varying residuals over several blocks: computed and bracketing, deterministic', () => {
    const pts = twoBlocks().map((p, i) => ({ ...p, z: p.z + (i % 7) * 0.3 + (p.x >= 10 ? 1 : 0) }));
    const a = spatialBlockHoldout(pts, model(0), base);
    const b = spatialBlockHoldout(pts, model(0), base);
    expect(a.ciStatus).toBe('computed');
    expect(a.ciLow as number).toBeLessThanOrEqual(a.rmse);
    expect(a.ciHigh as number).toBeGreaterThanOrEqual(a.rmse);
    expect(a.ciLow as number).toBeLessThan(a.ciHigh as number);
    expect(b.ciLow).toBe(a.ciLow);
    expect(b.ciHigh).toBe(a.ciHigh);
  });
});
