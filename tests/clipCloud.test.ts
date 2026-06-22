/**
 * clipCloud.test.ts — the CPU clip filter used to restrict an export to the box.
 * Verifies keep-inside / keep-outside selection and that every per-point channel
 * (colour, classification) is filtered in lockstep, and that a disabled clip is a
 * no-op (same instance, no copy).
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { makeClipBox, type ClipBox, type ClipMode } from '../src/render/clip/clipBox';
import { clipCloud } from '../src/render/clip/clipCloud';

function sampleCloud(): PointCloud {
  return new PointCloud({
    // 3 points inside a [-1,3]^3 box, one well outside at (5,5,5).
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 5, 5, 5]),
    colors: new Uint8Array([10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40]),
    classification: new Uint8Array([1, 2, 3, 4]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'test.las',
  });
}

const clip = (mode: ClipMode): ClipBox => ({
  box: { min: [-1, -1, -1], max: [3, 3, 3] },
  mode,
  enabled: true,
});

describe('clipCloud', () => {
  it('keep-inside retains only points in the box, filtering every channel', () => {
    const c = clipCloud(sampleCloud(), clip('keep-inside'));
    expect(c.pointCount).toBe(3);
    expect(Array.from(c.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
    expect(Array.from(c.colors!)).toEqual([10, 10, 10, 20, 20, 20, 30, 30, 30]);
    expect(Array.from(c.classification!)).toEqual([1, 2, 3]);
  });

  it('keep-outside retains only points outside the box', () => {
    const c = clipCloud(sampleCloud(), clip('keep-outside'));
    expect(c.pointCount).toBe(1);
    expect(Array.from(c.positions)).toEqual([5, 5, 5]);
    expect(Array.from(c.classification!)).toEqual([4]);
  });

  it('a disabled clip returns the same cloud (no copy)', () => {
    const c = sampleCloud();
    expect(clipCloud(c, makeClipBox({ min: [-1, -1, -1], max: [3, 3, 3] }))).toBe(c);
  });

  it('carries the origin, name, and source format onto the clipped clone', () => {
    const c = clipCloud(sampleCloud(), clip('keep-inside'));
    expect(c.origin).toEqual([0, 0, 0]);
    expect(c.name).toBe('test.las');
    expect(c.sourceFormat).toBe('las');
  });
});
