import { describe, it, expect } from 'vitest';
import {
  buildElevationHistogram,
  clipShares,
  describeHistogram,
  formatShare,
  ordinal,
  percentileOf,
} from '../src/render/elevationHistogram';
import { computeElevationRange } from '../src/render/elevationRange';

/** Z-up positions whose heights are 0..n-1 (x, y = 0). */
function ramp(n: number): Float32Array {
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) p[i * 3 + 2] = i;
  return p;
}

/** A sample reading one axis of interleaved positions, plus an offset. */
function sampleOf(positions: Float32Array, count: number, axis = 2, offset = 0) {
  return { count, value: (i: number) => positions[i * 3 + axis] + offset };
}

describe('buildElevationHistogram', () => {
  it('bins the in-window values and counts the clipped tails', () => {
    const positions = ramp(100);
    const h = buildElevationHistogram(sampleOf(positions, 100, 2, 0), 5, 94, 10);
    expect(h).not.toBeNull();
    expect(h!.total).toBe(100);
    expect(h!.below).toBe(5); // 0..4
    expect(h!.above).toBe(5); // 95..99
    expect(h!.bins.reduce((a, b) => a + b, 0)).toBe(90);
    expect(h!.bins.length).toBe(10);
    // Uniform input → every bin holds 9 points.
    expect([...h!.bins]).toEqual(Array(10).fill(9));
  });

  it('matches the p5–p95 window computeElevationRange derives from the same sample', () => {
    const positions = ramp(1000);
    const r = computeElevationRange({ positions, pointCount: 1000 });
    const h = buildElevationHistogram(sampleOf(positions, 1000, 2, 0), r.minZ, r.maxZ)!;
    const c = clipShares(h);
    expect(c.below).toBeCloseTo(5, 5);
    expect(c.above).toBeCloseTo(4.9, 5);
    expect(h.total).toBe(r.sampleCount);
  });

  it('adds the source offset and reads the Y axis when Y is up', () => {
    const p = new Float32Array([0, 1, 0, 0, 2, 0, 0, 3, 0]);
    const h = buildElevationHistogram(sampleOf(p, 3, 1, 100), 101, 103, 2)!;
    expect(h.below + h.above).toBe(0);
    expect([...h.bins]).toEqual([1, 2]);
  });

  it('strides like the window pass on a large cloud (≤ 50 000 samples)', () => {
    const positions = ramp(200_000);
    const h = buildElevationHistogram(sampleOf(positions, 200_000, 2, 0), 0, 199_999)!;
    expect(h.total).toBe(50_000);
  });

  it('skips non-finite heights and refuses an empty or flat window', () => {
    const p = new Float32Array([0, 0, Number.NaN, 0, 0, 1]);
    expect(buildElevationHistogram(sampleOf(p, 2, 2, 0), 0, 2)!.total).toBe(1);
    expect(buildElevationHistogram(sampleOf(p, 0, 2, 0), 0, 2)).toBeNull();
    expect(buildElevationHistogram(sampleOf(p, 2, 2, 0), 1, 1)).toBeNull();
  });
});

describe('percentileOf', () => {
  const h = buildElevationHistogram(sampleOf(ramp(100), 100), 5, 94)!;
  it('is the share of the sample at or below the value', () => {
    expect(percentileOf(h, 70)).toBeCloseTo(71, 5);
    expect(percentileOf(h, -1)).toBe(0);
    expect(percentileOf(h, 1e9)).toBe(100);
    expect(percentileOf(h, 49.5)).toBe(50);
  });
});

describe('labels', () => {
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 71, 100, 0].map(ordinal)).toEqual(
      ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '71st', '100th', '0th'],
    );
  });
  it('shares never round a real tail down to 0', () => {
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.2)).toBe('<1%');
    expect(formatShare(5.04)).toBe('5%');
  });
  it('summarises the middle half and the clipped shares', () => {
    const h = buildElevationHistogram(sampleOf(ramp(100), 100), 5, 94)!;
    const text = describeHistogram(h, (v) => String(v), 'source units');
    expect(text).toBe('Half the sampled points lie between 25 and 75 source units; 5% below 5, 5% above 94.');
  });
});
