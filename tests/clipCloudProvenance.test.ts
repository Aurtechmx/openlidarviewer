/**
 * clipCloudProvenance.test.ts — a clipped subset keeps the classification's
 * origin and its validity.
 *
 * Clipping built the subset by handing the filtered classes to the PointCloud
 * constructor, and constructor-supplied classes are a producer's. So a subset of
 * viewer-DERIVED codes came out claiming the file had classified those points,
 * and a subset of codes known to belong to a replaced coordinate frame came out
 * looking current. Clipping is on the export path, which makes that provenance
 * invented at the moment of export, and it also defeats the rule that withholds
 * frame-invalid derived classes from a new analysis: the clipped copy no longer
 * looked derived at all.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { clipCloud } from '../src/render/clip/clipCloud';
import type { ClipBox } from '../src/render/clip/clipBox';

/** Keeps the first point of the fixture, drops the second. */
const KEEP_FIRST: ClipBox = {
  box: { min: [-1, -1, -1], max: [1, 1, 1] },
  mode: 'keep-inside',
  enabled: true,
};
const KEEP_ALL: ClipBox = {
  box: { min: [-100, -100, -100], max: [100, 100, 100] },
  mode: 'keep-inside',
  enabled: true,
};
const KEEP_NONE: ClipBox = {
  box: { min: [900, 900, 900], max: [1000, 1000, 1000] },
  mode: 'keep-inside',
  enabled: true,
};

const positions = () => Float32Array.from([0, 0, 0, 10, 10, 10]);
const codes = () => Uint8Array.from([2, 6]);

const bare = () => new PointCloud({
  positions: positions(), origin: [500_000, 4_640_000, 0], sourceFormat: 'las', name: 'clip',
});

/** A cloud whose classes the viewer derived; optionally from a replaced frame. */
function derived(stale: boolean): PointCloud {
  const c = bare();
  c.attachDerivedClassification(codes());
  if (stale) c.markDerivedClassificationFrameInvalid();
  return c;
}

/** A cloud whose classes came from the file. */
const source = () => new PointCloud({
  positions: positions(), classification: codes(),
  origin: [500_000, 4_640_000, 0], sourceFormat: 'las', name: 'clip',
});

describe('clipping a classified cloud', () => {
  it('keeps source classes as source classes', () => {
    const out = clipCloud(source(), KEEP_FIRST);
    expect(Array.from(out.classification!)).toEqual([2]);
    expect(out.classificationIsDerived).toBe(false);
    expect(out.derivedClassificationFrameInvalid).toBe(false);
  });

  it('keeps derived classes derived', () => {
    const out = clipCloud(derived(false), KEEP_FIRST);
    expect(Array.from(out.classification!)).toEqual([2]);
    expect(out.classificationIsDerived).toBe(true);
    expect(out.derivedClassificationFrameInvalid).toBe(false);
  });

  it('keeps stale derived classes stale', () => {
    // The one that mattered: attaching marks codes freshly derived, which is
    // right for a new derive and wrong for a copy of old ones.
    const out = clipCloud(derived(true), KEEP_FIRST);
    expect(Array.from(out.classification!)).toEqual([2]);
    expect(out.classificationIsDerived).toBe(true);
    expect(out.derivedClassificationFrameInvalid).toBe(true);
  });

  it('returns the cloud itself when the clip keeps everything', () => {
    const c = derived(true);
    expect(clipCloud(c, KEEP_ALL)).toBe(c);
  });

  it('produces an empty subset that still reports its provenance', () => {
    const out = clipCloud(derived(true), KEEP_NONE);
    expect(out.pointCount).toBe(0);
    expect(out.classificationIsDerived).toBe(true);
    expect(out.derivedClassificationFrameInvalid).toBe(true);
  });

  it('leaves the original cloud untouched', () => {
    const c = derived(true);
    clipCloud(c, KEEP_FIRST);
    expect(Array.from(c.classification!)).toEqual([2, 6]);
    expect(c.pointCount).toBe(2);
    expect(c.derivedClassificationFrameInvalid).toBe(true);
  });

  it('filters every per-point channel to the same points', () => {
    const c = new PointCloud({
      positions: positions(),
      intensity: Uint16Array.from([11, 22]),
      returnNumber: Uint8Array.from([1, 2]),
      gpsTime: Float64Array.from([100, 200]),
      origin: [0, 0, 0], sourceFormat: 'las', name: 'channels',
    });
    c.attachDerivedClassification(codes());
    const out = clipCloud(c, KEEP_FIRST);
    expect(out.pointCount).toBe(1);
    expect(Array.from(out.intensity!)).toEqual([11]);
    expect(Array.from(out.returnNumber!)).toEqual([1]);
    expect(Array.from(out.gpsTime!)).toEqual([100]);
    expect(Array.from(out.classification!)).toEqual([2]);
  });

  it('carries no classification when the cloud had none', () => {
    const out = clipCloud(bare(), KEEP_FIRST);
    expect(out.classification).toBeUndefined();
    expect(out.classificationIsDerived).toBe(false);
  });
});
