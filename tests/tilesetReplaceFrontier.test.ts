/**
 * tilesetReplaceFrontier.test.ts — the REPLACE render frontier over a real
 * tileset source.
 *
 * `replaceFrontier.test.ts` pins the pure rule; this pins the wiring the
 * scheduler actually runs: a `TilesetStreamingSource` parses a REPLACE tileset,
 * builds the shared `StreamingNodeStore` with `parentId`/`childIds` linked, and
 * carries each tile's `refine` onto its record. Driving residency through the
 * store and mapping its nodes the way `StreamingScheduler._emitReplaceFrontier`
 * does must hide the coarse parent only once every child is resident — never
 * while a child is still absent.
 */

import { describe, it, expect } from 'vitest';
import { TilesetStreamingSource } from '../src/render/streaming/TilesetStreamingSource';
import { createTilesetTransport } from '../src/io/tiles3d/tilesetTransport';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { computeReplaceHidden } from '../src/render/streaming/replaceFrontier';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const ENTRY = 'https://tiles.example.com/city/tileset.json';

/** A REPLACE root with two point-cloud children that replace it. */
const REPLACE_DOC = JSON.stringify({
  asset: { version: '1.1' },
  geometricError: 100,
  root: {
    boundingVolume: BOX,
    geometricError: 50,
    refine: 'REPLACE',
    content: { uri: 'root.pnts' },
    children: [
      { boundingVolume: BOX, geometricError: 10, content: { uri: 'a.pnts' } },
      { boundingVolume: BOX, geometricError: 10, content: { uri: 'b.pnts' } },
    ],
  },
});

/** The mapping StreamingScheduler._emitReplaceFrontier applies to the store. */
function hiddenOf(source: TilesetStreamingSource): Set<string> {
  return computeReplaceHidden(
    source.octree.store.all().map((node) => ({
      id: node.record.id,
      refine: node.record.refine,
      resident: node.state === 'resident',
      childIds: node.childIds,
      parentId: node.record.parentId,
    })),
  );
}

describe('the replace frontier over a TilesetStreamingSource', () => {
  function source(): TilesetStreamingSource {
    return new TilesetStreamingSource(
      ENTRY,
      'city',
      ENTRY,
      createTilesetTransport({}),
      parseTileset(REPLACE_DOC),
    );
  }

  it('links the tileset hierarchy into the store as parent and children', () => {
    const s = source();
    const root = s.octree.store.get('root.pnts');
    expect(root?.record.refine).toBe('replace');
    expect(root?.childIds.sort()).toEqual(['a.pnts', 'b.pnts']);
    expect(s.octree.store.get('a.pnts')?.record.parentId).toBe('root.pnts');
  });

  it('keeps the coarse parent while any child is still absent', () => {
    const s = source();
    const store = s.octree.store;
    // Only the root and one child are resident; the frontier must not hide the
    // parent (that would uncover b.pnts's region) and must withhold a.pnts.
    store.setState(store.get('root.pnts')!, 'resident');
    store.setState(store.get('a.pnts')!, 'resident');
    expect(hiddenOf(s)).toEqual(new Set(['a.pnts']));
  });

  it('refines the parent away once every child is resident', () => {
    const s = source();
    const store = s.octree.store;
    store.setState(store.get('root.pnts')!, 'resident');
    store.setState(store.get('a.pnts')!, 'resident');
    store.setState(store.get('b.pnts')!, 'resident');
    // Parent hidden, both children drawn — the atomic swap.
    expect(hiddenOf(s)).toEqual(new Set(['root.pnts']));
  });

  it('hides nothing before anything is resident', () => {
    expect(hiddenOf(source())).toEqual(new Set());
  });
});
