import { describe, expect, it } from 'vitest';

import { expandImplicitTileset } from '../src/io/tiles3d/implicitExpand';
import { parseTileset } from '../src/io/tiles3d/tileset';

/**
 * The expander turns an implicit document into an equivalent explicit one, and
 * `parseTileset` refuses an unexpanded implicit document by design. So the open
 * path has to call the expander before the parser, or implicit tiling stays
 * unreachable no matter how complete the reader is.
 *
 * This reads the shipped source for the call ordering, because the failure mode
 * is that nobody calls the expander, and drives the pair directly to prove the
 * two compose.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const openSrc = readFileSync(
  fileURLToPath(new URL('../src/app/openTilesetLayer.ts', import.meta.url)),
  'utf8',
);

/** One quadtree subtree, root available, no children available. */
function subtreeBytes(): ArrayBuffer {
  const json = JSON.stringify({
    tileAvailability: { constant: 1 },
    contentAvailability: [{ constant: 1 }],
    childSubtreeAvailability: { constant: 0 },
  });
  const padded = json.padEnd(Math.ceil(json.length / 8) * 8, ' ');
  const jsonBytes = new TextEncoder().encode(padded);
  const buf = new ArrayBuffer(24 + jsonBytes.length);
  const view = new DataView(buf);
  view.setUint32(0, 0x74627573, true); // "subt"
  view.setUint32(4, 1, true);
  view.setBigUint64(8, BigInt(jsonBytes.length), true);
  view.setBigUint64(16, 0n, true);
  new Uint8Array(buf, 24).set(jsonBytes);
  return buf;
}

const IMPLICIT_DOC = {
  asset: { version: '1.1' },
  geometricError: 100,
  root: {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
    geometricError: 100,
    refine: 'ADD',
    content: { uri: 'content/{level}/{x}/{y}.pnts' },
    implicitTiling: {
      subdivisionScheme: 'QUADTREE',
      subtreeLevels: 2,
      availableLevels: 1,
      subtrees: { uri: 'subtrees/{level}/{x}/{y}.subtree' },
    },
  },
};

describe('the tileset open expands implicit tiling before parsing', () => {
  it('calls the expander, so an implicit tileset can reach the parser', () => {
    // The CALL, not the import: an unused import satisfies a bare name match
    // while the expander never runs.
    expect(
      openSrc,
      'openTilesetLayer never calls expandImplicitTileset, so parseTileset still ' +
        'refuses every implicit document and the reader is unreachable',
    ).toMatch(/await\s+expandImplicitTileset\(/);
  });

  it('parses what the expander returned, not the raw document', () => {
    // Calling the expander and then parsing the original leaves the feature
    // just as unreachable, and no name match would notice.
    expect(openSrc).toMatch(/parseTileset\(linked\)/);
    expect(openSrc, 'the raw json must not go straight to the parser').not.toMatch(
      /parseTileset\(json\)/,
    );
  });

  it('expands before it parses, not after', () => {
    const expandAt = openSrc.search(/await\s+expandImplicitTileset\(/);
    const parseAt = openSrc.indexOf('parseTileset(linked)');
    expect(expandAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(-1);
    expect(expandAt, 'the expander must run before the parser').toBeLessThan(parseAt);
  });

  it('keeps a cancel a cancel, rather than reporting it as a refusal', () => {
    // The expander awaits network reads, so a user cancelling mid-expansion
    // lands in this catch. Reported as a TilesetRefusal it would surface as
    // "this tileset was refused" for a scan the user simply stopped.
    expect(openSrc).toMatch(/if \(err instanceof LoadCancelledError\) throw err;/);
  });

  it('the pair composes: an implicit document parses once expanded', async () => {
    // Unexpanded, the parser refuses by design.
    expect(() => parseTileset(IMPLICIT_DOC)).toThrow(/implicit tiling/i);

    const expanded = await expandImplicitTileset(IMPLICIT_DOC, {
      entryUrl: 'https://tiles.example.com/tileset.json',
      fetchSubtreeBytes: async () => subtreeBytes(),
    });
    const tileset = parseTileset(expanded);
    expect(tileset.root).toBeDefined();
  });

  it('leaves a non-implicit document untouched, so the call is safe unconditionally', async () => {
    const explicit = {
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
        geometricError: 100,
        refine: 'ADD',
        content: { uri: 'a.pnts' },
      },
    };
    const out = await expandImplicitTileset(explicit, {
      entryUrl: 'https://tiles.example.com/tileset.json',
      fetchSubtreeBytes: async () => {
        throw new Error('an explicit document must fetch no subtree');
      },
    });
    expect(parseTileset(out).root).toBeDefined();
  });
});
