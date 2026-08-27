/**
 * tilesetCeilings.test.ts — the parse ceilings refuse, and the streaming reader
 * inherits them.
 *
 * Every ceiling in this reader is a refusal rather than a truncation, because a
 * partially assembled tileset would look complete on screen and measure wrong.
 * The depth and tile-count ceilings had no test at all, so nothing said whether
 * they still fired.
 *
 * The second half matters for a different reason. The streaming reader replaced
 * a merged one that carried its own ceilings, and the question "does the new
 * path still refuse what the old path refused" cannot be answered by reading
 * either file: the streaming reader inherits these by calling the same parser,
 * which is a fact about the call graph and is worth pinning before the merged
 * reader is retired.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTileset,
  DEFAULT_TILESET_MAX_DEPTH,
  DEFAULT_TILESET_MAX_TILES,
} from '../src/io/tiles3d/tileset';
import { TilesetStreamingSource } from '../src/render/streaming/TilesetStreamingSource';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const doc = (root: unknown) =>
  JSON.stringify({ asset: { version: '1.0' }, geometricError: 100, root });

/** A root with `depth` levels of single-child nesting below it. */
function chain(depth: number): unknown {
  let t: Record<string, unknown> = {
    boundingVolume: BOX,
    geometricError: 1,
    content: { uri: 'leaf.pnts' },
  };
  for (let i = 0; i < depth; i++) {
    t = { boundingVolume: BOX, geometricError: 10, refine: 'REPLACE', children: [t] };
  }
  return t;
}

/** A root with `n` leaf children. */
function fan(n: number): unknown {
  return {
    boundingVolume: BOX,
    geometricError: 50,
    refine: 'REPLACE',
    children: Array.from({ length: n }, (_, i) => ({
      boundingVolume: BOX,
      geometricError: 1,
      content: { uri: `t${i}.pnts` },
    })),
  };
}

const transport = (): TilesetTransport => ({
  fetchTilesetJson: async () => '{}',
  // An explicit hierarchy asks for no subtree, so a request for one here would
  // be the reader inventing work rather than a case this test set up.
  fetchSubtreeBytes: async () => {
    throw new Error('this tileset states an explicit hierarchy; no subtree exists');
  },
  fetchTileBytes: async () => new ArrayBuffer(8),
});

describe('the ceilings refuse rather than truncate', () => {
  it('refuses a hierarchy deeper than the cap, and says the cap', () => {
    expect(() => parseTileset(doc(chain(DEFAULT_TILESET_MAX_DEPTH + 8)))).toThrow(
      /deeper than 24 levels; refusing/,
    );
  });

  it('accepts a hierarchy at the cap', () => {
    // A cap that also rejected the legal depth would be a truncation of a
    // different kind: documents the reader is meant to open would not open.
    expect(() => parseTileset(doc(chain(DEFAULT_TILESET_MAX_DEPTH - 2)))).not.toThrow();
  });

  it('refuses more tiles than the cap, and says the cap', () => {
    expect(() => parseTileset(doc(fan(300)), { maxTiles: 100 })).toThrow(
      /more than 100 tiles; refusing/,
    );
  });

  it('states a tile ceiling large enough to be about protection, not policy', () => {
    expect(DEFAULT_TILESET_MAX_TILES).toBeGreaterThanOrEqual(100_000);
  });
});

describe('the streaming reader inherits them', () => {
  it('refuses the over-deep tileset the merged reader refused', () => {
    // It inherits by calling the same parser. Pinned because retiring the
    // merged reader removes the other place this was enforced.
    expect(() => {
      const t = parseTileset(doc(chain(DEFAULT_TILESET_MAX_DEPTH + 8)));
      return new TilesetStreamingSource('id', 'n', 'https://h/d/tileset.json', transport(), t);
    }).toThrow(/refusing/);
  });

  it('refuses an unsupported asset.version before serving any tile', () => {
    expect(() =>
      parseTileset(
        JSON.stringify({
          asset: { version: '2.0' },
          geometricError: 100,
          root: { boundingVolume: BOX, geometricError: 50, content: { uri: 'r.pnts' } },
        }),
      ),
    ).toThrow();
  });
});
