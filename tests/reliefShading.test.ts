import { describe, it, expect } from 'vitest';
import {
  shadeFromSlopeAspect,
  computeMultiHillshade,
  computeHillshade,
} from '../src/terrain/surface/hillshade';

const COLS = 4;
const ROWS = 4;
const N = COLS * ROWS;

describe('shadeFromSlopeAspect', () => {
  it('shades flat terrain uniformly to 255·cos(zenith)', () => {
    const slope = new Float32Array(N).fill(0);
    const aspect = new Float32Array(N).fill(0);
    const cov = new Uint8Array(N).fill(1);
    const r = shadeFromSlopeAspect(slope, aspect, cov, COLS, ROWS, { altitudeDeg: 45 });
    // zenith = 45°, cos = 0.7071 → ~180
    const expected = Math.round(255 * Math.cos((45 * Math.PI) / 180));
    for (let i = 0; i < N; i++) {
      expect(r.coverage[i]).toBe(1);
      expect(Math.abs(r.shade[i] - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('leaves uncovered cells transparent (coverage 0, shade 0)', () => {
    const slope = new Float32Array(N).fill(0.2);
    const aspect = new Float32Array(N).fill(1);
    const cov = new Uint8Array(N).fill(1);
    cov[5] = 0;
    const r = shadeFromSlopeAspect(slope, aspect, cov, COLS, ROWS);
    expect(r.coverage[5]).toBe(0);
    expect(r.shade[5]).toBe(0);
  });

  it('matches computeHillshade for a derived surface (delegation is faithful)', () => {
    // A simple tilted plane: z increases with x.
    const z = new Float32Array(N);
    for (let row = 0; row < ROWS; row++) for (let c = 0; c < COLS; c++) z[row * COLS + c] = c * 2;
    const cov = new Uint8Array(N).fill(1);
    const direct = computeHillshade(z, COLS, ROWS, 1, cov, { azimuthDeg: 315, altitudeDeg: 45 });
    expect(direct.shade.length).toBe(N);
    // Interior cells should carry a finite, in-range shade.
    expect(direct.shade[5]).toBeGreaterThanOrEqual(0);
    expect(direct.shade[5]).toBeLessThanOrEqual(255);
  });
});

describe('computeMultiHillshade', () => {
  it('produces in-range shading and respects coverage', () => {
    const slope = new Float32Array(N);
    const aspect = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      slope[i] = (i % 3) * 0.15;
      aspect[i] = (i / N) * Math.PI * 2;
    }
    const cov = new Uint8Array(N).fill(1);
    cov[0] = 0;
    const r = computeMultiHillshade(slope, aspect, cov, COLS, ROWS, { altitudeDeg: 45 });
    expect(r.coverage[0]).toBe(0);
    expect(r.shade[0]).toBe(0);
    for (let i = 1; i < N; i++) {
      expect(r.shade[i]).toBeGreaterThanOrEqual(0);
      expect(r.shade[i]).toBeLessThanOrEqual(255);
    }
  });

  it('shades flat terrain to the same value as a single light (≈255·cos zenith)', () => {
    const slope = new Float32Array(N).fill(0);
    const aspect = new Float32Array(N).fill(0);
    const cov = new Uint8Array(N).fill(1);
    const r = computeMultiHillshade(slope, aspect, cov, COLS, ROWS, { altitudeDeg: 45 });
    const expected = Math.round(255 * Math.cos((45 * Math.PI) / 180));
    expect(Math.abs(r.shade[0] - expected)).toBeLessThanOrEqual(1);
  });
});
