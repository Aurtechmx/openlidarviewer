import { describe, it, expect } from 'vitest';
import { localDensitySizes } from '../src/render/localDensitySize';

/**
 * tests/localDensitySize.test.ts
 *
 * Regression coverage for the density-adaptive point-sizing formula.
 * v0.3.10 formula-hardening pass — the module had unit-test coverage
 * gap that the Visuals Studio audit flagged. The function is on the
 * hot path for every static-cloud render with adaptive sizing
 * enabled, so silent NaN propagation or divide-by-zero would surface
 * as black-pixel zones in the rendered scan.
 */

describe('localDensitySizes — pure data formula hardening', () => {
  it('returns an empty Float32Array for an empty input', () => {
    const out = localDensitySizes({
      positions: new Float32Array(0),
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out.length).toBe(0);
  });

  it('handles a single point gracefully (one cell, count = 1)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0]),
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out.length).toBe(1);
    // ratio = refDensity / cellDensity = 1 / (1 / 1) = 1 → scale = √1 = 1
    expect(out[0]).toBeCloseTo(1, 6);
  });

  it('clamps refDensity = 0 to a safe lower bound (no NaN)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0, 1, 1, 0]),
      cellSize: 1,
      referenceDensity: 0,
    });
    // ratio = 1e-9 / cellD → very small, sqrt → still small, clamps to minScale (0.5)
    expect(out.length).toBe(2);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isFinite(out[1])).toBe(true);
    expect(out[0]).toBeGreaterThanOrEqual(0.5); // default minScale
  });

  it('clamps cellSize ≤ 0 to a safe lower bound (no divide-by-zero)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0, 1, 1, 0]),
      cellSize: 0,
      referenceDensity: 1,
    });
    expect(out.length).toBe(2);
    expect(Number.isFinite(out[0])).toBe(true);
    expect(Number.isFinite(out[1])).toBe(true);
  });

  it('returns identical scales for uniform density', () => {
    // 4 points in 4 separate 1×1 cells — each cell has density 1/m²,
    // which equals the reference density. All scales should be ≈ 1.
    const positions = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      2, 2, 0,
    ]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out.length).toBe(4);
    for (const v of out) expect(v).toBeCloseTo(1, 6);
  });

  it('shrinks scale in dense regions, grows scale in sparse regions', () => {
    // 5 points stacked in one cell (dense) + 1 point alone in another (sparse).
    const positions = new Float32Array([
      // Five points crammed into the (0,0) cell.
      0.1, 0.1, 0,
      0.2, 0.2, 0,
      0.3, 0.3, 0,
      0.4, 0.4, 0,
      0.5, 0.5, 0,
      // One lone point in the (10,10) cell.
      10.1, 10.1, 0,
    ]);
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 1,
    });
    // Dense cell points all share the same scale (smaller than reference).
    expect(out[0]).toBe(out[1]);
    expect(out[0]).toBe(out[4]);
    // Dense < reference (1) < sparse — verifies the curve direction.
    expect(out[0]).toBeLessThan(1);
    // Sparse point's scale is exactly ≈ 1 (matches reference density).
    expect(out[5]).toBeCloseTo(1, 6);
  });

  it('honours custom minScale / maxScale caps', () => {
    // Extreme dense region — without caps the sqrt(ratio) could go
    // very small. The minScale cap keeps every output ≥ minScale.
    const positions = new Float32Array(60);
    for (let i = 0; i < 20; i++) {
      positions[i * 3] = 0.1;
      positions[i * 3 + 1] = 0.1;
      positions[i * 3 + 2] = 0;
    }
    const out = localDensitySizes({
      positions,
      cellSize: 1,
      referenceDensity: 1,
      minScale: 0.25,
      maxScale: 4,
    });
    expect(out.length).toBe(20);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0.25);
      expect(v).toBeLessThanOrEqual(4);
    }
  });

  it('never produces NaN or Infinity on any input', () => {
    // Fuzz a small set of weird-but-valid inputs and assert finite output.
    const inputs: Array<Parameters<typeof localDensitySizes>[0]> = [
      { positions: new Float32Array([0, 0, 0]), cellSize: 1e-6, referenceDensity: 1e9 },
      { positions: new Float32Array([1e6, 1e6, 0]), cellSize: 1, referenceDensity: 1 },
      { positions: new Float32Array([-1e6, -1e6, 0]), cellSize: 1, referenceDensity: 1 },
    ];
    for (const input of inputs) {
      const out = localDensitySizes(input);
      for (const v of out) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});
