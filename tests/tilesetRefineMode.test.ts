/**
 * tilesetRefineMode.test.ts — the two refinement modes are not the same scene.
 *
 * ADD means a refined tile's content is additive: the parent IS drawn alongside
 * its children. REPLACE means the parent's content is replaced by them, so it
 * must NOT be drawn once they are selected.
 *
 * The streaming scheduler draws every resident node. That is exactly right for
 * ADD. For REPLACE it draws the coarse parent and the fine children over the
 * same ground, which duplicates geometry on screen and inflates the displayed
 * point count. `Tile.refine` is parsed and reaches the streaming path nowhere,
 * so nothing downstream could tell the two apart.
 *
 * Until the scheduler can suppress a replaced ancestor, a REPLACE tile that
 * genuinely refines into content is refused by name rather than drawn wrongly.
 * A REPLACE tile that refines into nothing cannot duplicate anything, so it is
 * served.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

const doc = (refine: string, childHasContent: boolean) =>
  JSON.stringify({
    asset: { version: '1.1' },
    geometricError: 100,
    root: {
      boundingVolume: BOX,
      geometricError: 50,
      refine,
      content: { uri: 'root.pnts' },
      children: [
        {
          boundingVolume: BOX,
          geometricError: 10,
          ...(childHasContent ? { content: { uri: 'child.pnts' } } : {}),
        },
      ],
    },
  });

describe('refinement mode', () => {
  it('serves an ADD tileset, parent and child together', () => {
    // Additive refinement is what the scheduler already does correctly.
    const idx = tilesetNodes(parseTileset(doc('ADD', true)));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts', 'child.pnts']);
    expect(idx.skipped).toEqual([]);
  });

  it('refuses a REPLACE tile that refines into content', () => {
    const idx = tilesetNodes(parseTileset(doc('REPLACE', true)));
    expect(
      idx.skipped.join(' '),
      'drawing the parent alongside its replacement duplicates geometry and ' +
        'inflates the displayed point count',
    ).toContain('REPLACE');
    expect(idx.skipped.join(' ')).toContain('root.pnts');
  });

  it('serves a REPLACE tile that refines into nothing', () => {
    // Nothing replaces it, so nothing can be drawn twice.
    const idx = tilesetNodes(parseTileset(doc('REPLACE', false)));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts']);
    expect(idx.skipped).toEqual([]);
  });

  it('sees content anywhere below, not only in a direct child', () => {
    const deep = JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        boundingVolume: BOX,
        geometricError: 50,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: [
          {
            boundingVolume: BOX,
            geometricError: 20,
            children: [{ boundingVolume: BOX, geometricError: 5, content: { uri: 'deep.pnts' } }],
          },
        ],
      },
    });
    expect(
      tilesetNodes(parseTileset(deep)).skipped.join(' '),
      'a structural tile between the parent and its replacement hides nothing',
    ).toContain('REPLACE');
  });
});
