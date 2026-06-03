/**
 * hypsometric.test.ts — elevation colour ramp.
 */

import { describe, it, expect } from 'vitest';
import {
  hypsometricColor,
  DEFAULT_TERRAIN_PALETTE,
} from '../src/terrain/contour/hypsometric';

describe('hypsometricColor', () => {
  it('returns the first stop at the minimum elevation', () => {
    expect(hypsometricColor(0, 0, 100)).toEqual(DEFAULT_TERRAIN_PALETTE[0].color);
  });

  it('returns the last stop at the maximum elevation', () => {
    const last = DEFAULT_TERRAIN_PALETTE[DEFAULT_TERRAIN_PALETTE.length - 1].color;
    expect(hypsometricColor(100, 0, 100)).toEqual(last);
  });

  it('hits an interior stop exactly at its normalised position', () => {
    // Stop at t=0.35 → value 35 over a 0..100 range.
    const stop = DEFAULT_TERRAIN_PALETTE.find((s) => s.t === 0.35)!;
    expect(hypsometricColor(35, 0, 100)).toEqual(stop.color);
  });

  it('interpolates between stops and stays in 0..255', () => {
    const c = hypsometricColor(20, 0, 100);
    for (const ch of [c.r, c.g, c.b]) {
      expect(ch).toBeGreaterThanOrEqual(0);
      expect(ch).toBeLessThanOrEqual(255);
      expect(Number.isInteger(ch)).toBe(true);
    }
  });

  it('clamps out-of-range elevations to the palette ends', () => {
    expect(hypsometricColor(-50, 0, 100)).toEqual(DEFAULT_TERRAIN_PALETTE[0].color);
    const last = DEFAULT_TERRAIN_PALETTE[DEFAULT_TERRAIN_PALETTE.length - 1].color;
    expect(hypsometricColor(500, 0, 100)).toEqual(last);
  });

  it('returns the first stop for a flat surface (maxZ <= minZ)', () => {
    expect(hypsometricColor(5, 10, 10)).toEqual(DEFAULT_TERRAIN_PALETTE[0].color);
  });
});
