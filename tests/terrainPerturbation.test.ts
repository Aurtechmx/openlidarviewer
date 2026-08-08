/**
 * terrainPerturbation.test.ts — the seeded perturbation primitives.
 */

import { describe, it, expect } from 'vitest';
import { mulberry32, gaussian, perturbVertical, perturbXY, degradeGround, hashPoints } from '../src/validation/terrainPerturbation';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const pts = (): TerrainPoint[] => Array.from({ length: 500 }, (_, i) => ({ x: i, y: i * 2, z: 100 + (i % 7) }));

describe('mulberry32 / gaussian', () => {
  it('is deterministic for a seed and varies with it', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const seq = (r: () => number) => [r(), r(), r(), r()];
    expect(seq(a)).toEqual(seq(b));
    expect(seq(mulberry32(42))).not.toEqual(seq(c));
  });
  it('gaussian has ~0 mean and ~unit variance over many draws', () => {
    const r = mulberry32(7);
    let sum = 0, sumsq = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const g = gaussian(r); sum += g; sumsq += g * g; }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
    expect(Math.abs(sumsq / N - 1)).toBeLessThan(0.05);
  });
});

describe('perturbations are pure and seed-reproducible', () => {
  it('vertical noise: same seed reproduces identical z, only z moves', () => {
    const base = pts();
    const a = perturbVertical(base, 11, 0.05);
    const b = perturbVertical(base, 11, 0.05);
    expect(hashPoints(a)).toBe(hashPoints(b));
    expect(a[0].x).toBe(base[0].x); // x,y untouched
    expect(a[0].y).toBe(base[0].y);
    expect(base[0].z).toBe(pts()[0].z); // input not mutated
    // A different seed produces different data.
    expect(hashPoints(perturbVertical(base, 12, 0.05))).not.toBe(hashPoints(a));
  });
  it('xy jitter: same seed reproduces identical x,y, only x,y move', () => {
    const base = pts();
    const a = perturbXY(base, 5, 0.02);
    expect(hashPoints(a)).toBe(hashPoints(perturbXY(base, 5, 0.02)));
    expect(a[3].z).toBe(base[3].z);
  });
  it('degradeGround drops the requested fraction of class-2 deterministically', () => {
    const cls = new Uint8Array(1000).fill(2);
    cls[0] = 6; // one non-ground stays untouched
    const d1 = degradeGround(cls, 99, 0.25);
    const d2 = degradeGround(cls, 99, 0.25);
    expect(Array.from(d1)).toEqual(Array.from(d2)); // deterministic
    expect(d1[0]).toBe(6); // non-ground preserved
    const dropped = d1.reduce((n, v, i) => n + (cls[i] === 2 && v === 1 ? 1 : 0), 0);
    expect(dropped).toBeGreaterThan(200); // ~25% of 999
    expect(dropped).toBeLessThan(300);
    // 10% removes strictly fewer than 25%.
    const d10 = degradeGround(cls, 99, 0.10);
    const dropped10 = d10.reduce((n, v, i) => n + (cls[i] === 2 && v === 1 ? 1 : 0), 0);
    expect(dropped10).toBeLessThan(dropped);
  });
});
