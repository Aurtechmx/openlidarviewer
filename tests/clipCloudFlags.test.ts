/**
 * clipCloudFlags.test.ts — a clip keeps the classification flags.
 *
 * Clipping filters every attribute channel in lockstep. The flags were added
 * after that list was written, so a clipped subset came out with its classes
 * intact and its flags gone, which makes a withheld point indistinguishable
 * from an ordinary one on the export path.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { clipCloud } from '../src/render/clip/clipCloud';
import { makeClipBox } from '../src/render/clip/clipBox';

const WITHHELD = 4;

/** Four points along x at 0, 1, 2, 3. */
function cloud(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
    classification: new Uint8Array([2, 2, 6, 2]),
    classificationFlags: new Uint8Array([0, WITHHELD, 0, WITHHELD]),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'test',
  });
}

/** An enabled clip keeping x in [lo, hi]. */
const keepX = (lo: number, hi: number) => ({
  ...makeClipBox({ min: [lo, -1, -1], max: [hi, 1, 1] }),
  enabled: true,
});

describe('clipping a cloud', () => {
  it('keeps the flags of the points it kept', () => {
    const out = clipCloud(cloud(), keepX(-0.5, 1.5));
    expect([...(out.classification ?? [])]).toEqual([2, 2]);
    expect([...(out.classificationFlags ?? [])]).toEqual([0, WITHHELD]);
  });

  it('keeps flags aligned with their own points', () => {
    const out = clipCloud(cloud(), keepX(2.5, 3.5));
    expect([...(out.classification ?? [])]).toEqual([2]);
    expect([...(out.classificationFlags ?? [])]).toEqual([WITHHELD]);
  });

  it('carries no flags when the source had none', () => {
    const bare = new PointCloud({
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      classification: new Uint8Array([2, 2]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'bare',
    });
    const out = clipCloud(bare, keepX(-0.5, 0.5));
    expect(out.classificationFlags).toBeUndefined();
  });
});
