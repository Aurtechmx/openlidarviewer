import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DEPTH_EPSILON } from '../src/render/continuity/depthMerge';
import {
  runHistoryMergePass,
  type MergeRaster,
} from '../src/render/continuity/historyMergePass';
import type { SupportKind } from '../src/render/continuity/microGap';
import { packSupport, unpackSampleCount, unpackSupportKind } from '../src/render/continuity/supportProvenance';

/** A one-pixel raster, which is all most of these rules need. */
function pixel(kind: SupportKind, depth: number, samples = kind === 'none' ? 0 : 1): MergeRaster {
  return {
    widthPx: 1,
    heightPx: 1,
    depth: new Float32Array([depth]),
    support: new Uint8Array([packSupport(kind, samples)]),
  };
}

const SAME_EPOCH = { sampleEpoch: 4, historyEpoch: 4 };

function kindOf(r: MergeRaster): SupportKind {
  return unpackSupportKind(r.support[0]);
}

/** A depth far enough from `z` to be a different surface. */
function behind(z: number): number {
  return z * 2 ** (DEFAULT_DEPTH_EPSILON * 8);
}

describe('the four depth rules', () => {
  it('takes the sample when the pixel holds nothing', () => {
    const history = pixel('none', 0);
    const r = runHistoryMergePass(pixel('direct', 10), history, SAME_EPOCH);
    expect(r.decisions.accept).toBe(1);
    expect(history.depth[0]).toBeCloseTo(10, 6);
    expect(kindOf(history)).toBe('direct');
  });

  it('replaces what it holds when the sample is clearly in front', () => {
    const history = pixel('accumulated', behind(10), 3);
    const r = runHistoryMergePass(pixel('direct', 10), history, SAME_EPOCH);
    expect(r.decisions.replace).toBe(1);
    expect(history.depth[0]).toBeCloseTo(10, 6);
    // A replaced pixel is a sample rasterised this frame, so it counts one.
    expect(kindOf(history)).toBe('direct');
    expect(unpackSampleCount(history.support[0])).toBe(1);
  });

  it('adds to the surface it already holds when the depths agree', () => {
    const history = pixel('direct', 10, 1);
    const r = runHistoryMergePass(pixel('direct', 10.01), history, SAME_EPOCH);
    expect(r.decisions.blend).toBe(1);
    expect(kindOf(history)).toBe('accumulated');
    expect(unpackSampleCount(history.support[0])).toBe(2);
  });

  it('keeps the nearer depth when it blends', () => {
    // The two agree to within the tolerance, so the choice barely moves the
    // value; keeping the nearer one stops a merged pixel drifting behind the
    // surface it belongs to.
    const history = pixel('direct', 10, 1);
    runHistoryMergePass(pixel('direct', 10.05), history, SAME_EPOCH);
    expect(history.depth[0]).toBeCloseTo(10, 6);
  });

  it('drops a sample that is clearly behind', () => {
    const history = pixel('direct', 10, 2);
    const r = runHistoryMergePass(pixel('direct', behind(10)), history, SAME_EPOCH);
    expect(r.decisions.keep).toBe(1);
    expect(history.depth[0]).toBeCloseTo(10, 6);
    expect(unpackSampleCount(history.support[0])).toBe(2);
  });
});

describe('what may be merged', () => {
  it('never merges a reconstructed sample', () => {
    // A fill is not a sample, and merging one would be the laundering step the
    // provenance rules forbid.
    const history = pixel('none', 0);
    const r = runHistoryMergePass(pixel('reconstructed', 10), history, SAME_EPOCH);
    expect(r.skipped).toBe(1);
    expect(kindOf(history)).toBe('none');
  });

  it('skips a pixel the frame drew nothing into', () => {
    const history = pixel('direct', 10, 1);
    const r = runHistoryMergePass(pixel('none', 0), history, SAME_EPOCH);
    expect(r.skipped).toBe(1);
    expect(r.decisions.keep).toBe(0);
    expect(history.depth[0]).toBeCloseTo(10, 6);
  });

  it('lets a real sample take a pixel that was filled', () => {
    // The fill was standing in for exactly this, and a pixel holding one holds
    // no samples, so it weighs nothing against the first real one.
    const history = pixel('reconstructed', 10, 0);
    const r = runHistoryMergePass(pixel('direct', behind(10)), history, SAME_EPOCH);
    expect(r.decisions.accept).toBe(1);
    expect(kindOf(history)).toBe('direct');
  });
});

describe('the epoch', () => {
  it('refuses a frame drawn under another one', () => {
    // Merging across epochs would combine two pictures.
    const history = pixel('direct', 10, 1);
    const r = runHistoryMergePass(pixel('direct', 3), history, {
      sampleEpoch: 5,
      historyEpoch: 4,
    });
    expect(r.refused).toBe(true);
    expect(history.depth[0]).toBeCloseTo(10, 6);
    expect(unpackSampleCount(history.support[0])).toBe(1);
  });

  it('refuses rasters that do not describe the same frame', () => {
    const samples: MergeRaster = {
      widthPx: 2, heightPx: 2, depth: new Float32Array(4), support: new Uint8Array(4),
    };
    const history = pixel('none', 0);
    expect(runHistoryMergePass(samples, history, SAME_EPOCH).refused).toBe(true);
  });
});

describe('a sweep', () => {
  /** Four phases of the same surface, as a parked camera would produce. */
  it('builds the sample count one phase at a time', () => {
    const history = pixel('none', 0);
    const counts: number[] = [];
    for (let phase = 0; phase < 4; phase++) {
      runHistoryMergePass(pixel('direct', 10 + phase * 0.01), history, SAME_EPOCH);
      counts.push(unpackSampleCount(history.support[0]));
    }
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(kindOf(history)).toBe('accumulated');
  });

  it('does not ghost when the surface in front changes', () => {
    // The wall arrives in front of the floor the history holds: the floor is
    // replaced outright rather than blended, so nothing of it survives.
    const history = pixel('accumulated', behind(4), 6);
    runHistoryMergePass(pixel('direct', 4), history, SAME_EPOCH);
    expect(history.depth[0]).toBeCloseTo(4, 6);
    expect(unpackSampleCount(history.support[0])).toBe(1);
  });

  it('counts every pixel exactly once across a frame', () => {
    const w = 8;
    const h = 8;
    const samples: MergeRaster = {
      widthPx: w, heightPx: h, depth: new Float32Array(w * h), support: new Uint8Array(w * h),
    };
    const history: MergeRaster = {
      widthPx: w, heightPx: h, depth: new Float32Array(w * h), support: new Uint8Array(w * h),
    };
    for (let i = 0; i < w * h; i++) {
      const kind: SupportKind = i % 3 === 0 ? 'none' : 'direct';
      samples.support[i] = packSupport(kind, kind === 'none' ? 0 : 1);
      samples.depth[i] = kind === 'none' ? 0 : 5 + (i % 7);
      history.support[i] = packSupport(i % 5 === 0 ? 'direct' : 'none', i % 5 === 0 ? 1 : 0);
      history.depth[i] = i % 5 === 0 ? 5 : 0;
    }
    const r = runHistoryMergePass(samples, history, SAME_EPOCH);
    const total = r.skipped
      + r.decisions.accept + r.decisions.replace + r.decisions.blend + r.decisions.keep;
    expect(total).toBe(w * h);
  });
});

describe('what it cannot reach', () => {
  it('names no camera, matrix, motion vector or reprojection', () => {
    // Nothing is reprojected: the history is only merged into while the epoch
    // stands still, so every contribution was drawn through the same camera.
    const source = readFileSync(
      new URL('../src/render/continuity/historyMergePass.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/camera|matrix|reproject|motionVector|velocity/i);
    expect(code).toMatch(/export function runHistoryMergePass/);
  });
});
