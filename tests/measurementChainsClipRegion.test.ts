import { describe, it, expect } from 'vitest';
import { aggregate } from '../src/render/measure/measurementChains';
import type { Measurement } from '../src/render/measure/types';

const clipBox = { id: 'b', kind: 'box', name: 'B', points: [[0, 0, 0], [10, 10, 0]], clipRegion: true } as unknown as Measurement;
const withheldVolume = {
  id: 'v', kind: 'volume', name: 'V', closed: true,
  points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
  volume: { fill: undefined, cut: undefined, net: undefined, gridAuthority: 'withheld', gridAuthorityReason: 'footprint not supported' },
} as unknown as Measurement;

describe('a volume chain with a clip region', () => {
  it('blames the clip region only when every member is one', () => {
    const r = aggregate([clipBox, withheldVolume], 'sum', 'volume-fill');
    expect(r.contributingCount).toBe(0);
    expect(r.refusal).toMatch(/^Volume withheld: footprint not supported\./);
    expect(r.refusal).not.toMatch(/clip region spans/);
    expect(Number.isNaN(r.value)).toBe(true);
    const only = aggregate([clipBox], 'sum', 'volume-fill');
    expect(only.refusal).toMatch(/clip region spans/);
  });

  it('says nothing about clip regions for an empty chain', () => {
    expect(aggregate([], 'sum', 'volume-fill').refusal).toBeUndefined();
  });
});
