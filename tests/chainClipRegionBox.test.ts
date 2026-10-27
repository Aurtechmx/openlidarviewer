/**
 * A clip-region box spans the scan's full height, so it has no measured
 * height or volume. A chain total leaves it out and says so.
 */
import { describe, it, expect } from 'vitest';
import { aggregate, chainMetricKeys, formatChainResult, valueForDimension } from '../src/render/measure/measurementChains';
import type { Measurement } from '../src/render/measure/types';

const real: Measurement = { id: 'r', kind: 'box', name: 'r', points: [[0, 0, 0], [2, 3, 4]] };
const clip: Measurement = { id: 'c', kind: 'box', name: 'c', points: [[0, 0, -50], [10, 10, 80]], clipRegion: true };

describe('chain totals with a clip-region box', () => {
  it('a clip-region box gives no volume', () => {
    expect(valueForDimension(clip, 'volume-fill')).toBeNull();
    expect(valueForDimension(clip, 'height')).toBeNull();
  });

  it('a mix totals only the real box and says one was left out', () => {
    const r = aggregate([real, clip], 'sum', 'volume-fill');
    expect(r.value).toBeCloseTo(24, 9);
    expect(r.contributingCount).toBe(1);
    expect(r.refusal).toBeUndefined();
    expect(r.note).toMatch(/clip region/i);
    expect(formatChainResult(r)).toMatch(/clip region/i);
  });

  it('only clip-region boxes: the volume is withheld with the reason', () => {
    const r = aggregate([clip], 'sum', 'volume-fill');
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.refusal).toMatch(/withheld/i);
    expect(r.refusal).toMatch(/full height/i);
  });

  it('offers no height or volume keys for a clip-region box', () => {
    expect(chainMetricKeys('box', 'volume-fill', true)).toEqual([]);
    expect(chainMetricKeys('box', 'height', true)).toEqual([]);
    expect(chainMetricKeys('box', 'area', true)).toEqual(['width_m', 'depth_m']);
    expect(chainMetricKeys('box', 'volume-fill')).toContain('volume_m3');
  });
});
