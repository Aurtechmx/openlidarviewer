/**
 * tiles3dTilesetOpen.test.ts — opening a tileset over a faked transport,
 * selecting what a view needs, and decoding one tile into root space.
 *
 * No network. The transport is a plain object serving a scripted map of URL to
 * body, which is also how the fetch-count assertions below can say that a
 * refused tileset caused no tile fetch at all — "never partially mounted" is a
 * claim about what was NOT requested, so it has to be measured that way.
 *
 * The bounded cases are the ones worth the most care. This feature family has
 * produced allocation defects where a declaration sized the work, so each cap
 * gets a test that the cap REFUSES rather than truncates, and the caps are the
 * mutation targets: removing the depth cap must fail a test here, and so must
 * transposing the column-major transform composition.
 *
 * WHAT THIS COVERS. The superseded one-shot reader under
 * `tests/reference/tiles3d-static/`, not the code the product runs. A
 * `tileset.json` opens through `src/app/openTilesetLayer.ts` into
 * `src/render/streaming/TilesetStreamingSource.ts`; that path is covered by
 * `tilesetStreamingOpen.test.ts`, `tilesetStreamingSource.test.ts`,
 * `tilesetNodes.test.ts`, `tilesetCeilings.test.ts` and `pntsDecode.test.ts`.
 * A pass here says the reference still behaves as its header describes. It says
 * nothing about what the viewer does.
 */

import { describe, expect, test } from 'vitest';
import {
  openTileset,
  selectTileContents,
  fetchTileContent,
  MAX_SELECTED_TILES,
} from './reference/tiles3d-static/tilesetOpen';
import { DEFAULT_TILESET_MAX_DEPTH } from '../src/io/tiles3d/tileset';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';
import type { ViewCamera } from '../src/io/tiles3d/tilesetTraversal';

const ENTRY = 'https://tiles.example.org/scan/a/tileset.json';

const PNTS_MAGIC = 0x73746e70; // 'pnts', little-endian

/** A minimal PNTS tile: 28-byte header, feature-table JSON, feature-table binary. */
function makePnts(
  points: readonly (readonly [number, number, number])[],
  rtc?: readonly [number, number, number],
): ArrayBuffer {
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (rtc) ft.RTC_CENTER = rtc;
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = points.length * 3 * 4;
  const total = 28 + jsonBytes.length + binBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  const binStart = 28 + jsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binStart + k++ * 4, c, true);
  return buf;
}

/** A transport over an in-memory URL map, counting what it was asked for. */
function fakeTransport(
  json: Record<string, string>,
  tiles: Record<string, ArrayBuffer> = {},
): TilesetTransport & { readonly requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    fetchTilesetJson: async (url) => {
      requests.push(url);
      const body = json[url];
      if (body === undefined) throw new Error(`3D Tiles tileset fetch failed (404) for ${url}`);
      return body;
    },
    // An explicit hierarchy asks for no subtree, so a request for one here would
    // be the reader inventing work rather than a case this test set up.
    fetchSubtreeBytes: async () => {
      throw new Error('this tileset states an explicit hierarchy; no subtree exists');
    },
    fetchTileBytes: async (url) => {
      requests.push(url);
      const body = tiles[url];
      if (body === undefined) throw new Error(`3D Tiles tile fetch failed (404) for ${url}`);
      return body;
    },
  };
}

/** A box tile with only the fields the parser requires. */
function rawTile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
    geometricError: 100,
    ...over,
  };
}

function doc(root: Record<string, unknown>): string {
  return JSON.stringify({ asset: { version: '1.1' }, geometricError: 100, root });
}

/** Close enough that a 100 m geometric error refines. */
const nearCamera: ViewCamera = {
  kind: 'perspective',
  positionEcef: [30, 0, 0],
  viewportHeightPx: 1000,
  verticalFov: Math.PI / 3,
};

/** Far enough that the same error does not. */
const farCamera: ViewCamera = {
  kind: 'perspective',
  positionEcef: [100_000, 0, 0],
  viewportHeightPx: 1000,
  verticalFov: Math.PI / 3,
};

describe('openTileset', () => {
  test('opens a valid tileset and derives its base and query', async () => {
    const t = fakeTransport({
      [`${ENTRY}?sig=xyz`]: doc(rawTile({ refine: 'REPLACE', content: { uri: '0.pnts' } })),
    });
    const opened = await openTileset(`${ENTRY}?sig=xyz`, t);
    expect(opened.baseUrl).toBe('https://tiles.example.org/scan/a/');
    expect(opened.search).toBe('?sig=xyz');
    expect(opened.tileset.root.contentUri).toBe('0.pnts');
  });

  test('refuses a URL that fails the entry gate without fetching anything', async () => {
    const t = fakeTransport({});
    await expect(openTileset('http://127.0.0.1/tileset.json', t)).rejects.toThrow(/private network/i);
    await expect(openTileset('https://h.example/scan/ept.json', t)).rejects.toThrow(/tileset\.json/);
    expect(t.requests).toEqual([]);
  });

  test('refuses a malformed document and mounts none of it', async () => {
    const cases: Record<string, RegExp> = {
      'not json at all': /./,
      '{"geometricError":1,"root":{}}': /asset\.version/,
      '{"asset":{"version":"1.1"},"root":{}}': /finite geometricError/,
      '{"asset":{"version":"1.1"},"geometricError":1}': /no root tile/,
      [doc(rawTile({}))]: /must declare refine/,
      [doc(rawTile({ refine: 'SOMETIMES' }))]: /not ADD or REPLACE/,
      [doc(rawTile({ refine: 'REPLACE', boundingVolume: { box: [1, 2, 3] } }))]: /12 components/,
      [doc(rawTile({ refine: 'REPLACE', implicitTiling: {} }))]: /implicit tiling/,
      [doc(rawTile({ refine: 'REPLACE', content: { uri: 42 } }))]: /non-empty string/,
    };
    for (const [body, pattern] of Object.entries(cases)) {
      const t = fakeTransport({ [ENTRY]: body });
      await expect(openTileset(ENTRY, t), body.slice(0, 40)).rejects.toThrow(pattern);
    }
  });

  test('an abort during the open leaves nothing opened', async () => {
    const controller = new AbortController();
    const t: TilesetTransport = {
      fetchTilesetJson: async () => {
        // The cancel lands after the body arrives but before anything is parsed:
        // the window where a careless open would already hold a tileset.
        controller.abort();
        return doc(rawTile({ refine: 'REPLACE', content: { uri: '0.pnts' } }));
      },
      // An explicit hierarchy asks for no subtree, so a request for one here would
      // be the reader inventing work rather than a case this test set up.
      fetchSubtreeBytes: async () => {
        throw new Error('this tileset states an explicit hierarchy; no subtree exists');
      },
      fetchTileBytes: async () => {
        throw new Error('no tile should be read on an aborted open');
      },
    };
    let opened: unknown = 'untouched';
    await expect(
      openTileset(ENTRY, t, controller.signal).then((r) => {
        opened = r;
      }),
    ).rejects.toThrow(/abort/i);
    expect(opened).toBe('untouched');
  });
});

describe('traversal is capped, and refuses rather than truncating', () => {
  /** A chain of `depth` nested tiles, each with a large error so every level refines. */
  function chain(depth: number): string {
    let node = rawTile({ geometricError: 1000, content: { uri: `${depth}.pnts` } });
    for (let i = depth - 1; i >= 0; i--) {
      node = rawTile({ geometricError: 1000, content: { uri: `${i}.pnts` }, children: [node] });
    }
    return doc({ ...node, refine: 'REPLACE' });
  }

  test('a tileset deeper than the cap is refused at parse, not partly parsed', async () => {
    const t = fakeTransport({ [ENTRY]: chain(DEFAULT_TILESET_MAX_DEPTH + 1) });
    await expect(openTileset(ENTRY, t)).rejects.toThrow(
      new RegExp(`deeper than ${DEFAULT_TILESET_MAX_DEPTH} levels`),
    );
  });

  test('a tileset exactly at the cap still opens', async () => {
    const t = fakeTransport({ [ENTRY]: chain(DEFAULT_TILESET_MAX_DEPTH) });
    await expect(openTileset(ENTRY, t)).resolves.toBeTruthy();
  });

  test('a lower explicit depth cap is honoured', async () => {
    const t = fakeTransport({ [ENTRY]: chain(6) });
    await expect(openTileset(ENTRY, t, undefined, { maxDepth: 4 })).rejects.toThrow(
      /deeper than 4 levels/,
    );
    await expect(openTileset(ENTRY, t, undefined, { maxDepth: 8 })).resolves.toBeTruthy();
  });

  test('a tile count past the cap is refused', async () => {
    const children = Array.from({ length: 40 }, (_, i) =>
      rawTile({ geometricError: 1, content: { uri: `${i}.pnts` } }),
    );
    const t = fakeTransport({ [ENTRY]: doc(rawTile({ refine: 'REPLACE', children })) });
    await expect(openTileset(ENTRY, t, undefined, { maxTiles: 20 })).rejects.toThrow(
      /more than 20 tiles/,
    );
  });

  test('a selection past the ceiling is refused, not silently shortened', async () => {
    // Wide rather than deep: the depth cap says nothing about a root with a
    // very large number of children, and one camera position reaches them all.
    const children = Array.from({ length: 12 }, (_, i) =>
      rawTile({ geometricError: 1, content: { uri: `${i}.pnts` } }),
    );
    const t = fakeTransport({
      [ENTRY]: doc(rawTile({ refine: 'ADD', geometricError: 1000, children })),
    });
    const opened = await openTileset(ENTRY, t);
    expect(() =>
      selectTileContents(opened, nearCamera, { maxScreenSpaceErrorPx: 1, maxSelectedTiles: 5 }),
    ).toThrow(/past the 5-tile ceiling/);
    // The default ceiling is a real number, not Infinity dressed up as one.
    expect(MAX_SELECTED_TILES).toBeLessThan(100_000);
  });
});

describe('selectTileContents', () => {
  const twoLevel = doc(
    rawTile({
      refine: 'REPLACE',
      geometricError: 1000,
      content: { uri: 'root.pnts' },
      children: [
        rawTile({ geometricError: 1, content: { uri: 'child.pnts' } }),
      ],
    }),
  );

  test('a distant view keeps the root and resolves its content URL', async () => {
    const opened = await openTileset(ENTRY, fakeTransport({ [ENTRY]: twoLevel }));
    const sel = selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 });
    expect(sel.contents.map((c) => c.url)).toEqual([
      'https://tiles.example.org/scan/a/root.pnts',
    ]);
  });

  test('a close view refines to the child, and REPLACE drops the parent', async () => {
    const opened = await openTileset(ENTRY, fakeTransport({ [ENTRY]: twoLevel }));
    const sel = selectTileContents(opened, nearCamera, { maxScreenSpaceErrorPx: 1 });
    expect(sel.contents.map((c) => c.url)).toEqual([
      'https://tiles.example.org/scan/a/child.pnts',
    ]);
  });

  test('a tileset naming a URL outside its own base is refused', async () => {
    const body = doc(
      rawTile({ refine: 'REPLACE', content: { uri: 'https://evil.example/x.pnts' } }),
    );
    const t = fakeTransport({ [ENTRY]: body });
    const opened = await openTileset(ENTRY, t);
    expect(() => selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 })).toThrow(
      /outside the tileset's own host/,
    );
    // Refused before any fetch: only the tileset.json was ever requested.
    expect(t.requests).toEqual([ENTRY]);
  });

  test('a `..` escape on the tileset’s own host is refused too', async () => {
    const body = doc(rawTile({ refine: 'REPLACE', content: { uri: '../../etc/x.pnts' } }));
    const opened = await openTileset(ENTRY, fakeTransport({ [ENTRY]: body }));
    expect(() => selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 })).toThrow(
      /escapes the tileset directory/,
    );
  });

  test('an external tileset is reported rather than followed', async () => {
    const body = doc(rawTile({ refine: 'REPLACE', content: { uri: 'sub/tileset.json' } }));
    const t = fakeTransport({ [ENTRY]: body });
    const opened = await openTileset(ENTRY, t);
    const sel = selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 });
    expect(sel.contents).toEqual([]);
    expect(sel.externalTilesets.map((c) => c.url)).toEqual([
      'https://tiles.example.org/scan/a/sub/tileset.json',
    ]);
    expect(t.requests).toEqual([ENTRY]);
  });

  test('a content type this viewer cannot decode is refused, not fetched', async () => {
    const body = doc(rawTile({ refine: 'REPLACE', content: { uri: 'model.b3dm' } }));
    const opened = await openTileset(ENTRY, fakeTransport({ [ENTRY]: body }));
    expect(() => selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 })).toThrow(
      /not a \.pnts tile/,
    );
  });

  test('a selected tile with no content of its own is counted, not invented', async () => {
    const body = doc(rawTile({ refine: 'REPLACE' }));
    const opened = await openTileset(ENTRY, fakeTransport({ [ENTRY]: body }));
    const sel = selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 });
    expect(sel.contents).toEqual([]);
    expect(sel.emptyTiles).toBe(1);
  });
});

describe('fetchTileContent places a tile in root space', () => {
  /**
   * A transform that is asymmetric in every way that matters: it is not its own
   * transpose, and its translation lives in the last COLUMN, which is where a
   * column-major 4x4 keeps it (`m[col * 4 + row]`, so indices 12..14). A
   * row-major read of the same sixteen numbers picks up 3, 7, 11 instead, and a
   * transposed composition mixes the rotation into the wrong axes — both
   * produce a scene that is plausibly placed and wrong.
   */
  const TRANSFORM = [
    0, 1, 0, 0,
    -1, 0, 0, 0,
    0, 0, 2, 0,
    100, 200, 300, 1,
  ];

  test('applies RTC_CENTER, then the cumulative transform, in float64', async () => {
    const body = doc(
      rawTile({ refine: 'REPLACE', transform: TRANSFORM, content: { uri: '0.pnts' } }),
    );
    const url = 'https://tiles.example.org/scan/a/0.pnts';
    const t = fakeTransform(body, url);
    const opened = await openTileset(ENTRY, t);
    const sel = selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 });
    const placed = await fetchTileContent(sel.contents[0]!, t);

    // Local (1, 2, 3) + RTC (10, 20, 30) = (11, 22, 33). Through the transform:
    //   x' = 0*11 + -1*22 + 0*33 + 100 =  78
    //   y' = 1*11 +  0*22 + 0*33 + 200 = 211
    //   z' = 0*11 +  0*22 + 2*33 + 300 = 366
    expect(placed.pointCount).toBe(2);
    expect(placed.positions).toBeInstanceOf(Float64Array);
    expect([...placed.positions.slice(0, 3)]).toEqual([78, 211, 366]);
    // Second point local (4, 5, 6) + RTC = (14, 25, 36):
    //   x' = -25 + 100 = 75, y' = 14 + 200 = 214, z' = 72 + 300 = 372
    expect([...placed.positions.slice(3, 6)]).toEqual([75, 214, 372]);
  });

  test('composes a nested transform parent-first, not child-first', async () => {
    // The child rotates, the parent translates. Parent-then-child places the
    // rotated point at the parent's offset; the reverse order rotates the
    // offset itself and lands somewhere else entirely.
    const child = rawTile({
      geometricError: 1,
      transform: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      content: { uri: 'c.pnts' },
    });
    const body = doc(
      rawTile({
        refine: 'REPLACE',
        geometricError: 1000,
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1000, 0, 0, 1],
        children: [child],
      }),
    );
    const url = 'https://tiles.example.org/scan/a/c.pnts';
    const t = fakeTransport({ [ENTRY]: body }, { [url]: makePnts([[1, 0, 0], [0, 1, 0]]) });
    const opened = await openTileset(ENTRY, t);
    const sel = selectTileContents(opened, nearCamera, { maxScreenSpaceErrorPx: 1 });
    const placed = await fetchTileContent(sel.contents[0]!, t);
    // (1,0,0) rotated to (0,1,0), then translated by the parent: (1000, 1, 0).
    expect([...placed.positions.slice(0, 3)]).toEqual([1000, 1, 0]);
    // (0,1,0) rotated to (-1,0,0), then translated: (999, 0, 0).
    expect([...placed.positions.slice(3, 6)]).toEqual([999, 0, 0]);
  });

  test('refuses to decode an external tileset as a point tile', async () => {
    const body = doc(rawTile({ refine: 'REPLACE', content: { uri: 'sub/tileset.json' } }));
    const t = fakeTransport({ [ENTRY]: body });
    const opened = await openTileset(ENTRY, t);
    const sel = selectTileContents(opened, farCamera, { maxScreenSpaceErrorPx: 16 });
    await expect(fetchTileContent(sel.externalTilesets[0]!, t)).rejects.toThrow(
      /external tileset, not a point tile/,
    );
  });

  /** The transform case's transport: one tileset document and one two-point tile. */
  function fakeTransform(body: string, url: string): ReturnType<typeof fakeTransport> {
    return fakeTransport(
      { [ENTRY]: body },
      { [url]: makePnts([[1, 2, 3], [4, 5, 6]], [10, 20, 30]) },
    );
  }
});
