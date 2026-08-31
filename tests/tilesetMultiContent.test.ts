/**
 * tilesetMultiContent.test.ts — the 3D Tiles 1.1 `contents` array is served,
 * and a tile with several contents must never open short of tiles.
 *
 * 1.1 lets a tile carry `contents`, an array, instead of `content`. The parser
 * once read only the single form, so such a tile produced no content URI, and
 * the node walk treated it as a STRUCTURAL tile: no node, and nothing added to
 * `skipped`. `isComplete` stayed true and the open succeeded, serving none of
 * that tile's data while reporting a complete scene.
 *
 * The parser now reads every entry of the array, so each point-cloud content on
 * a tile becomes its own node. These cases pin that every entry is served and
 * that the completeness accounting stays honest — a tile whose entries are all
 * point clouds yields one node per entry, with nothing silently dropped.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

/** A tileset whose child carries two point contents in the 1.1 array form. */
const MULTI = JSON.stringify({
  asset: { version: '1.1' },
  geometricError: 100,
  root: {
    boundingVolume: BOX,
    geometricError: 50,
    refine: 'ADD',
    content: { uri: 'a.pnts' },
    children: [
      {
        boundingVolume: BOX,
        geometricError: 10,
        contents: [{ uri: 'b.pnts' }, { uri: 'c.pnts' }],
      },
    ],
  },
});

describe('the 1.1 multi-content form', () => {
  it('serves every point content in the array as its own node', () => {
    const idx = tilesetNodes(parseTileset(MULTI));
    expect(idx.records.map((r) => r.id)).toEqual(['a.pnts', 'b.pnts', 'c.pnts']);
  });

  it('never yields a tileset that is short of tiles yet calls itself complete', () => {
    // The old regression, stated as what a user would get. A three-content
    // document must serve three nodes, and any content it could not serve must
    // be recorded in `skipped` rather than silently dropped.
    const idx = tilesetNodes(parseTileset(MULTI));
    const complete = idx.skipped.length === 0;
    expect(
      complete && idx.records.length < 3,
      `served ${idx.records.length} of 3 contents while reporting complete`,
    ).toBe(false);
  });

  it('still reads the single-content form', () => {
    const single = JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 100,
      root: { boundingVolume: BOX, geometricError: 50, refine: 'ADD', content: { uri: 'a.pnts' } },
    });
    expect(tilesetNodes(parseTileset(single)).records.map((r) => r.id)).toEqual(['a.pnts']);
  });
});
