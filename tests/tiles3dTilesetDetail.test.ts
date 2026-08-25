/**
 * tiles3dTilesetDetail.test.ts — choosing the detail level a one-shot read
 * opens a tileset at.
 *
 * Pure throughout: parsed documents, a camera and a tile ceiling. No transport
 * and no `.pnts` bodies, because the choice is made before anything is fetched.
 *
 * The fixtures sit AWAY FROM THE ORIGIN on purpose. The camera a full read
 * selects against is at the origin, and a tile whose bounding volume contains
 * the camera has a screen-space error of `Infinity`, which refines at every
 * finite threshold. A fixture straddling the origin would therefore have no
 * usable ladder at all, and would test the refusal path while looking like it
 * tested the fallback.
 */

import { describe, expect, test } from 'vitest';
import { parseTileset, type Tileset } from '../src/io/tiles3d/tileset';
import {
  FULL_DETAIL_SSE_PX,
  describeTilesetDetail,
  resolveTilesetDetail,
} from '../src/io/tiles3d/tilesetDetail';
import { selectTiles, type ViewCamera } from '../src/io/tiles3d/tilesetTraversal';

/** The camera `tilesetCloud.ts` selects a full read against. */
const CAMERA: ViewCamera = {
  kind: 'perspective',
  positionEcef: [0, 0, 0],
  viewportHeightPx: 1000,
  verticalFov: Math.PI / 3,
};

/** A box a million metres out, so every tile's error is finite. */
function boxAt(x: number, half = 1000): number[] {
  return [x, 0, 0, half, 0, 0, 0, half, 0, 0, 0, half];
}

/** A REPLACE root over `leaves` children, each a leaf of its own. */
function fanOut(leaves: number, rootError = 100): Tileset {
  return parseTileset({
    asset: { version: '1.1' },
    geometricError: rootError,
    root: {
      boundingVolume: { box: boxAt(1_000_000) },
      geometricError: rootError,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
      children: Array.from({ length: leaves }, (_, i) => ({
        boundingVolume: { box: boxAt(1_000_000) },
        geometricError: 0,
        content: { uri: `${i}.pnts` },
      })),
    },
  });
}

/** How many tiles one threshold selects, measured the way the loader will. */
function tilesAt(tileset: Tileset, thresholdPx: number, maxDepth?: number): number {
  return selectTiles(tileset, CAMERA, {
    maxScreenSpaceErrorPx: thresholdPx,
    ...(maxDepth !== undefined && { maxDepth }),
  }).length;
}

describe('resolveTilesetDetail — a tileset that already fits', () => {
  test('keeps full detail, and says it is the finest level', () => {
    const tileset = fanOut(4);
    const choice = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 16 });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.detail.maxScreenSpaceErrorPx).toBe(FULL_DETAIL_SSE_PX);
    expect(choice.detail.atFinestDetail).toBe(true);
    expect(choice.detail.selectedTiles).toBe(4);
    expect(choice.detail.finestTiles).toBe(4);
    // The threshold handed on has to select exactly what full detail selects,
    // or "unchanged for a tileset that fits" is not what happened.
    expect(tilesAt(tileset, choice.detail.maxScreenSpaceErrorPx)).toBe(
      tilesAt(tileset, FULL_DETAIL_SSE_PX),
    );
  });
});

describe('resolveTilesetDetail — a tileset that does not fit', () => {
  test('falls back to the finest level that fits, and says it is coarser', () => {
    const tileset = fanOut(64);
    const choice = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 8 });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.detail.atFinestDetail).toBe(false);
    expect(choice.detail.finestTiles).toBe(64);
    expect(choice.detail.selectedTiles).toBeLessThanOrEqual(8);
    expect(tilesAt(tileset, choice.detail.maxScreenSpaceErrorPx)).toBe(
      choice.detail.selectedTiles,
    );
  });

  test('the level chosen is the FINEST fitting one, not merely a fitting one', () => {
    // Three levels with distinct errors, so there is a middle rung to miss:
    // dropping straight to the coarsest would still fit the ceiling and would
    // still report "coarser", and only this comparison catches it.
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 400,
      root: {
        boundingVolume: { box: boxAt(1_000_000) },
        geometricError: 400,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: Array.from({ length: 3 }, (_, i) => ({
          boundingVolume: { box: boxAt(1_000_000) },
          geometricError: 40,
          refine: 'REPLACE',
          content: { uri: `mid${i}.pnts` },
          children: Array.from({ length: 5 }, (_, j) => ({
            boundingVolume: { box: boxAt(1_000_000) },
            geometricError: 0,
            content: { uri: `leaf${i}-${j}.pnts` },
          })),
        })),
      },
    });
    const cap = 4;
    const choice = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: cap });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    // The middle level is three tiles, which fits; the leaves are fifteen,
    // which does not.
    expect(choice.detail.selectedTiles).toBe(3);
    expect(choice.detail.finestTiles).toBe(15);
    expect(choice.detail.atFinestDetail).toBe(false);
    // Nothing finer than the chosen threshold fits. Every distinct error in the
    // tree is a candidate, so this is the whole search space, checked directly.
    const finer = [400, 40, 4, 0.5]
      .map((error) => (error * 1000) / (2 * (1_000_000 - 1000) * Math.tan(Math.PI / 6)))
      .filter((t) => t < choice.detail.maxScreenSpaceErrorPx);
    for (const threshold of finer) {
      expect(tilesAt(tileset, threshold)).toBeGreaterThan(cap);
    }
  });
});

describe('resolveTilesetDetail — nothing fits', () => {
  test('refuses, naming the coarsest selection and the ceiling', () => {
    // A root volume containing the camera: every tile's screen-space error is
    // unbounded, so no finite threshold stops a single refinement and the
    // coarsest level IS the finest one.
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        boundingVolume: { box: boxAt(0) },
        geometricError: 100,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: Array.from({ length: 9 }, (_, i) => ({
          boundingVolume: { box: boxAt(0) },
          geometricError: 0,
          content: { uri: `${i}.pnts` },
        })),
      },
    });
    const choice = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 4 });
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.reason).toContain('9 tiles even at its coarsest level');
    expect(choice.reason).toContain('4-tile ceiling');
  });
});

describe('resolveTilesetDetail — termination', () => {
  test('a deep chain resolves rather than running forever', () => {
    // 300 levels of one child each, past the traversal's own 32-level cap, and
    // every level a different error so no two rungs of the ladder coincide.
    let node: Record<string, unknown> = {
      boundingVolume: { box: boxAt(1_000_000) },
      geometricError: 0,
      content: { uri: 'leaf.pnts' },
    };
    for (let i = 1; i <= 300; i++) {
      node = {
        boundingVolume: { box: boxAt(1_000_000) },
        geometricError: i,
        refine: 'REPLACE',
        content: { uri: `n${i}.pnts` },
        children: [node],
      };
    }
    // The parser's own depth ceiling is 24, well below this chain, so it is
    // raised for the fixture: the point is a tree deeper than the TRAVERSAL's
    // 32-level cap, which is what the ladder has to agree with.
    const tileset = parseTileset(
      { asset: { version: '1.1' }, geometricError: 300, root: node },
      { maxDepth: 400 },
    );
    const choice = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 1 });
    // A chain selects one tile at every level, so it fits at full detail; the
    // point of the fixture is the ladder's 300 rungs and the depth cap.
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.detail.atFinestDetail).toBe(true);
  }, 5000);

  test('the search costs a logarithm of the ladder, not a walk of it', () => {
    // 300 children with 300 distinct errors, each over one leaf, so the ladder
    // has a rung per child and only the coarsest rung fits. Counting the
    // traversals bounds the search directly: a walk from the finest rung
    // upwards reaches the same answer and would cost about 300.
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 1000,
      root: {
        boundingVolume: { box: boxAt(1_000_000) },
        geometricError: 1000,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: Array.from({ length: 300 }, (_, i) => ({
          boundingVolume: { box: boxAt(1_000_000) },
          geometricError: i + 1,
          refine: 'REPLACE',
          content: { uri: `mid${i}.pnts` },
          children: [
            {
              boundingVolume: { box: boxAt(1_000_000) },
              geometricError: 0,
              content: { uri: `leaf${i}.pnts` },
            },
          ],
        })),
      },
    });
    // A counting accessor on `root` counts how often the tree is entered,
    // without standing in for any of the code under test. `selectTiles` reads
    // it twice per traversal, once to place the tiles and once to start the
    // visit, so the count is twice the number of selections plus the ladder's
    // own single read.
    const root = tileset.root;
    let traversals = 0;
    Object.defineProperty(tileset, 'root', {
      get: () => {
        traversals++;
        return root;
      },
    });
    const choice = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 50 });
    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.detail.selectedTiles).toBe(1);
    expect(choice.detail.finestTiles).toBe(300);
    // A full-detail count plus a bisection over 301 rungs is at most ten
    // selections, so at most 21 reads. A search that walked the ladder instead
    // of halving it would enter the tree some six hundred times.
    expect(traversals).toBeLessThanOrEqual(21);
  }, 5000);

  test('a degenerate tree of identical errors resolves deterministically', () => {
    // Every tile carries the same error, so the ladder collapses to one rung
    // behind full detail and a search that assumed distinct rungs would spin.
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 50,
      root: {
        boundingVolume: { box: boxAt(1_000_000) },
        geometricError: 50,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: Array.from({ length: 200 }, (_, i) => ({
          boundingVolume: { box: boxAt(1_000_000) },
          geometricError: 50,
          refine: 'REPLACE',
          content: { uri: `a${i}.pnts` },
          children: [
            {
              boundingVolume: { box: boxAt(1_000_000) },
              geometricError: 50,
              content: { uri: `b${i}.pnts` },
            },
          ],
        })),
      },
    });
    const first = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 10 });
    const second = resolveTilesetDetail(tileset, CAMERA, { maxSelectedTiles: 10 });
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.detail.selectedTiles).toBeLessThanOrEqual(10);
  }, 5000);
});

describe('describeTilesetDetail', () => {
  test('a coarser read states the level, the finest level and the ceiling', () => {
    const sentence = describeTilesetDetail({
      maxScreenSpaceErrorPx: 0.05,
      atFinestDetail: false,
      selectedTiles: 340,
      finestTiles: 9120,
      maxSelectedTiles: 4096,
    });
    expect(sentence).toBe(
      "Opened coarser than this tileset's finest detail: full detail names 9,120 tiles, " +
        'past the 4,096-tile ceiling for one read, so the finest level that fits was opened ' +
        'instead, at 340 tiles.',
    );
  });

  test('a finest read says so without hedging', () => {
    expect(
      describeTilesetDetail({
        maxScreenSpaceErrorPx: FULL_DETAIL_SSE_PX,
        atFinestDetail: true,
        selectedTiles: 12,
        finestTiles: 12,
        maxSelectedTiles: 4096,
      }),
    ).toBe("Opened at this tileset's finest detail, 12 tiles.");
  });
});
