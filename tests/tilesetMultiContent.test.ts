/**
 * tilesetMultiContent.test.ts — a tile this reader cannot serve must not pass
 * for a tile with nothing to serve.
 *
 * 3D Tiles 1.1 lets a tile carry `contents`, an array, instead of `content`.
 * The parser reads only the single form, so such a tile produced a null URI,
 * and the node walk treats a null URI as a STRUCTURAL tile: no node, and
 * nothing added to `skipped`. `isComplete` therefore stayed true and the open
 * succeeded, serving none of that tile's data while reporting a complete scene.
 *
 * That is the failure mode every ceiling in this reader exists to prevent, so
 * the case below is written against the observable consequence (a tileset that
 * opens with tiles missing) rather than against the parser's error string.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

/** A tileset whose child carries two contents in the 1.1 array form. */
const MULTI = JSON.stringify({
  asset: { version: '1.1' },
  geometricError: 100,
  root: {
    boundingVolume: BOX,
    geometricError: 50,
    refine: 'REPLACE',
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
  it('is refused, and the message says what would otherwise be lost', () => {
    let message = '';
    try {
      parseTileset(MULTI);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('contents');
    expect(
      message,
      'the refusal must say why, since the alternative is a scene that looks complete',
    ).toContain('reported itself complete');
  });

  it('never yields a tileset that is short of tiles yet calls itself complete', () => {
    // The regression, stated as what a user would get. Before the refusal this
    // parsed cleanly and produced ONE node for a three-tile document, with an
    // empty `skipped`, so nothing downstream could tell.
    let idx: ReturnType<typeof tilesetNodes> | null = null;
    try {
      idx = tilesetNodes(parseTileset(MULTI));
    } catch {
      idx = null; // refused at parse, which is the fix
    }
    if (idx === null) return;
    const complete = idx.skipped.length === 0;
    expect(
      complete && idx.records.length < 3,
      `served ${idx.records.length} of 3 tiles while reporting complete`,
    ).toBe(false);
  });

  it('still reads the single-content form', () => {
    const single = JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 100,
      root: { boundingVolume: BOX, geometricError: 50, refine: 'REPLACE', content: { uri: 'a.pnts' } },
    });
    expect(tilesetNodes(parseTileset(single)).records.map((r) => r.id)).toEqual(['a.pnts']);
  });
});
