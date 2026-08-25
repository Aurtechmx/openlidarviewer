/**
 * conductors.test.ts — conductor centreline + sag fit, with a linearity gate.
 */

import { describe, it, expect } from 'vitest';
import { fitConductor, type Vec3 } from '../src/features/conductors';

const Z_UP: Vec3 = [0, 0, 1];
const Y_UP: Vec3 = [0, 1, 0];

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

/** Rotate +90° about X: the Z-up frame's up axis becomes +Y. Proper rotation. */
function toYUp(pts: readonly Vec3[]): Vec3[] {
  return pts.map((p) => [p[0], p[2], -p[1]] as Vec3);
}

describe('fitConductor', () => {
  it('recovers span and sag of a synthetic sagging wire, high linearity', () => {
    const pts = saggingWire(100, 3, 200);
    const f = fitConductor(pts, Z_UP);
    expect(f.ok).toBe(true);
    expect(f.linearity).toBeGreaterThan(0.95);
    expect(f.spanSource).toBeCloseTo(100, 0);
    expect(f.sagSource).toBeCloseTo(3, 1); // ~3 units of mid-span sag
    expect(f.residualRmsSource).toBeLessThan(0.05);
    // Centreline is horizontal along x.
    expect(Math.abs(f.centerlineDir[0])).toBeGreaterThan(0.99);
  });

  it('refuses a blob (not linear) — not every cluster is a wire', () => {
    const blob: Vec3[] = [];
    for (let i = 0; i < 200; i++) blob.push([(i % 10), Math.floor(i / 10) % 10, (i * 7) % 5]);
    const f = fitConductor(blob, Z_UP);
    expect(f.ok).toBe(false);
    expect(f.reason).toBe('NOT_LINEAR');
  });

  it('refuses too few points', () => {
    const f = fitConductor([[0, 0, 0], [1, 0, 0], [2, 0, 0]], Z_UP);
    expect(f.ok).toBe(false);
    expect(f.reason).toBe('TOO_FEW_POINTS');
  });

  it('a taut (near-zero-sag) wire fits with ~0 sag and still reads as linear', () => {
    const taut = saggingWire(80, 0.02, 150);
    const f = fitConductor(taut, Z_UP);
    expect(f.ok).toBe(true);
    expect(f.sagSource).toBeLessThan(0.2);
  });

  it('measures the SAME span and sag when the same wire arrives in a Y-up frame', () => {
    const pts = saggingWire(100, 3, 200);
    const zUp = fitConductor(pts, Z_UP);
    const yUp = fitConductor(toYUp(pts), Y_UP);
    expect(yUp.ok).toBe(true);
    expect(yUp.spanSource).toBeCloseTo(zUp.spanSource, 9);
    expect(yUp.sagSource).toBeCloseTo(zUp.sagSource, 9);
    expect(yUp.sagSource).toBeCloseTo(3, 1);
    expect(yUp.residualRmsSource).toBeCloseTo(zUp.residualRmsSource, 9);
  });

  it('reading height off Z in a Y-up frame is what the up axis prevents', () => {
    // The same wire, fitted against the WRONG up axis: the sag it reports is
    // not the wire's sag, which is why `up` is a parameter and not an
    // assumption.
    const pts = toYUp(saggingWire(100, 3, 200));
    const wrong = fitConductor(pts, Z_UP);
    expect(wrong.ok).toBe(true);
    expect(Math.abs(wrong.sagSource - 3)).toBeGreaterThan(1);
  });

  it('refuses a degenerate up axis rather than inventing a vertical', () => {
    const f = fitConductor(saggingWire(100, 3, 200), [0, 0, 0]);
    expect(f.ok).toBe(false);
    expect(f.reason).toBe('DEGENERATE_UP');
  });
});
