import { describe, it, expect } from 'vitest';
import { aggregate } from '../src/render/measure/measurementChains';
import { BOX_NO_HEIGHT_NOTE } from '../src/render/measure/geometry';
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

  it('blames the clip region beside a member that has no volume at all', () => {
    const line = { id: 'd', kind: 'distance', name: 'D', points: [[0, 0, 0], [10, 0, 0]] } as unknown as Measurement;
    for (const op of ['sum', 'mean'] as const) {
      const r = aggregate([clipBox, line], op, 'volume-fill');
      expect(r.contributingCount).toBe(0);
      expect(r.refusal).toMatch(/clip region spans/);
      expect(Number.isNaN(r.value)).toBe(true);
    }
  });
});

describe('a volume chain with a box that has no height', () => {
  const flatBox = { id: 'f', kind: 'box', name: 'F', points: [[0, 0, 5], [10, 10, 5]] } as unknown as Measurement;

  it('withholds the chain with the box\'s own reason instead of reading 0', () => {
    const r = aggregate([flatBox], 'sum', 'volume-fill');
    expect(r.contributingCount).toBe(0);
    expect(Number.isNaN(r.value)).toBe(true);
    expect(r.refusal).toBe(BOX_NO_HEIGHT_NOTE);
  });

  it('states the box\'s reason beside a clip region, and notes the clip region', () => {
    const r = aggregate([clipBox, flatBox], 'sum', 'volume-fill');
    expect(r.contributingCount).toBe(0);
    expect(r.refusal).toMatch(/^Volume withheld: the box has no height/);
    expect(r.refusal).toMatch(/ Clip regions left out: .*measured volume\.$/);
  });

  it('states the reason a session gave for a polygon it holds no volume for', () => {
    const polygon = { id: 'p', kind: 'volume', name: 'P', closed: true, points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], derivedWithheld: 'Volume withheld: the session did not record the up axis it was cut along.' } as unknown as Measurement;
    expect(aggregate([polygon], 'sum', 'volume-fill').refusal).toBe(polygon.derivedWithheld);
    expect(aggregate([clipBox, polygon], 'sum', 'volume-fill').refusal).toMatch(/^Volume withheld: the session did not record/);
  });

  it('withholds, rather than reads 0, when no member has a volume or a reason', () => {
    const polygon = { id: 'p', kind: 'volume', name: 'P', closed: true, points: [[0, 0, 0], [10, 0, 0], [10, 10, 0]] } as unknown as Measurement;
    const r = aggregate([polygon], 'sum', 'volume-fill');
    expect(r.refusal).toBe('Volume withheld: no member has a measured volume.');
    expect(Number.isNaN(r.value)).toBe(true);
  });

  it('still sums a box with a height', () => {
    const tall = { id: 't', kind: 'box', name: 'T', points: [[0, 0, 0], [10, 10, 2]] } as unknown as Measurement;
    const r = aggregate([tall, flatBox], 'sum', 'volume-fill');
    expect(r.contributingCount).toBe(1);
    expect(r.value).toBeCloseTo(200, 9);
    expect(r.refusal).toBeUndefined();
  });
});
