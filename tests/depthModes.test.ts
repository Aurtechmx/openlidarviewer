/**
 * depthModes.test.ts
 *
 * The depth resolution each depth-buffer scheme stores, as the depth-mode
 * benchmark reports it, at the viewer's near and far planes (0.1 m, 5000 km).
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper shared with the benchmark runner
import { depthResolution, float32Ulp, resolutionTable, storedDepth, summariseFrames } from '../scripts/lib/depthModes.mjs';

const NEAR = 0.1;
const FAR = 5_000_000;

describe('depth modes', () => {
  it('float32 spacing matches Math.fround', () => {
    for (const v of [1, 0.75, 0.1, 2e-6, 3.3e-9]) {
      const f = Math.fround(v);
      const next = Math.fround(f + float32Ulp(f));
      expect(next).toBeGreaterThan(f);
      expect(Math.fround(f + float32Ulp(f) * 0.49)).toBe(f);
    }
  });

  it('stored depth runs 0 to 1 near to far, reversed runs 1 to 0', () => {
    expect(storedDepth('standard', NEAR, NEAR, FAR)).toBeCloseTo(0, 12);
    expect(storedDepth('standard', FAR, NEAR, FAR)).toBeCloseTo(1, 12);
    expect(storedDepth('log', NEAR, NEAR, FAR)).toBeCloseTo(0, 12);
    expect(storedDepth('log', FAR, NEAR, FAR)).toBeCloseTo(1, 12);
    expect(storedDepth('reversed', NEAR, NEAR, FAR)).toBeCloseTo(1, 12);
    expect(storedDepth('reversed', FAR, NEAR, FAR)).toBeCloseTo(0, 12);
  });

  it('standard depth cannot separate surfaces a metre apart at 1.5 km', () => {
    expect(depthResolution('standard', 1500, NEAR, FAR)).toBeGreaterThan(1);
  });

  it('log depth holds about a millionth of the distance everywhere', () => {
    for (const d of [1, 100, 10_000, 50_000]) {
      expect(depthResolution('log', d, NEAR, FAR) / d).toBeCloseTo(1.06e-6, 7);
    }
  });

  it('reversed float depth is finer than log depth at every survey distance', () => {
    for (const row of resolutionTable(NEAR, FAR)) {
      expect(row.reversed).toBeLessThan(row.log);
      expect(row.reversed / row.d).toBeLessThan(1.3e-7);
    }
  });

  it('summarises frame times', () => {
    expect(summariseFrames([3, 1, 2, 10])).toEqual({ medianMs: 3, p95Ms: 10, frames: 4 });
    expect(summariseFrames([])).toEqual({ medianMs: null, p95Ms: null, frames: 0 });
  });
});
