/**
 * tiles3dVersionSemantics.test.ts — 3D Tiles 1.0 vs 1.1 geometric-error scaling.
 *
 * Per the OGC 3D Tiles specification the tile transform does NOT apply to
 * `geometricError` in 1.0, while 1.1 scales it by the transform's largest
 * scaling factor. `walkTilePlacements` takes the asset version and must honour
 * that difference; an absent version defaults to the conservative 1.1 rule.
 */

import { describe, it, expect } from 'vitest';
import {
  scalesGeometricError,
  walkTilePlacements,
} from '../src/io/tiles3d/tileTransform';
import type { Tile } from '../src/io/tiles3d/tileset';

/** Column-major uniform scale. */
const S = (s: number): number[] => [
  s, 0, 0, 0,
  0, s, 0, 0,
  0, 0, s, 0,
  0, 0, 0, 1,
];

const tile = (over: Partial<Tile> = {}): Tile => ({
  boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
  geometricError: 10,
  refine: 'ADD',
  transform: null,
  contentUris: [],
  children: [],
  ...over,
});

/** The root's geometric error as the walk reports it under a given version. */
const rootError = (transform: number[] | null, version?: string): number =>
  [...walkTilePlacements(tile({ transform }), undefined, version)][0]!.geometricError;

describe('scalesGeometricError', () => {
  it('opts out only for an explicit 1.0', () => {
    expect(scalesGeometricError('1.0')).toBe(false);
  });
  it('scales for 1.1', () => {
    expect(scalesGeometricError('1.1')).toBe(true);
  });
  it('defaults to scaling for an absent or unknown version', () => {
    expect(scalesGeometricError(undefined)).toBe(true);
    expect(scalesGeometricError('2.0')).toBe(true);
  });
});

describe('geometric error under the tile transform, by asset version', () => {
  it('1.0 with a 2x scale leaves geometric error unscaled: 10 -> 10', () => {
    expect(rootError(S(2), '1.0')).toBe(10);
  });

  it('1.1 with a 2x scale scales geometric error: 10 -> 20', () => {
    expect(rootError(S(2), '1.1')).toBe(20);
  });

  it('is identity for 1.0 with no transform: 10 -> 10', () => {
    expect(rootError(null, '1.0')).toBe(10);
  });

  it('is identity for 1.1 with no transform: 10 -> 10', () => {
    expect(rootError(null, '1.1')).toBe(10);
  });

  it('carries the version to every tile in the walk', () => {
    const leaf = tile({ geometricError: 4, transform: S(2) });
    const root = tile({ geometricError: 10, transform: S(3), children: [leaf] });

    const oneOh = [...walkTilePlacements(root, undefined, '1.0')].map((p) => p.geometricError);
    expect(oneOh).toEqual([10, 4]); // never scaled

    const oneOne = [...walkTilePlacements(root, undefined, '1.1')].map((p) => p.geometricError);
    expect(oneOne[0]).toBeCloseTo(30, 9); // 10 * 3
    expect(oneOne[1]).toBeCloseTo(24, 9); // 4 * 3 * 2
  });
});
