/**
 * tiles3dTraversal.test.ts — the first test that runs the four 3D Tiles
 * primitives together.
 *
 * Each was verified in isolation. What only a composed test can show is that
 * their assumptions agree: that the walk's transformed volumes are what the
 * bounds functions expect, that the bounds produce a distance the error measure
 * can use, and that refinement selects the tiles a viewer would actually draw.
 *
 * The refinement cases are the ones worth the most care. REPLACE and ADD differ
 * only in whether the parent survives its own refinement, and an implementation
 * that treats ADD as REPLACE silently drops geometry while still producing a
 * plausible scene.
 *
 * Expected values are hand-worked from the construction.
 */

import { describe, it, expect } from 'vitest';
import {
  selectTiles,
  volumeToAabb,
  distanceToAabb,
  walkImplicitSubtree,
  placedTileCentre,
  type ViewCamera,
} from '../src/io/tiles3d/tilesetTraversal';
import type { Tile, Tileset } from '../src/io/tiles3d/tileset';

/** A unit-ish box tile; only the fields the traversal reads are set. */
const tile = (over: Partial<Tile> = {}): Tile => ({
  boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
  geometricError: 100,
  refine: 'REPLACE',
  transform: null,
  contentUris: [],
  children: [],
  ...over,
});

const tilesetOf = (root: Tile): Tileset => ({
  assetVersion: '1.1',
  geometricError: root.geometricError,
  root,
});

/** Far enough that a 100 m error is small on screen. */
const farCamera: ViewCamera = {
  kind: 'perspective',
  positionEcef: [100_000, 0, 0],
  viewportHeightPx: 1000,
  verticalFov: Math.PI / 3,
};

/** Close enough that the same error is large. */
const nearCamera: ViewCamera = {
  kind: 'perspective',
  positionEcef: [30, 0, 0],
  viewportHeightPx: 1000,
  verticalFov: Math.PI / 3,
};

describe('distance is measured to the volume, not to its centre', () => {
  it('is zero when the camera is inside the box', () => {
    const aabb = volumeToAabb({ box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] })!;
    expect(distanceToAabb(aabb, [0, 0, 0])).toBe(0);
    expect(distanceToAabb(aabb, [5, 5, 5])).toBe(0);
  });

  it('is the gap to the nearest face, not to the centre', () => {
    // The box spans -10..10 on each axis, so a camera at x=30 is 20 m from the
    // face and 30 m from the centre. Using the centre would under-report the
    // error of a tile the camera is nearly touching.
    const aabb = volumeToAabb({ box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] })!;
    expect(distanceToAabb(aabb, [30, 0, 0])).toBeCloseTo(20, 9);
  });

  it('combines all three axes on a corner approach', () => {
    // 3-4-5 in two axes, from the corner at (10, 10, 10).
    const aabb = volumeToAabb({ box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] })!;
    expect(distanceToAabb(aabb, [13, 14, 10])).toBeCloseTo(5, 9);
  });
});

describe('volume conversion covers all three kinds', () => {
  it('converts a box, a sphere and a region, and refuses an empty volume', () => {
    expect(volumeToAabb({ box: [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3] })!.max).toEqual([1, 2, 3]);
    expect(volumeToAabb({ sphere: [0, 0, 0, 5] })!.max).toEqual([5, 5, 5]);
    // A region is EPSG:4979, so its AABB is an ECEF box near the Earth radius.
    const r = volumeToAabb({ region: [-0.01, -0.01, 0.01, 0.01, 0, 100] })!;
    expect(r.max[0]).toBeGreaterThan(6_300_000);
    expect(volumeToAabb({})).toBeNull();
  });
});

describe('refinement', () => {
  it('returns only the root when the error is already small enough', () => {
    const root = tile({ children: [tile({ geometricError: 50 })] });
    const out = selectTiles(tilesetOf(root), farCamera, { maxScreenSpaceErrorPx: 16 });
    expect(out).toHaveLength(1);
    expect(out[0]!.placed.depth).toBe(0);
  });

  it('descends when the error is large, and REPLACE drops the parent', () => {
    const child = tile({ geometricError: 1 });
    const root = tile({ refine: 'REPLACE', children: [child] });
    const out = selectTiles(tilesetOf(root), nearCamera, { maxScreenSpaceErrorPx: 16 });
    // Only the child renders: a replaced parent is not drawn beside its children.
    expect(out).toHaveLength(1);
    expect(out[0]!.placed.depth).toBe(1);
  });

  it('descends when the error is large, and ADD keeps the parent', () => {
    // The case that separates the two modes. Treating ADD as REPLACE here would
    // return one tile and still look like a working traversal.
    const child = tile({ geometricError: 1 });
    const root = tile({ refine: 'ADD', children: [child] });
    const out = selectTiles(tilesetOf(root), nearCamera, { maxScreenSpaceErrorPx: 16 });
    expect(out).toHaveLength(2);
    expect(out.map((t) => t.placed.depth).sort()).toEqual([0, 1]);
  });

  it('renders a leaf however large its error, because nothing stands in for it', () => {
    const root = tile({ geometricError: 1e9, children: [] });
    const out = selectTiles(tilesetOf(root), nearCamera, { maxScreenSpaceErrorPx: 16 });
    expect(out).toHaveLength(1);
    expect(out[0]!.screenSpaceError).toBeGreaterThan(16);
  });

  it('stops at maxDepth rather than descending a pathological tileset', () => {
    let node = tile({ geometricError: 1 });
    for (let i = 0; i < 20; i++) node = tile({ geometricError: 1000, children: [node] });
    const out = selectTiles(tilesetOf(node), nearCamera, { maxScreenSpaceErrorPx: 1, maxDepth: 3 });
    expect(Math.max(...out.map((t) => t.placed.depth))).toBeLessThanOrEqual(3);
  });

  it('carries the tile transform into the selected bounds', () => {
    // The root translates 1000 east, so its AABB must sit around x = 1000.
    const root = tile({ transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1] });
    const out = selectTiles(tilesetOf(root), farCamera, { maxScreenSpaceErrorPx: 16 });
    expect(out[0]!.aabb.min[0]).toBeCloseTo(990, 6);
    expect(out[0]!.aabb.max[0]).toBeCloseTo(1010, 6);
  });

  it('an orthographic camera refines on zoom rather than on distance', () => {
    // Under REPLACE the count does not grow when a tile refines, because the
    // parent is swapped for its children rather than joined by them. Depth is
    // what moves, and asserting the count here would pass for the wrong reason.
    const root = tile({ children: [tile({ geometricError: 1 })] });
    const wide: ViewCamera = { kind: 'orthographic', positionEcef: [1e6, 0, 0], viewportHeightPx: 1000, orthographicWorldHeight: 100_000 };
    const zoomed: ViewCamera = { ...wide, orthographicWorldHeight: 100 };

    // Wide: 100 * 1000 / 100000 = 1 px, under the threshold, so the root stands.
    const outWide = selectTiles(tilesetOf(root), wide, { maxScreenSpaceErrorPx: 16 });
    expect(outWide.map((t) => t.placed.depth)).toEqual([0]);

    // Zoomed: 100 * 1000 / 100 = 1000 px, so it refines to the child.
    const outZoom = selectTiles(tilesetOf(root), zoomed, { maxScreenSpaceErrorPx: 16 });
    expect(outZoom.map((t) => t.placed.depth)).toEqual([1]);

    // Moving the camera without zooming changes nothing, which is the property
    // that separates the orthographic path from the perspective one.
    const moved: ViewCamera = { ...wide, positionEcef: [50, 0, 0] };
    expect(selectTiles(tilesetOf(root), moved, { maxScreenSpaceErrorPx: 16 }).map((t) => t.placed.depth)).toEqual([0]);
  });
});

describe('implicit subtree walking', () => {
  const rootVolume = { box: [0, 0, 0, 16, 0, 0, 0, 16, 0, 0, 0, 16] };

  it('yields only available tiles and materialises nothing else', () => {
    // Constant 1: every tile in the subtree is available.
    const all = [...walkImplicitSubtree({
      scheme: 'QUADTREE',
      rootCoordinate: { level: 0, x: 0, y: 0 },
      rootBoundingVolume: rootVolume,
      rootGeometricError: 100,
      subtreeLevels: 3,
      tileAvailability: { constant: 1 },
    })];
    // Levels 0, 1 and 2 of a quadtree: 1 + 4 + 16.
    expect(all).toHaveLength(21);
  });

  it('yields nothing when the subtree declares nothing available', () => {
    const none = [...walkImplicitSubtree({
      scheme: 'QUADTREE',
      rootCoordinate: { level: 0, x: 0, y: 0 },
      rootBoundingVolume: rootVolume,
      rootGeometricError: 100,
      subtreeLevels: 3,
      tileAvailability: { constant: 0 },
    })];
    expect(none).toHaveLength(0);
  });

  it('halves the geometric error per level', () => {
    const tiles = [...walkImplicitSubtree({
      scheme: 'QUADTREE',
      rootCoordinate: { level: 0, x: 0, y: 0 },
      rootBoundingVolume: rootVolume,
      rootGeometricError: 100,
      subtreeLevels: 2,
      tileAvailability: { constant: 1 },
    })];
    expect(tiles.find((t) => t.coordinate.level === 0)!.geometricError).toBeCloseTo(100, 9);
    for (const t of tiles.filter((x) => x.coordinate.level === 1)) {
      expect(t.geometricError).toBeCloseTo(50, 9);
    }
  });

  it('gives every materialised tile a distinct id', () => {
    const ids = [...walkImplicitSubtree({
      scheme: 'OCTREE',
      rootCoordinate: { level: 0, x: 0, y: 0, z: 0 },
      rootBoundingVolume: rootVolume,
      rootGeometricError: 64,
      subtreeLevels: 3,
      tileAvailability: { constant: 1 },
    })].map((t) => t.id);
    // Octree levels 0, 1, 2: 1 + 8 + 64.
    expect(ids).toHaveLength(73);
    expect(new Set(ids).size).toBe(73);
  });

  it('subdivides the bounds, so a child is smaller than its parent', () => {
    const tiles = [...walkImplicitSubtree({
      scheme: 'QUADTREE',
      rootCoordinate: { level: 0, x: 0, y: 0 },
      rootBoundingVolume: rootVolume,
      rootGeometricError: 100,
      subtreeLevels: 2,
      tileAvailability: { constant: 1 },
    })];
    const root = tiles.find((t) => t.coordinate.level === 0)!;
    const child = tiles.find((t) => t.coordinate.level === 1)!;
    expect(child.boundingVolume.box![3]).toBeCloseTo(root.boundingVolume.box![3]! / 2, 9);
    // QUADTREE leaves the vertical half-axis alone.
    expect(child.boundingVolume.box![11]).toBeCloseTo(root.boundingVolume.box![11]!, 9);
  });
});

describe('placed tile centre', () => {
  it('is the midpoint of the bounds, and null when there are none', () => {
    const root = tile({ boundingVolume: { box: [5, 6, 7, 1, 0, 0, 0, 1, 0, 0, 0, 1] } });
    const out = selectTiles(tilesetOf(root), farCamera, { maxScreenSpaceErrorPx: 16 });
    expect(placedTileCentre(out[0]!.placed)).toEqual([5, 6, 7]);
  });
});
