import { describe, it, expect } from 'vitest';
import { localDensitySizes, autoDensitySizeParams } from '../src/render/localDensitySize';

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
    expect(out).toHaveLength(0);
  });

  it('handles a single point gracefully (one cell, count = 1)', () => {
    const out = localDensitySizes({
      positions: new Float32Array([0, 0, 0]),
      cellSize: 1,
      referenceDensity: 1,
    });
    expect(out).toHaveLength(1);
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
    expect(out).toHaveLength(2);
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
    expect(out).toHaveLength(2);
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
    expect(out).toHaveLength(4);
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
    expect(out).toHaveLength(20);
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

describe('autoDensitySizeParams', () => {
  it('returns safe unit values for an empty cloud', () => {
    expect(autoDensitySizeParams(new Float32Array(0))).toEqual({ cellSize: 1, referenceDensity: 1 });
  });

  it('sets the reference to the mean areal density and a positive cell size', () => {
    // 100 points on a 10×10 grid at spacing 1 → footprint 9×9 = 81 m², so the
    // mean areal density is 100/81 ≈ 1.235 points/m².
    const positions = new Float32Array(100 * 3);
    let k = 0;
    for (let ix = 0; ix < 10; ix++) {
      for (let iy = 0; iy < 10; iy++) {
        positions[k++] = ix;
        positions[k++] = iy;
        positions[k++] = 0;
      }
    }
    const { cellSize, referenceDensity } = autoDensitySizeParams(positions);
    expect(referenceDensity).toBeCloseTo(100 / 81, 2);
    expect(cellSize).toBeGreaterThan(0);
  });

  it('feeds params that keep a uniform cloud near scale 1', () => {
    // A uniform grid has ~constant local density, so every per-point scale
    // should sit near 1 (neither the sparse-grow nor dense-shrink cap).
    const positions = new Float32Array(400 * 3);
    let k = 0;
    for (let ix = 0; ix < 20; ix++) {
      for (let iy = 0; iy < 20; iy++) {
        positions[k++] = ix;
        positions[k++] = iy;
        positions[k++] = 0;
      }
    }
    const scales = localDensitySizes({ positions, ...autoDensitySizeParams(positions) });
    const mean = scales.reduce((s, v) => s + v, 0) / scales.length;
    expect(mean).toBeGreaterThan(0.6);
    expect(mean).toBeLessThan(1.6);
  });
});
