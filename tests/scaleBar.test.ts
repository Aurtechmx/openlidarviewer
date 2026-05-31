/**
 * tests/scaleBar.test.ts
 *
 * Coverage for the v0.3.7 scale-bar formatter + pixels-per-metre helper.
 */

import { describe, it, expect } from 'vitest';
import { computeScaleBar, pixelsPerMetreAt } from '../src/render/scaleBar';

describe('computeScaleBar', () => {
  it('returns a 0-length bar for invalid pixelsPerMetre', () => {
    expect(computeScaleBar(0, 200)).toEqual({ stepMetres: 0, stepPixels: 0, label: '' });
    expect(computeScaleBar(-5, 200)).toEqual({ stepMetres: 0, stepPixels: 0, label: '' });
    expect(computeScaleBar(NaN, 200)).toEqual({ stepMetres: 0, stepPixels: 0, label: '' });
  });

  it('returns a 0-length bar for non-positive maxPixels', () => {
    expect(computeScaleBar(10, 0)).toEqual({ stepMetres: 0, stepPixels: 0, label: '' });
    expect(computeScaleBar(10, -10)).toEqual({ stepMetres: 0, stepPixels: 0, label: '' });
  });

  it('picks a sensible step for a wide field of view', () => {
    // 5 px/m + 400 px budget — 0.6 × 400 = 240 px target, ÷ 5 = 48 m
    // Nice-1-2-5 step ≤ 48 m → 20 m.
    const r = computeScaleBar(5, 400);
    expect(r.stepMetres).toBe(20);
    expect(r.stepPixels).toBe(100);
    expect(r.label).toBe('20 m');
  });

  it('picks a sub-metre step on a close-in zoom', () => {
    // 1000 px/m + 200 px budget — 0.6 × 200 = 120 px target, ÷ 1000 = 0.12 m
    // Nice-1-2-5 step ≤ 0.12 m → 0.1 m.
    const r = computeScaleBar(1000, 200);
    expect(r.stepMetres).toBeCloseTo(0.1, 3);
    expect(r.label).toBe('10 cm');
  });

  it('uses km units beyond 1 000 m', () => {
    // 0.01 px/m + 800 px budget — target = 0.6 × 800 / 0.01 = 48 000 m
    // Nice-1-2-5 step ≤ 48 000 → 20 000 m → 20 km.
    const r = computeScaleBar(0.01, 800);
    expect(r.stepMetres).toBe(20_000);
    expect(r.label).toBe('20 km');
  });
});

describe('pixelsPerMetreAt', () => {
  it('returns 0 for degenerate inputs', () => {
    expect(pixelsPerMetreAt(0, 600, 10)).toBe(0);
    expect(pixelsPerMetreAt(Math.PI / 4, 0, 10)).toBe(0);
    expect(pixelsPerMetreAt(Math.PI / 4, 600, 0)).toBe(0);
    expect(pixelsPerMetreAt(NaN, 600, 10)).toBe(0);
  });

  it('matches the perspective formula on known camera state', () => {
    // 60° vertical FOV → tan(30°) ≈ 0.5774. Canvas height 600 px,
    // distance 10 m → 600 / (2 · 10 · 0.5774) ≈ 51.96 px/m.
    const ppm = pixelsPerMetreAt(Math.PI / 3, 600, 10);
    expect(ppm).toBeCloseTo(600 / (2 * 10 * Math.tan(Math.PI / 6)), 5);
    expect(ppm).toBeGreaterThan(50);
    expect(ppm).toBeLessThan(55);
  });

  it('halves when distance doubles', () => {
    const near = pixelsPerMetreAt(Math.PI / 3, 600, 10);
    const far = pixelsPerMetreAt(Math.PI / 3, 600, 20);
    expect(far).toBeCloseTo(near / 2, 5);
  });
});
