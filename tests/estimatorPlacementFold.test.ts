/**
 * estimatorPlacementFold.test.ts
 *
 * The combined estimators (terrain gather, profile, cut/fill volume, lasso)
 * concatenate each layer's source-local buffer into one array before running a
 * pure sampler. This pins the float64-transform.md step-6 prerequisite: each
 * assembly now folds the layer's Float64 placement (`sourceToProject`) into the
 * points as it copies them, so a mounted layer contributes project-frame points
 * instead of source-frame ones.
 *
 * Two properties per site:
 *   (a) identity / null placement is byte-identical to the pre-fold path — the
 *       provable no-op that holds while mounting is disabled;
 *   (b) a synthetic non-identity placement shifts every accumulated point by
 *       exactly the offset, on all three axes.
 */

import { describe, it, expect } from 'vitest';
import {
  sampleStridedTerrain,
  type TerrainStreamBuffer,
} from '../src/render/terrainStreamSample';
import {
  assembleProfileBuffers,
  type ProfileSourceBuffer,
} from '../src/render/measure/profileSampler';
import {
  assembleVolumePositions,
  type PlacedVolumeBuffer,
} from '../src/render/measure/volume';
import {
  computeLassoVolume,
  stridePlacedPositions,
  stridePositions,
  type LassoVolumeHost,
} from '../src/render/measure/lassoVolumeCompute';
import type { LayerSpatialTransform } from '../src/geo/ProjectSpatialFrame';
import { PointCloud } from '../src/model/PointCloud';

/** A pure-translation placement — the only shape a v0.6 layer carries. */
function placed(dx: number, dy: number, dz: number): LayerSpatialTransform {
  return {
    sourceOrigin: [0, 0, 0],
    sourceToProject: [dx, dy, dz],
    projectToSource: [-dx, -dy, -dz],
  };
}

/** N interleaved xyz points with distinct, exactly-representable coordinates. */
function points(coords: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(coords.length * 3);
  coords.forEach(([x, y, z], i) => {
    out[i * 3] = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
  });
  return out;
}

describe('terrain gather placement fold (sampleStridedTerrain)', () => {
  const src = points([
    [1, 2, 3],
    [4, 5, 6],
    [7, 8, 9],
  ]);

  it('null placement is byte-identical to the pre-fold concatenation', () => {
    const s = sampleStridedTerrain(
      [{ pos: src, placement: null }],
      [],
      3,
      3, // stride 1 — every point kept
      false,
    )!;
    // Pre-fold behaviour copied points verbatim.
    expect(Array.from(s.positions)).toEqual(Array.from(src));
    expect(s.sampled).toBe(false);
  });

  it('a non-identity placement shifts every kept point by exactly the offset', () => {
    const off = placed(10, 20, 30);
    const s = sampleStridedTerrain([{ pos: src, placement: off }], [], 3, 3, false)!;
    expect(Array.from(s.positions)).toEqual([11, 22, 33, 14, 25, 36, 17, 28, 39]);
  });

  it('folds each buffer under its OWN placement in one gather', () => {
    const a = points([[0, 0, 0]]);
    const b = points([[0, 0, 0]]);
    const s = sampleStridedTerrain(
      [
        { pos: a, placement: placed(1, 0, 0) },
        { pos: b, placement: placed(0, 0, 5) },
      ],
      [],
      2,
      2,
      false,
    )!;
    expect(Array.from(s.positions)).toEqual([1, 0, 0, 0, 0, 5]);
  });
});

describe('profile placement fold (assembleProfileBuffers)', () => {
  const a = points([
    [1, 1, 1],
    [2, 2, 2],
  ]);
  const b = points([[3, 3, 3]]);

  it('null placement concatenates byte-identically and carries the class channel', () => {
    const buffers: ProfileSourceBuffer[] = [
      { pos: a, cls: [2, 6], placement: null },
      { pos: b, cls: [2] },
    ];
    const out = assembleProfileBuffers(buffers, a.length + b.length, true);
    expect(Array.from(out.positions)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
    expect(Array.from(out.classification!)).toEqual([2, 6, 2]);
  });

  it('leaves the 255 sentinel where a buffer supplies no class', () => {
    const buffers: ProfileSourceBuffer[] = [{ pos: a }, { pos: b, cls: [2] }];
    const out = assembleProfileBuffers(buffers, a.length + b.length, true);
    // First buffer has no cls → sentinel stands; second fills its slot.
    expect(Array.from(out.classification!)).toEqual([255, 255, 2]);
  });

  it('shifts a placed buffer while leaving an identity buffer untouched', () => {
    const buffers: ProfileSourceBuffer[] = [
      { pos: a, placement: placed(100, 200, 300) },
      { pos: b, placement: null },
    ];
    const out = assembleProfileBuffers(buffers, a.length + b.length, false);
    expect(Array.from(out.positions)).toEqual([101, 201, 301, 102, 202, 302, 3, 3, 3]);
    expect(out.classification).toBeUndefined();
  });
});

describe('volume placement fold (assembleVolumePositions)', () => {
  const a = points([
    [1, 1, 1],
    [2, 2, 2],
  ]);
  const b = points([[3, 3, 3]]);

  it('null placement is byte-identical to the pre-fold concatenation', () => {
    const out = assembleVolumePositions(
      [{ pos: a, placement: null }, { pos: b }],
      a.length + b.length,
    );
    expect(Array.from(out)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3]);
  });

  it('shifts each buffer by its own placement', () => {
    const buffers: PlacedVolumeBuffer[] = [
      { pos: a, placement: placed(-1, -2, -3) },
      { pos: b, placement: placed(0, 10, 0) },
    ];
    const out = assembleVolumePositions(buffers, a.length + b.length);
    expect(Array.from(out)).toEqual([0, -1, -2, 1, 0, -1, 3, 13, 3]);
  });
});

describe('lasso placement fold (stridePlacedPositions)', () => {
  const src = points([
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
  ]);

  it('identity + stride 1 returns the SAME array (no allocation, byte-identical)', () => {
    expect(stridePlacedPositions(src, 1, null)).toBe(src);
  });

  it('identity + stride > 1 equals stridePositions', () => {
    expect(Array.from(stridePlacedPositions(src, 2, null))).toEqual(
      Array.from(stridePositions(src, 2)),
    );
  });

  it('a non-identity placement shifts every kept point by the offset', () => {
    const out = stridePlacedPositions(src, 1, placed(10, 0, -5));
    expect(Array.from(out)).toEqual([10, 0, -5, 11, 1, -4, 12, 2, -3, 13, 3, -2]);
  });

  it('folds placement and stride together', () => {
    const out = stridePlacedPositions(src, 2, placed(0, 0, 100));
    // Keeps points 0 and 2, then adds the z offset.
    expect(Array.from(out)).toEqual([0, 0, 100, 2, 2, 102]);
  });
});

describe('lasso end-to-end fold (computeLassoVolume)', () => {
  const topDown = (x: number, y: number): { x: number; y: number } => ({ x, y });

  /** n×n grid on [0,size] with a raised central disc. */
  function grid(n: number, size: number, height: number): Float32Array {
    const p = new Float32Array(n * n * 3);
    let i = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const x = (c / (n - 1)) * size;
        const y = (r / (n - 1)) * size;
        const dx = x - size / 2;
        const dy = y - size / 2;
        p[i++] = x;
        p[i++] = y;
        p[i++] = Math.hypot(dx, dy) < size / 4 ? height : 0;
      }
    }
    return p;
  }

  function cloud(positions: Float32Array, name = 'a.las'): PointCloud {
    return new PointCloud({ positions, origin: [0, 0, 0], sourceFormat: 'las', name });
  }

  function host(over: Partial<LassoVolumeHost>): LassoVolumeHost {
    return { project: topDown, integrable: [], streamingPositions: [], wasReduced: () => false, ...over };
  }

  const box = (minX: number, minY: number, size: number) => [
    { x: minX - 1, y: minY - 1 },
    { x: minX + size + 1, y: minY - 1 },
    { x: minX + size + 1, y: minY + size + 1 },
    { x: minX - 1, y: minY + size + 1 },
  ];

  it('a placed layer with a matching-shifted lasso equals the unplaced result', () => {
    const g = grid(8, 10, 2);
    const base = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: cloud(g), placement: null }]] }),
      lasso: box(0, 0, 10),
      referencePercentile: 0.05,
    })!;

    // Same points, mounted by [100,100,50]; shift the lasso the same way in XY.
    // Translation leaves footprint area, cut/fill and net invariant (z shifts
    // uniformly, so every Δz against the shifted reference is unchanged).
    const moved = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: cloud(g), placement: placed(100, 100, 50) }]] }),
      lasso: box(100, 100, 10),
      referencePercentile: 0.05,
    })!;

    expect(moved.selectedCount).toBe(base.selectedCount);
    expect(moved.selectionByCloudId.get('a')).toEqual(base.selectionByCloudId.get('a'));
    expect(moved.result.footprintArea).toBeCloseTo(base.result.footprintArea, 9);
    expect(moved.result.fill).toBeCloseTo(base.result.fill, 9);
    expect(moved.result.cut).toBeCloseTo(base.result.cut, 9);
    expect(moved.result.net).toBeCloseTo(base.result.net, 9);
  });

  it('null placement equals an explicit zero-offset placement', () => {
    const g = grid(8, 10, 2);
    const nul = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: cloud(g), placement: null }]] }),
      lasso: box(0, 0, 10),
      referencePercentile: 0.05,
    })!;
    const zero = computeLassoVolume({
      host: host({ integrable: [['a', { cloud: cloud(g), placement: placed(0, 0, 0) }]] }),
      lasso: box(0, 0, 10),
      referencePercentile: 0.05,
    })!;
    expect(Array.from(zero.selectedPositions)).toEqual(Array.from(nul.selectedPositions));
    expect(zero.result.net).toBe(nul.result.net);
  });
});
