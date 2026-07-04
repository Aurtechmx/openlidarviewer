/**
 * pixelProjection.test.ts
 *
 * Pins the P4 pixel-space projection: an analytic value, linear scaling with
 * CSS viewport height (so DPR never changes selection), inverse scaling with
 * distance, FOV behaviour, the guards, and the near-distance conservative floor.
 */

import { describe, it, expect } from 'vitest';
import { projectedPixels, coveragePixels, spacingErrorPixels } from '../src/render/pixelProjection';

// tan(vFov / 2) = 0.5  ⇒  vFov = 2 · atan(0.5)
const VFOV = 2 * Math.atan(0.5);

describe('projectedPixels', () => {
  it('matches the analytic projection', () => {
    // 1 world unit at distance 1, 1000 px viewport, tan(vFov/2)=0.5
    //   ⇒ 1 · 1000 / (2 · 1 · 0.5) = 1000
    expect(projectedPixels(1, 1, 1000, VFOV)).toBeCloseTo(1000, 6);
  });
  it('scales linearly with CSS viewport height', () => {
    const a = projectedPixels(1, 5, 1000, VFOV);
    const b = projectedPixels(1, 5, 2000, VFOV);
    expect(b / a).toBeCloseTo(2, 10);
  });
  it('scales inversely with distance', () => {
    const near = projectedPixels(1, 2, 1000, VFOV);
    const far = projectedPixels(1, 4, 1000, VFOV);
    expect(far / near).toBeCloseTo(0.5, 10);
  });
  it('shrinks as the field of view widens', () => {
    const narrow = projectedPixels(1, 5, 1000, 0.4);
    const wide = projectedPixels(1, 5, 1000, 1.2);
    expect(wide).toBeLessThan(narrow);
  });
  it('guards non-positive size, viewport, and fov', () => {
    expect(projectedPixels(0, 1, 1000, VFOV)).toBe(0);
    expect(projectedPixels(1, 1, 0, VFOV)).toBe(0);
    expect(projectedPixels(1, 1, 1000, 0)).toBe(0);
  });
  it('floors a near-zero distance to a large finite value (conservative refine)', () => {
    const v = projectedPixels(1, 0, 1000, VFOV);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(1e6);
  });
});

describe('coveragePixels / spacingErrorPixels', () => {
  it('share the same projection', () => {
    expect(coveragePixels(2, 5, 1000, VFOV)).toBeCloseTo(spacingErrorPixels(2, 5, 1000, VFOV), 12);
  });
});
