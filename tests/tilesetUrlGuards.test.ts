/**
 * tilesetUrlGuards.test.ts — a tileset.json is an untrusted document that names
 * URLs this viewer will request.
 *
 * The merged reader resolved every content URI through
 * `resolveTilesetContentUrl`, which refuses a non-http scheme, embedded
 * credentials, a private-network host, a different origin from the tileset, and
 * a path escaping the tileset's directory. The streaming reader that replaced it
 * resolved with a bare `new URL(uri, base)` and fetched whatever came out, so a
 * document could direct the viewer at a cloud metadata endpoint or an arbitrary
 * host and the transport, which validates nothing, would go there.
 *
 * These cases are written against the index rather than the validator, because
 * the validator was never the thing that was missing.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const ENTRY = 'https://tiles.example.com/city/tileset.json';

/** A tileset whose one child names `uri` as its content. */
function withContent(uri: string) {
  return parseTileset(
    JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 100,
      root: {
        boundingVolume: BOX,
        geometricError: 50,
        refine: 'REPLACE',
        content: { uri: 'ok.pnts' },
        children: [{ boundingVolume: BOX, geometricError: 10, content: { uri } }],
      },
    }),
  );
}

const idx = (uri: string) => tilesetNodes(withContent(uri), undefined, ENTRY);

describe('a content URI this viewer must not request', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data/iam/', 'a cloud metadata address'],
    ['https://attacker.example.net/collect.pnts', 'another origin'],
    ['file:///etc/passwd', 'a local file'],
    ['https://user:pw@tiles.example.com/city/a.pnts', 'embedded credentials'],
    ['../../../secrets/a.pnts', 'a path outside the tileset directory'],
  ])('refuses %s (%s), and fetches nothing', (uri) => {
    const built = idx(uri);
    const targets = [...built.contentUri.values()].join(' ');
    expect(
      built.records.map((r) => r.id),
      'the refused content became a node, so the viewer would have requested it',
    ).toEqual(['ok.pnts']);
    expect(targets).not.toContain('169.254');
    expect(targets).not.toContain('attacker');
    expect(targets).not.toContain('file:');
    // The fixture's root refines by REPLACE, which is refused separately, so
    // assert the URL refusal specifically rather than counting skips.
    expect(built.skipped.some((r) => r.startsWith(uri))).toBe(true);
  });

  it('serves an ordinary relative URI, resolved to an absolute URL', () => {
    const built = idx('sub/b.pnts');
    expect(built.records.map((r) => r.id)).toEqual(['ok.pnts', 'sub/b.pnts']);
    expect(built.contentUri.get('sub/b.pnts')).toBe(
      'https://tiles.example.com/city/sub/b.pnts',
    );
  });

  it('hands the transport an absolute URL, never the authored text', () => {
    // The authored URI is relative; anything that reached the transport as
    // written would be resolved a second time, against whatever base it held.
    for (const url of idx('sub/b.pnts').contentUri.values()) {
      expect(url.startsWith('https://')).toBe(true);
    }
  });
});

describe('a tile carrying several 3D Tiles 1.1 contents', () => {
  it('emits one node per content, each resolved independently', () => {
    const tileset = parseTileset(
      JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 100,
        root: {
          boundingVolume: BOX,
          geometricError: 50,
          refine: 'ADD',
          contents: [{ uri: 'a.pnts' }, { uri: 'sub/b.pnts' }],
        },
      }),
    );
    const built = tilesetNodes(tileset, undefined, ENTRY);
    expect(built.records.map((r) => r.id)).toEqual(['a.pnts', 'sub/b.pnts']);
    expect(built.contentUri.get('a.pnts')).toBe('https://tiles.example.com/city/a.pnts');
    expect(built.contentUri.get('sub/b.pnts')).toBe(
      'https://tiles.example.com/city/sub/b.pnts',
    );
  });
});
