/**
 * tiles3dSubtree.test.ts — the `.subtree` binary reader.
 *
 * A subtree file is the only part of an implicit tileset that states fact
 * rather than rule, so every wrong answer this reader could give is a tile
 * reported present that is not, or absent that is. The cases below are the ways
 * that happens: a constant read as a bitstream, a bitstream located in the
 * wrong buffer, a bitstream sized for a different subtree shape, and a body
 * whose header promises more than it carries.
 *
 * Every expected number is hand-computed from the stated rule. A QUADTREE
 * subtree of 2 levels addresses 1 + 4 = 5 tiles and 16 child-subtree roots; an
 * OCTREE subtree of 2 levels addresses 1 + 8 = 9 tiles and 64 child roots.
 */

import { describe, it, expect } from 'vitest';
import {
  readSubtreeDocument,
  resolveSubtreeAvailability,
  subtreeExternalBuffers,
  subtreeTileCount,
  subtreeChildCount,
  MAX_SUBTREE_LEVELS,
  MAX_TILES_PER_SUBTREE,
  MAX_SUBTREE_EXTERNAL_BUFFERS,
  type SubtreeShape,
} from '../src/io/tiles3d/subtree';
import { isAvailable } from '../src/io/tiles3d/implicitCoordinates';
import { makeSubtree, bitstream, ALL_AVAILABLE, NONE_AVAILABLE } from './fixtures/subtree3d';

const QUAD2: SubtreeShape = { scheme: 'QUADTREE', subtreeLevels: 2 };
const OCT2: SubtreeShape = { scheme: 'OCTREE', subtreeLevels: 2 };

/** Read a body and resolve it in one step, for the cases with no external buffer. */
function read(body: ArrayBuffer, shape: SubtreeShape = QUAD2) {
  return resolveSubtreeAvailability(readSubtreeDocument(body), shape);
}

describe('subtree shape arithmetic', () => {
  it('counts the tiles and child roots each scheme addresses', () => {
    expect(subtreeTileCount(QUAD2)).toBe(5);
    expect(subtreeChildCount(QUAD2)).toBe(16);
    expect(subtreeTileCount(OCT2)).toBe(9);
    expect(subtreeChildCount(OCT2)).toBe(64);
    expect(subtreeTileCount({ scheme: 'QUADTREE', subtreeLevels: 1 })).toBe(1);
  });
});

describe('subtree availability: constants', () => {
  it('reads an all-available constant as available at every index', () => {
    const a = read(
      makeSubtree({
        tileAvailability: ALL_AVAILABLE,
        contentAvailability: ALL_AVAILABLE,
        childSubtreeAvailability: NONE_AVAILABLE,
      }),
    );
    expect(a.tileCount).toBe(5);
    expect(a.childSubtreeCount).toBe(16);
    for (let i = 0; i < 5; i++) expect(isAvailable(a.tile, i)).toBe(true);
    expect(isAvailable(a.childSubtree, 15)).toBe(false);
  });

  it('carries the tile count as the availability length, so an index past it throws', () => {
    const a = read(
      makeSubtree({ tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE }),
    );
    expect(() => isAvailable(a.tile, 5)).toThrow(/outside the 5 tiles covered/);
  });

  it('reports no content when the document states none', () => {
    const a = read(
      makeSubtree({ tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE }),
    );
    expect(a.content).toBeNull();
  });
});

describe('subtree availability: internal bitstreams', () => {
  /** Root plus the first and last of its four children. */
  const PATTERN = [true, true, false, false, true];

  it('reads a bitstream out of the internal binary chunk, LSB-first', () => {
    const bits = bitstream(PATTERN, 5);
    // 1 + 2 + 16 = 19: bit 0, bit 1 and bit 4 set in the single byte.
    expect(bits[0]).toBe(0b10011);
    const a = read(
      makeSubtree(
        {
          buffers: [{ byteLength: 1 }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
          tileAvailability: { bitstream: 0 },
          childSubtreeAvailability: NONE_AVAILABLE,
        },
        { binary: bits },
      ),
    );
    expect([0, 1, 2, 3, 4].map((i) => isAvailable(a.tile, i))).toEqual(PATTERN);
  });

  it('reads a bitstream at a non-zero bufferView offset', () => {
    const binary = new Uint8Array([0xff, 0b10011]);
    const a = read(
      makeSubtree(
        {
          buffers: [{ byteLength: 2 }],
          bufferViews: [{ buffer: 0, byteOffset: 1, byteLength: 1 }],
          tileAvailability: { bitstream: 0 },
          childSubtreeAvailability: NONE_AVAILABLE,
        },
        { binary },
      ),
    );
    expect([0, 1, 2, 3, 4].map((i) => isAvailable(a.tile, i))).toEqual(PATTERN);
  });

  it('reads an OCTREE subtree at its own wider shape', () => {
    // Nine tiles need two bytes; sixty-four child roots need eight.
    const a = read(
      makeSubtree(
        {
          buffers: [{ byteLength: 2 }],
          bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }],
          tileAvailability: { bitstream: 0 },
          childSubtreeAvailability: NONE_AVAILABLE,
        },
        { binary: bitstream([true, false, false, false, false, false, false, false, true], 9) },
      ),
      OCT2,
    );
    expect(a.tileCount).toBe(9);
    expect(isAvailable(a.tile, 0)).toBe(true);
    expect(isAvailable(a.tile, 8)).toBe(true);
    expect(isAvailable(a.tile, 4)).toBe(false);
  });
});

describe('subtree availability: external bitstream buffers', () => {
  const doc = () =>
    readSubtreeDocument(
      makeSubtree({
        buffers: [{ uri: 'availability.bin', byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
        tileAvailability: { bitstream: 0 },
        childSubtreeAvailability: NONE_AVAILABLE,
      }),
    );

  it('reports the external buffer a caller must fetch, without fetching it', () => {
    expect(subtreeExternalBuffers(doc())).toEqual([
      { index: 0, uri: 'availability.bin', byteLength: 1 },
    ]);
  });

  it('reads the bitstream out of the buffer the caller supplies', () => {
    const a = resolveSubtreeAvailability(
      doc(),
      QUAD2,
      new Map([[0, bitstream([true, false, true, false, true], 5)]]),
    );
    expect([0, 1, 2, 3, 4].map((i) => isAvailable(a.tile, i))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('refuses when an external buffer was never supplied', () => {
    expect(() => resolveSubtreeAvailability(doc(), QUAD2)).toThrow(
      /buffer 0 is external and was not supplied/,
    );
  });

  it('refuses an external buffer shorter than the document declares', () => {
    expect(() =>
      resolveSubtreeAvailability(doc(), QUAD2, new Map([[0, new Uint8Array(0)]])),
    ).toThrow(/declares 1 bytes but 0 were available; it is truncated/);
  });

  it('refuses more external buffers than the ceiling allows', () => {
    const buffers = Array.from({ length: MAX_SUBTREE_EXTERNAL_BUFFERS + 1 }, (_, i) => ({
      uri: `b${i}.bin`,
      byteLength: 1,
    }));
    expect(() =>
      subtreeExternalBuffers(
        readSubtreeDocument(
          makeSubtree({
            buffers,
            tileAvailability: ALL_AVAILABLE,
            childSubtreeAvailability: NONE_AVAILABLE,
          }),
        ),
      ),
    ).toThrow(/external buffers is above the ceiling of 8; refusing/);
  });
});

describe('subtree container: malformed headers', () => {
  it('refuses a body shorter than the header', () => {
    expect(() => readSubtreeDocument(new Uint8Array(12))).toThrow(
      /12 bytes, shorter than the 24-byte header/,
    );
  });

  it('refuses a body that does not carry the subt magic, and says what it saw', () => {
    const body = makeSubtree(
      { tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE },
      { magic: 'glTF' },
    );
    expect(() => readSubtreeDocument(body)).toThrow(/does not start with the "subt" magic \(found "glTF"\)/);
  });

  it('refuses a container version it does not implement', () => {
    const body = makeSubtree(
      { tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE },
      { version: 2 },
    );
    expect(() => readSubtreeDocument(body)).toThrow(/version 2 is not the version 1/);
  });

  it('refuses a header whose chunk lengths overrun the body', () => {
    const body = makeSubtree(
      { tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE },
      { binaryByteLength: 4096 },
    );
    expect(() => readSubtreeDocument(body)).toThrow(/it is truncated/);
  });

  it('refuses a body cut short of the length its header declares', () => {
    const body = makeSubtree(
      { tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE },
      { truncateTo: 30 },
    );
    expect(() => readSubtreeDocument(body)).toThrow(/it is truncated/);
  });

  it('refuses an empty JSON chunk', () => {
    const body = makeSubtree(
      { tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE },
      { jsonByteLength: 0 },
    );
    expect(() => readSubtreeDocument(body)).toThrow(/JSON chunk is empty/);
  });

  it('refuses a JSON chunk that is not valid JSON', () => {
    const good = new Uint8Array(
      makeSubtree({ tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE }),
    );
    good[24] = 0x7b; // an opening brace with no close
    good[25] = 0x7b;
    expect(() => readSubtreeDocument(good)).toThrow(/is not valid JSON/);
  });
});

describe('subtree availability: shape disagreements', () => {
  it('refuses a bitstream sized for a different number of levels', () => {
    // One byte covers the five tiles of a 2-level quadtree. Read at 3 levels
    // the same subtree addresses 21 tiles and needs three.
    const body = makeSubtree(
      {
        buffers: [{ byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
        tileAvailability: { bitstream: 0 },
        childSubtreeAvailability: NONE_AVAILABLE,
      },
      { binary: bitstream([true], 5) },
    );
    expect(() =>
      resolveSubtreeAvailability(readSubtreeDocument(body), {
        scheme: 'QUADTREE',
        subtreeLevels: 3,
      }),
    ).toThrow(/is 1 bytes but the 21 tiles it must describe need 3; the bitstream disagrees/);
  });

  it('refuses a bufferView that runs past the end of its buffer', () => {
    const body = makeSubtree(
      {
        buffers: [{ byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: 1 }],
        tileAvailability: { bitstream: 0 },
        childSubtreeAvailability: NONE_AVAILABLE,
      },
      { binary: new Uint8Array(1) },
    );
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /runs past the end of buffer 0/,
    );
  });

  it('refuses a bitstream naming a bufferView that does not exist', () => {
    const body = makeSubtree({
      bufferViews: [],
      tileAvailability: { bitstream: 3 },
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /names bufferView 3, which does not exist/,
    );
  });
});

describe('subtree availability: forms this reader does not implement', () => {
  it('names the extension bufferView spelling rather than calling the document malformed', () => {
    const body = makeSubtree({
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
      buffers: [{ byteLength: 1 }],
      tileAvailability: { bufferView: 0 },
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /3DTILES_implicit_tiling extension's `bufferView` key/,
    );
  });

  it('refuses several contents per tile by name', () => {
    const body = makeSubtree({
      tileAvailability: ALL_AVAILABLE,
      contentAvailability: [ALL_AVAILABLE, ALL_AVAILABLE],
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /declares 2 contents per tile, the 1.1 multi-content form/,
    );
  });

  it('refuses an availability declaring both a constant and a bitstream', () => {
    const body = makeSubtree({
      tileAvailability: { constant: 1, bitstream: 0 },
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /declares both constant and bitstream/,
    );
  });

  it('refuses an availability declaring neither', () => {
    const body = makeSubtree({
      tileAvailability: {},
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /declares neither constant nor bitstream/,
    );
  });

  it('refuses a document with no tileAvailability at all', () => {
    const body = makeSubtree({ childSubtreeAvailability: NONE_AVAILABLE });
    expect(() => resolveSubtreeAvailability(readSubtreeDocument(body), QUAD2)).toThrow(
      /declares no tileAvailability/,
    );
  });
});

describe('subtree ceilings refuse rather than truncate', () => {
  const body = () =>
    readSubtreeDocument(
      makeSubtree({ tileAvailability: ALL_AVAILABLE, childSubtreeAvailability: NONE_AVAILABLE }),
    );

  it('refuses subtreeLevels above the structural ceiling, and says the ceiling', () => {
    expect(() =>
      resolveSubtreeAvailability(body(), {
        scheme: 'QUADTREE',
        subtreeLevels: MAX_SUBTREE_LEVELS + 1,
      }),
    ).toThrow(/subtreeLevels 25 is above the ceiling of 24; refusing/);
  });

  it('refuses a subtree describing more tiles than the ceiling, and says both numbers', () => {
    // OCTREE at 8 levels addresses (8^8 - 1) / 7 = 2 396 745 tiles.
    expect(() =>
      resolveSubtreeAvailability(body(), { scheme: 'OCTREE', subtreeLevels: 8 }),
    ).toThrow(
      new RegExp(`describes 2396745 tiles, above the ceiling of ${MAX_TILES_PER_SUBTREE}; refusing`),
    );
  });

  it('accepts a subtree just inside the tile ceiling', () => {
    // OCTREE at 7 levels addresses (8^7 - 1) / 7 = 299 593 tiles.
    expect(subtreeTileCount({ scheme: 'OCTREE', subtreeLevels: 7 })).toBe(299_593);
    expect(() =>
      resolveSubtreeAvailability(body(), { scheme: 'OCTREE', subtreeLevels: 7 }),
    ).not.toThrow();
  });

  it('refuses subtreeLevels below one', () => {
    expect(() =>
      resolveSubtreeAvailability(body(), { scheme: 'QUADTREE', subtreeLevels: 0 }),
    ).toThrow(/subtreeLevels must be an integer of at least 1/);
  });
});
