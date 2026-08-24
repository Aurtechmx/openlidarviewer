/**
 * tiles3dTransform.test.ts — the tile transform, against closed forms.
 *
 * Every expected value here is computed by hand from the construction, not
 * read back from the implementation. That matters more than usual for matrix
 * code: a composition written in the wrong order still produces finite,
 * invertible, plausible-looking numbers, and a test that asserts "whatever it
 * returned" passes on both.
 *
 * The order case is the load-bearing one. `composeTileTransform(A, B)` must be
 * A·B, so a translate-then-scale differs from a scale-then-translate, and the
 * two are distinguished by an explicit hand-worked expectation rather than by
 * a round trip that would pass either way.
 *
 * Column-major throughout: `m[column * 4 + row]`, so the translation lives at
 * indices 12, 13 and 14.
 */

import { describe, it, expect } from 'vitest';
import {
  IDENTITY_4X4,
  composeTileTransform,
  cumulativeTransform,
  transformPoint,
  transformDirection,
  largestScale,
  transformGeometricError,
  transformBox,
  transformSphere,
  transformBoundingVolume,
  isIdentityTransform,
  walkTilePlacements,
} from '../src/io/tiles3d/tileTransform';
import type { Tile } from '../src/io/tiles3d/tileset';

/** Column-major translation. */
const T = (x: number, y: number, z: number): number[] => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
];

/** Column-major scale, per axis so non-uniform cases are expressible. */
const S = (x: number, y: number, z: number): number[] => [
  x, 0, 0, 0,
  0, y, 0, 0,
  0, 0, z, 0,
  0, 0, 0, 1,
];

/** Column-major rotation about Z, radians. */
const Rz = (a: number): number[] => [
  Math.cos(a), Math.sin(a), 0, 0,
  -Math.sin(a), Math.cos(a), 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
];

describe('composition order', () => {
  it('composes parent then child, so the child transform applies first', () => {
    // Scale by 2, then translate by 10 in x. A point at x=1 becomes 2, then 12.
    // Composing the other way would give (1 + 10) * 2 = 22.
    const m = composeTileTransform(T(10, 0, 0), S(2, 2, 2));
    expect(transformPoint(m, [1, 0, 0])).toEqual([12, 0, 0]);
  });

  it('is not commutative, which is the whole reason order is specified', () => {
    const a = composeTileTransform(T(10, 0, 0), S(2, 2, 2));
    const b = composeTileTransform(S(2, 2, 2), T(10, 0, 0));
    expect(transformPoint(a, [1, 0, 0])).toEqual([12, 0, 0]);
    expect(transformPoint(b, [1, 0, 0])).toEqual([22, 0, 0]);
    expect(a).not.toEqual(b);
  });

  it('leaves a matrix unchanged when composed with the identity, either side', () => {
    const m = composeTileTransform(T(3, -4, 5), Rz(Math.PI / 3));
    expect(composeTileTransform(IDENTITY_4X4, m)).toEqual(m);
    expect(composeTileTransform(m, IDENTITY_4X4)).toEqual(m);
  });

  it('is associative, so a path can be folded in any grouping', () => {
    const a = T(1, 2, 3);
    const b = Rz(0.4);
    const c = S(2, 3, 4);
    const left = composeTileTransform(composeTileTransform(a, b), c);
    const right = composeTileTransform(a, composeTileTransform(b, c));
    for (let i = 0; i < 16; i++) expect(left[i]).toBeCloseTo(right[i]!, 12);
  });
});

describe('cumulative transform down a path', () => {
  it('folds root to leaf in order', () => {
    // Root translates by 100, child scales by 2. A leaf-local x=1 lands at 102.
    const m = cumulativeTransform([T(100, 0, 0), S(2, 2, 2)]);
    expect(transformPoint(m, [1, 0, 0])).toEqual([102, 0, 0]);
  });

  it('treats a tile with no transform as the identity rather than skipping it', () => {
    const withGap = cumulativeTransform([T(100, 0, 0), null, S(2, 2, 2), undefined]);
    const without = cumulativeTransform([T(100, 0, 0), S(2, 2, 2)]);
    expect(withGap).toEqual(without);
  });

  it('returns the identity for an empty path', () => {
    expect(cumulativeTransform([])).toEqual([...IDENTITY_4X4]);
  });
});

describe('points and directions differ by the translation', () => {
  it('carries the translation on a point', () => {
    expect(transformPoint(T(5, 6, 7), [1, 1, 1])).toEqual([6, 7, 8]);
  });

  it('ignores the translation on a direction', () => {
    // A half-axis that picked up the translation would move the box twice.
    expect(transformDirection(T(5, 6, 7), [1, 1, 1])).toEqual([1, 1, 1]);
  });

  it('rotates a direction without translating it', () => {
    const m = composeTileTransform(T(100, 100, 0), Rz(Math.PI / 2));
    const [x, y, z] = transformDirection(m, [1, 0, 0]);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo(0, 12);
  });
});

describe('largest scaling factor', () => {
  it('is 1 for the identity', () => {
    expect(largestScale(IDENTITY_4X4)).toBe(1);
  });

  it('is the maximum axis under a non-uniform scale, not the mean', () => {
    // The specification's wording is the LARGEST factor. A mean would give 3.
    expect(largestScale(S(2, 3, 4))).toBe(4);
  });

  it('is 1 under a pure rotation, which changes no length', () => {
    expect(largestScale(Rz(0.7))).toBeCloseTo(1, 12);
  });

  it('ignores translation, which scales nothing', () => {
    expect(largestScale(T(1000, -2000, 3000))).toBe(1);
  });

  it('scales geometric error by that factor', () => {
    expect(transformGeometricError(S(2, 3, 4), 10)).toBe(40);
    expect(transformGeometricError(IDENTITY_4X4, 10)).toBe(10);
  });
});

describe('box volumes', () => {
  it('moves the centre and leaves the half-axes alone under translation', () => {
    const box = [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3];
    expect(transformBox(T(10, 20, 30), box)).toEqual([
      10, 20, 30,
      1, 0, 0,
      0, 2, 0,
      0, 0, 3,
    ]);
  });

  it('scales each half-axis independently under a non-uniform scale', () => {
    const box = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    expect(transformBox(S(2, 3, 4), box)).toEqual([
      0, 0, 0,
      2, 0, 0,
      0, 3, 0,
      0, 0, 4,
    ]);
  });

  it('rotates the half-axes with the box', () => {
    const box = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const out = transformBox(Rz(Math.PI / 2), box);
    expect(out[3]).toBeCloseTo(0, 12);
    expect(out[4]).toBeCloseTo(1, 12);
    expect(out[6]).toBeCloseTo(-1, 12);
    expect(out[7]).toBeCloseTo(0, 12);
  });
});

describe('sphere volumes', () => {
  it('moves the centre and keeps the radius under translation', () => {
    expect(transformSphere(T(1, 2, 3), [0, 0, 0, 5])).toEqual([1, 2, 3, 5]);
  });

  it('grows the radius by the largest factor, so it still encloses the shape', () => {
    // Under a 2/3/4 scale the sphere becomes an ellipsoid; the enclosing sphere
    // takes the longest semi-axis. Taking anything smaller would cull geometry
    // that is really inside.
    expect(transformSphere(S(2, 3, 4), [0, 0, 0, 1])).toEqual([0, 0, 0, 4]);
  });
});

describe('the region exemption', () => {
  it('leaves a region untouched, because it is already EPSG:4979', () => {
    const region = [-0.1, 0.5, 0.1, 0.6, 0, 100];
    const out = transformBoundingVolume(S(2, 3, 4), { region });
    expect(out.region).toEqual(region);
    expect(out.box).toBeUndefined();
    expect(out.sphere).toBeUndefined();
  });

  it('transforms a box and a sphere in the same volume while sparing the region', () => {
    const out = transformBoundingVolume(T(10, 0, 0), {
      box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
      sphere: [0, 0, 0, 2],
      region: [0, 0, 1, 1, 0, 10],
    });
    expect(out.box?.slice(0, 3)).toEqual([10, 0, 0]);
    expect(out.sphere).toEqual([10, 0, 0, 2]);
    expect(out.region).toEqual([0, 0, 1, 1, 0, 10]);
  });

  it('does not mutate the volume it was given', () => {
    const volume = { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] };
    const before = [...volume.box];
    transformBoundingVolume(S(9, 9, 9), volume);
    expect(volume.box).toEqual(before);
  });
});

describe('identity detection', () => {
  it('recognises the identity and rejects a translation', () => {
    expect(isIdentityTransform(IDENTITY_4X4)).toBe(true);
    expect(isIdentityTransform(T(0, 0, 1e-9))).toBe(false);
  });

  it('accepts a near-identity only when an epsilon allows it', () => {
    expect(isIdentityTransform(T(0, 0, 1e-9), 1e-6)).toBe(true);
  });
});

describe('a worked tileset path, end to end', () => {
  it('places a leaf point and scales its error through three levels', () => {
    // Root translates 1000 east. Middle rotates a quarter turn about Z.
    // Leaf scales by 2. A leaf-local point at (1, 0, 0):
    //   scale  -> (2, 0, 0)
    //   rotate -> (0, 2, 0)
    //   move   -> (1000, 2, 0)
    const m = cumulativeTransform([T(1000, 0, 0), Rz(Math.PI / 2), S(2, 2, 2)]);
    const [x, y, z] = transformPoint(m, [1, 0, 0]);
    expect(x).toBeCloseTo(1000, 9);
    expect(y).toBeCloseTo(2, 9);
    expect(z).toBeCloseTo(0, 9);

    // Rotation and translation scale nothing, so the error doubles once.
    expect(transformGeometricError(m, 16)).toBeCloseTo(32, 9);
  });
});

describe('walking a tileset top-down', () => {
  /** A minimal tile; only the fields the walk reads are set. */
  const tile = (over: Partial<Tile> = {}): Tile => ({
    boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
    geometricError: 16,
    refine: 'REPLACE',
    transform: null,
    contentUri: null,
    children: [],
    ...over,
  });

  it('accumulates the transform as it descends, so a leaf sees the whole chain', () => {
    const leaf = tile({ transform: S(2, 2, 2) });
    const mid = tile({ transform: Rz(Math.PI / 2), children: [leaf] });
    const root = tile({ transform: T(1000, 0, 0), children: [mid] });

    const placed = [...walkTilePlacements(root)];
    expect(placed).toHaveLength(3);
    expect(placed.map((p) => p.depth)).toEqual([0, 1, 2]);

    // Same chain as the worked example above: scale, rotate, translate.
    const [x, y] = transformPoint(placed[2]!.transform, [1, 0, 0]);
    expect(x).toBeCloseTo(1000, 9);
    expect(y).toBeCloseTo(2, 9);
  });

  it('scales each tile geometric error by its own cumulative transform', () => {
    const leaf = tile({ geometricError: 4, transform: S(2, 2, 2) });
    const root = tile({ geometricError: 16, transform: S(3, 3, 3), children: [leaf] });
    const placed = [...walkTilePlacements(root)];
    expect(placed[0]!.geometricError).toBeCloseTo(48, 9); // 16 * 3
    expect(placed[1]!.geometricError).toBeCloseTo(24, 9); // 4 * 3 * 2
  });

  it('yields children in authored order', () => {
    const a = tile({ geometricError: 1 });
    const b = tile({ geometricError: 2 });
    const c = tile({ geometricError: 3 });
    const root = tile({ geometricError: 9, children: [a, b, c] });
    const errors = [...walkTilePlacements(root)].slice(1).map((p) => p.geometricError);
    expect(errors).toEqual([1, 2, 3]);
  });

  it('spares a region while transforming a box on a sibling', () => {
    const regional = tile({ boundingVolume: { region: [0, 0, 1, 1, 0, 10] } });
    const boxed = tile({ boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] } });
    const root = tile({ transform: T(50, 0, 0), children: [regional, boxed] });
    const placed = [...walkTilePlacements(root)];
    expect(placed[1]!.boundingVolume.region).toEqual([0, 0, 1, 1, 0, 10]);
    expect(placed[2]!.boundingVolume.box?.slice(0, 3)).toEqual([50, 0, 0]);
  });

  it('passes a tile without a transform straight through', () => {
    const leaf = tile();
    const root = tile({ transform: T(7, 0, 0), children: [leaf] });
    const placed = [...walkTilePlacements(root)];
    expect(placed[1]!.transform).toEqual(placed[0]!.transform);
  });
});
