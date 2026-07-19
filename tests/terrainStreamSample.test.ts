/**
 * tests/terrainStreamSample.test.ts
 *
 * The streaming terrain subsample must be reproducible: re-loading the same
 * COPC and running Analyse Terrain has to yield the same sampled points, so the
 * exported RMSEz / contour geometry is identical run-to-run. The nodes arrive
 * in decode-completion order (network/worker timing), so the sampler orders
 * them by a stable octree key before the stride walk. This pins that the
 * strided output is invariant to arrival order.
 */

import { describe, it, expect } from 'vitest';
import {
  sampleStridedTerrain,
  type KeyedTerrainStreamBuffer,
} from '../src/render/terrainStreamSample';

/** A node buffer whose xyz values encode its key so mis-ordering is visible. */
function node(key: string, base: number): KeyedTerrainStreamBuffer {
  const pos = new Float32Array(12); // 4 points
  for (let i = 0; i < 4; i++) {
    pos[i * 3] = base + i;
    pos[i * 3 + 1] = base + i;
    pos[i * 3 + 2] = base + i;
  }
  return { key, pos };
}

describe('sampleStridedTerrain', () => {
  it('is order-independent across streaming arrival order (stride > 1)', () => {
    const a = node('2-0-0-0', 100);
    const b = node('2-1-0-0', 200);
    const c = node('2-0-1-0', 300);
    const total = 12; // 3 nodes * 4 points
    const maxPoints = 3; // stride = ceil(12/3) = 4 > 1

    const arrival1 = sampleStridedTerrain([], [a, b, c], total, maxPoints, false);
    const arrival2 = sampleStridedTerrain([], [c, a, b], total, maxPoints, false);
    const arrival3 = sampleStridedTerrain([], [b, c, a], total, maxPoints, false);

    expect(arrival1).not.toBeNull();
    expect(arrival1!.sampled).toBe(true);
    expect(Array.from(arrival2!.positions)).toEqual(Array.from(arrival1!.positions));
    expect(Array.from(arrival3!.positions)).toEqual(Array.from(arrival1!.positions));
  });

  it('places static clouds before streaming nodes and keeps static order', () => {
    const s0: KeyedTerrainStreamBuffer = { key: '', pos: new Float32Array([1, 1, 1]) };
    const s1: KeyedTerrainStreamBuffer = { key: '', pos: new Float32Array([2, 2, 2]) };
    const stream = node('5-0-0-0', 900);
    const out = sampleStridedTerrain([s0, s1], [stream], 6, 300_000, false);
    expect(out).not.toBeNull();
    // stride 1: all points, static first in given order, then streaming.
    expect(Array.from(out!.positions).slice(0, 6)).toEqual([1, 1, 1, 2, 2, 2]);
    expect(out!.sampled).toBe(false);
  });

  it('returns null when nothing survives the finite filter', () => {
    const nan: KeyedTerrainStreamBuffer = {
      key: '1-0-0-0',
      pos: new Float32Array([NaN, NaN, NaN]),
    };
    expect(sampleStridedTerrain([], [nan], 1, 300_000, false)).toBeNull();
  });

  it('refuses a budget it cannot honour instead of allocating the full cloud', () => {
    const a = node('2-0-0-0', 100);
    // A negative budget makes ceil(total/max) negative, so the stride clamps to
    // 1 and the walk would keep EVERY point — the opposite of a cap. Refuse.
    expect(sampleStridedTerrain([], [a], 4, -5, false)).toBeNull();
    expect(sampleStridedTerrain([], [a], 4, 0, false)).toBeNull();
    expect(sampleStridedTerrain([], [a], 4, Number.NaN, false)).toBeNull();
    expect(sampleStridedTerrain([], [a], 4, Number.POSITIVE_INFINITY, false)).toBeNull();
  });

  it('refuses a non-finite or empty total', () => {
    const a = node('2-0-0-0', 100);
    expect(sampleStridedTerrain([], [a], Number.NaN, 10, false)).toBeNull();
    expect(sampleStridedTerrain([], [a], 0, 10, false)).toBeNull();
    expect(sampleStridedTerrain([], [a], -4, 10, false)).toBeNull();
  });

  it('leaves the 255 no-class sentinel where the class array runs short', () => {
    // A node whose class array is shorter than its point array: the missing
    // entries must stay 255 ("no class channel"), not narrow to 0, which is the
    // real ASPRS code for "never classified" and is filtered differently.
    const short: KeyedTerrainStreamBuffer = {
      key: '2-0-0-0',
      pos: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]), // 3 points
      cls: new Uint8Array([2]), // only 1 class value
    };
    const out = sampleStridedTerrain([], [short], 3, 300_000, true);
    expect(out).not.toBeNull();
    expect(Array.from(out!.classification!)).toEqual([2, 255, 255]);
  });

  it('de-duplicates a repeated node key instead of counting it twice', () => {
    // Two buffers under one octree key is a caller bug (a resident node has one
    // id). Sampling both would count that node's four points twice; the sampler
    // keeps one, so the count is a node's worth regardless of arrival order.
    // Which duplicate wins is left unspecified — a genuine collision means the
    // two are the same node, so the only guarantee that matters is "not twice".
    const a = node('2-0-0-0', 100);
    const dup = node('2-0-0-0', 900); // same key
    const forward = sampleStridedTerrain([], [a, dup], 8, 300_000, false);
    const reverse = sampleStridedTerrain([], [dup, a], 8, 300_000, false);
    expect(forward!.positions.length / 3).toBe(4);
    expect(reverse!.positions.length / 3).toBe(4);
  });

  it('keeps unique keys arrival-independent alongside the dedup', () => {
    // The real contract: distinct nodes, sampled identically whatever order they
    // arrive in. The dedup must not disturb this.
    const a = node('2-0-0-0', 100);
    const b = node('2-1-0-0', 200);
    const c = node('2-0-1-0', 300);
    const one = sampleStridedTerrain([], [a, b, c], 12, 300_000, false);
    const two = sampleStridedTerrain([], [c, a, b], 12, 300_000, false);
    expect(Array.from(one!.positions)).toEqual(Array.from(two!.positions));
  });
});
