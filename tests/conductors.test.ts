/**
 * conductors.test.ts — conductor centreline + sag fit, with a linearity gate.
 */

import { describe, it, expect } from 'vitest';
import { fitConductor, type Vec3 } from '../src/features/conductors';

/** A sagging wire along x: z = z0 − sag·(1 − (2x/span − 1)²), plus tiny noise. */
function saggingWire(span: number, sag: number, n: number, seed = 1): Vec3[] {
  let a = seed >>> 0;
  const r = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5; };
  const pts: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const x = (span * i) / (n - 1);
    const u = (2 * x) / span - 1; // -1..1
    const z = 20 - sag * (1 - u * u); // dips by `sag` at mid-span
    pts.push([x + r() * 0.01, 5 + r() * 0.01, z + r() * 0.01]);
  }
  return pts;
}

describe('fitConductor', () => {
  it('recovers span and sag of a synthetic sagging wire, high linearity', () => {
    const pts = saggingWire(100, 3, 200);
    const f = fitConductor(pts);
    expect(f.ok).toBe(true);
    expect(f.linearity).toBeGreaterThan(0.95);
    expect(f.spanM).toBeCloseTo(100, 0);
    expect(f.sagM).toBeCloseTo(3, 1); // ~3 m mid-span sag
    expect(f.residualRms).toBeLessThan(0.05);
    // Centreline is horizontal along x.
    expect(Math.abs(f.centerlineDir[0])).toBeGreaterThan(0.99);
  });

  it('refuses a blob (not linear) — not every cluster is a wire', () => {
    const blob: Vec3[] = [];
    for (let i = 0; i < 200; i++) blob.push([(i % 10), Math.floor(i / 10) % 10, (i * 7) % 5]);
    const f = fitConductor(blob);
    expect(f.ok).toBe(false);
    expect(f.reason).toBe('NOT_LINEAR');
  });

  it('refuses too few points', () => {
    const f = fitConductor([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    expect(f.ok).toBe(false);
    expect(f.reason).toBe('TOO_FEW_POINTS');
  });

  it('a taut (near-zero-sag) wire fits with ~0 sag and still reads as linear', () => {
    const taut = saggingWire(80, 0.02, 150);
    const f = fitConductor(taut);
    expect(f.ok).toBe(true);
    expect(f.sagM).toBeLessThan(0.2);
  });
});
