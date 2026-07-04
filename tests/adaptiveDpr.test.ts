/**
 * adaptiveDpr.test.ts
 *
 * Pins the P5 adaptive-DPR policy: parked renders at full resolution; motion
 * reduces toward a floor as angular speed rises (the P3 signal); quantisation
 * snaps to coarse buckets; and `shouldApplyDpr` sharpens immediately but
 * rate-limits reductions so the drawing buffer isn't reallocated every frame.
 */

import { describe, it, expect } from 'vitest';
import {
  DPR_MOTION_FLOOR,
  DPR_MOVING_BASE_FACTOR,
  DPR_FULL_REDUCTION_ANGULAR,
  DPR_MIN_APPLY_INTERVAL_MS,
  targetPixelRatio,
  quantizeDpr,
  shouldApplyDpr,
} from '../src/render/adaptiveDpr';

describe('targetPixelRatio', () => {
  it('renders at full maxDpr when parked, regardless of angular speed', () => {
    expect(targetPixelRatio({ maxDpr: 1.5, moving: false, angularSpeed: 0 })).toBe(1.5);
    expect(targetPixelRatio({ maxDpr: 1.5, moving: false, angularSpeed: 9 })).toBe(1.5);
  });
  it('applies the baseline reduction when moving but not rotating', () => {
    expect(targetPixelRatio({ maxDpr: 2, moving: true, angularSpeed: 0 })).toBeCloseTo(
      2 * DPR_MOVING_BASE_FACTOR,
      10,
    );
  });
  it('falls to the floor at/above the full-reduction angular speed', () => {
    expect(
      targetPixelRatio({ maxDpr: 2, moving: true, angularSpeed: DPR_FULL_REDUCTION_ANGULAR }),
    ).toBeCloseTo(DPR_MOTION_FLOOR, 10);
    expect(
      targetPixelRatio({ maxDpr: 2, moving: true, angularSpeed: DPR_FULL_REDUCTION_ANGULAR * 5 }),
    ).toBeCloseTo(DPR_MOTION_FLOOR, 10);
  });
  it('is monotonically non-increasing as angular speed rises', () => {
    const a = targetPixelRatio({ maxDpr: 2, moving: true, angularSpeed: 0.2 });
    const b = targetPixelRatio({ maxDpr: 2, moving: true, angularSpeed: 0.6 });
    const c = targetPixelRatio({ maxDpr: 2, moving: true, angularSpeed: 1.0 });
    expect(a).toBeGreaterThanOrEqual(b);
    expect(b).toBeGreaterThanOrEqual(c);
  });
  it('never drops below the floor even on a low-DPR display', () => {
    // maxDpr already at the floor → base clamps to floor, stays there.
    expect(targetPixelRatio({ maxDpr: 1, moving: true, angularSpeed: 5 })).toBe(1);
  });
  it('guards a non-finite / non-positive maxDpr', () => {
    expect(targetPixelRatio({ maxDpr: Number.NaN, moving: false, angularSpeed: 0 })).toBe(1);
    expect(targetPixelRatio({ maxDpr: 0, moving: false, angularSpeed: 0 })).toBe(1);
  });
});

describe('quantizeDpr', () => {
  it('snaps to the nearest step', () => {
    expect(quantizeDpr(1.31, 0.25)).toBeCloseTo(1.25, 10);
    expect(quantizeDpr(1.4, 0.25)).toBeCloseTo(1.5, 10);
  });
  it('never returns below one step', () => {
    expect(quantizeDpr(0.01, 0.25)).toBeCloseTo(0.25, 10);
  });
  it('falls back to the default step for a bad step', () => {
    expect(quantizeDpr(1.5, 0)).toBeCloseTo(1.5, 10);
  });
});

describe('shouldApplyDpr', () => {
  it('does nothing when the target already matches', () => {
    expect(shouldApplyDpr(1.5, 1.5, 1000, 0)).toBe(false);
  });
  it('sharpens (moves up) immediately, ignoring the interval', () => {
    expect(shouldApplyDpr(1.0, 1.5, 10, 0, DPR_MIN_APPLY_INTERVAL_MS)).toBe(true);
  });
  it('rate-limits a reduction until the interval has elapsed', () => {
    // Only 100 ms since the last change → below the 250 ms limit → hold.
    expect(shouldApplyDpr(1.5, 1.25, 100, 0, DPR_MIN_APPLY_INTERVAL_MS)).toBe(false);
    // 300 ms elapsed → allowed.
    expect(shouldApplyDpr(1.5, 1.25, 300, 0, DPR_MIN_APPLY_INTERVAL_MS)).toBe(true);
  });
});
