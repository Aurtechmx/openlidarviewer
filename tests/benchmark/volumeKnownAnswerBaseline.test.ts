/**
 * volumeKnownAnswerBaseline.test.ts: the cut-fill volume against two scenes
 * with a closed-form answer, frozen in docs/validation/volume-known-answer-baseline.json.
 *
 * Both scenes are the defects `olv.volume.stockpile@3` fixed: a point-weighted
 * sum that let a densely scanned half outweigh a sparse one (90 m³ for 50), and
 * a lasso footprint taken as the convex hull of the selection (67 m² for an
 * L-shaped 36). Each run recomputes the shipping figure and the superseded one
 * and holds them to the frozen rows: the shipping figure must sit within the
 * row's tolerance of the truth and match the recorded figure, and the legacy
 * figure must still reproduce, so the baseline cannot drift from the code.
 * Deterministic and fast; not gated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { volumeCutFill, pointSampleCutFill, CUT_FILL_VOLUME_METHOD } from '../../src/render/measure/volume';
import { volumeFromLassoWithFootprint } from '../../src/render/measure/lassoVolume';
import type { Vec3 } from '../../src/render/navMath';

interface Case {
  readonly id: string;
  readonly truthM3: number;
  readonly legacyM3: number;
  readonly recordedM3: number;
  readonly toleranceRel: number;
  readonly interpolationVerdict: string;
  readonly truthAreaM2?: number;
  readonly legacyAreaM2?: number;
  readonly recordedAreaM2?: number;
}
interface Baseline {
  readonly label: string;
  readonly method: string;
  readonly test: string;
  readonly cases: readonly Case[];
}

const baseline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../docs/validation/volume-known-answer-baseline.json', import.meta.url)), 'utf8'),
) as Baseline;
const row = (id: string): Case => {
  const c = baseline.cases.find((x) => x.id === id);
  if (!c) throw new Error(`baseline has no case ${id}`);
  return c;
};

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}

describe('volume known-answer baseline', () => {
  it('names this test and the method version the code ships', () => {
    expect(baseline.label).toBe('volume-known-answer-baseline');
    expect(baseline.test).toBe('tests/benchmark/volumeKnownAnswerBaseline.test.ts');
    expect(baseline.method).toBe(CUT_FILL_VOLUME_METHOD);
  });

  it('dense-half / sparse-half', () => {
    const c = row('dense-half-sparse-half');
    const r = lcg(12345);
    const pts: number[] = [];
    for (let i = 0; i < 900; i++) pts.push(r() * 5, r() * 10, 1);
    for (let i = 0; i < 100; i++) pts.push(5 + r() * 5, r() * 10, 0);
    const positions = new Float32Array(pts);
    const polygon: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
    const v = volumeCutFill({ polygon, referenceZ: 0, positions });
    const legacy = pointSampleCutFill({ polygon, referenceZ: 0, positions });
    expect(legacy.fill).toBeCloseTo(c.legacyM3, 3);
    expect(v.fill).toBeCloseTo(c.recordedM3, 2);
    expect(Math.abs(v.fill - c.truthM3) / c.truthM3).toBeLessThanOrEqual(c.toleranceRel);
    expect(v.interpolationVerdict).toBe(c.interpolationVerdict);
  });

  it('L-shaped lasso', () => {
    const c = row('l-shaped-lasso');
    const pts: number[] = [];
    for (let i = 0; i <= 100; i++) {
      for (let j = 0; j <= 100; j++) {
        const x = i * 0.1;
        const y = j * 0.1;
        if (y <= 2 || x <= 2) pts.push(x, y, x < 0.05 || y < 0.05 ? 0 : 1);
      }
    }
    const positions = new Float32Array(pts);
    const selected = Array.from({ length: pts.length / 3 }, (_, i) => i);
    const L: Array<[number, number]> = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 10], [0, 10]];
    const out = volumeFromLassoWithFootprint({
      positions, selected, footprint: (z) => L.map(([x, y]) => [x, y, z] as Vec3),
    });
    const hull = volumeFromLassoWithFootprint({ positions, selected, footprint: () => null });
    const legacy = pointSampleCutFill({
      polygon: hull.polygon3D, referenceZ: hull.referenceZ, positions,
    });
    expect(legacy.fill).toBeCloseTo(c.legacyM3, 1);
    expect(legacy.footprintArea).toBeCloseTo(c.legacyAreaM2!, 2);
    expect(out.footprintBasis).toBe('drawn-lasso');
    expect(out.result.footprintArea).toBeCloseTo(c.recordedAreaM2!, 6);
    expect(out.result.fill).toBeCloseTo(c.recordedM3, 2);
    expect(Math.abs(out.result.fill - c.truthM3) / c.truthM3).toBeLessThanOrEqual(c.toleranceRel);
    expect(Math.abs(out.result.footprintArea - c.truthAreaM2!) / c.truthAreaM2!).toBeLessThanOrEqual(c.toleranceRel);
    expect(out.result.interpolationVerdict).toBe(c.interpolationVerdict);
  });
});
