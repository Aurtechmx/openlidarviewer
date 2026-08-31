/**
 * tiles3dExternalTilesets.test.ts — following a tile whose content is another
 * `tileset.json`.
 *
 * The reader used to classify a `.json` content as an external tileset and
 * refuse to follow it, so a set split across several documents opened as "a
 * tile this reader cannot serve". `expandExternalTilesets` fetches each
 * referenced document and splices its root in as a child before the tree is
 * parsed, with the same fan-out / depth / cycle ceilings the implicit expander
 * carries. These cases pin the splice, the resolution base, and every refusal.
 */

import { describe, it, expect } from 'vitest';
import {
  expandExternalTilesets,
  MAX_EXTERNAL_DEPTH,
} from '../src/io/tiles3d/externalTilesets';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };
const ENTRY = 'https://tiles.example.com/city/tileset.json';

/** An expander over a fixed map of URL → document text; records what it fetched. */
function expanderOver(docs: Record<string, object>) {
  const fetched: string[] = [];
  const fetchTilesetJson = async (url: string): Promise<string> => {
    fetched.push(url);
    const doc = docs[url];
    if (doc === undefined) throw new Error(`test: no document at ${url}`);
    return JSON.stringify(doc);
  };
  const fetchSubtreeBytes = async (): Promise<ArrayBuffer> => {
    throw new Error('test: no subtree fetch expected');
  };
  const run = (root: object): Promise<object> =>
    expandExternalTilesets(
      { asset: { version: '1.1' }, geometricError: 100, root },
      { entryUrl: ENTRY, fetchTilesetJson, fetchSubtreeBytes },
    );
  return { run, fetched };
}

/** A minimal external tileset document whose root is one point tile. */
function externalDoc(uri: string): object {
  return {
    asset: { version: '1.1' },
    geometricError: 50,
    root: { boundingVolume: BOX, geometricError: 10, refine: 'ADD', content: { uri } },
  };
}

describe('expandExternalTilesets', () => {
  it('splices a referenced document root in as a child and drops the .json content', async () => {
    const { run, fetched } = expanderOver({
      'https://tiles.example.com/city/child.json': externalDoc('leaf.pnts'),
    });
    const out = (await run({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'ADD',
      content: { uri: 'child.json' },
    })) as { root: { content?: unknown; contents?: unknown; children: { content: { uri: string } }[] } };

    expect(fetched).toEqual(['https://tiles.example.com/city/child.json']);
    // The .json content is gone; the external root is now a child point tile.
    expect(out.root.content).toBeUndefined();
    expect(out.root.contents).toBeUndefined();
    expect(out.root.children).toHaveLength(1);
    expect(out.root.children[0].content.uri).toBe('leaf.pnts');

    // And the spliced tree parses and walks to a servable node.
    const nodes = tilesetNodes(parseTileset(out), undefined, ENTRY);
    expect(nodes.records.map((r) => r.id)).toEqual(['leaf.pnts']);
  });

  it('keeps a point content on a tile that also references an external tileset', async () => {
    const { run } = expanderOver({
      'https://tiles.example.com/city/child.json': externalDoc('leaf.pnts'),
    });
    const out = (await run({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'ADD',
      contents: [{ uri: 'here.pnts' }, { uri: 'child.json' }],
    })) as { root: { content: { uri: string }; children: unknown[] } };

    // The point content survives as the tile's own content; the external became a child.
    expect(out.root.content.uri).toBe('here.pnts');
    expect(out.root.children).toHaveLength(1);
  });

  it('resolves a nested reference against the referenced document, not the entry', async () => {
    const { run, fetched } = expanderOver({
      'https://tiles.example.com/city/deep/a.json': {
        asset: { version: '1.1' },
        geometricError: 50,
        root: { boundingVolume: BOX, geometricError: 10, refine: 'ADD', content: { uri: 'b.json' } },
      },
      // `b.json` is named relatively by a.json, so it must resolve under deep/.
      'https://tiles.example.com/city/deep/b.json': externalDoc('leaf.pnts'),
    });
    await run({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'ADD',
      content: { uri: 'deep/a.json' },
    });
    expect(fetched).toEqual([
      'https://tiles.example.com/city/deep/a.json',
      'https://tiles.example.com/city/deep/b.json',
    ]);
  });

  it('refuses a reference cycle rather than following it forever', async () => {
    const { run } = expanderOver({
      'https://tiles.example.com/city/a.json': {
        asset: { version: '1.1' },
        geometricError: 50,
        root: { boundingVolume: BOX, geometricError: 10, refine: 'ADD', content: { uri: 'a.json' } },
      },
    });
    await expect(
      run({ boundingVolume: BOX, geometricError: 50, refine: 'ADD', content: { uri: 'a.json' } }),
    ).rejects.toThrow(/cycle/i);
  });

  it('refuses a chain that nests past the external-depth ceiling', async () => {
    // Each document references the next; more of them than the ceiling allows.
    const docs: Record<string, object> = {};
    for (let i = 0; i <= MAX_EXTERNAL_DEPTH + 1; i++) {
      const next = `https://tiles.example.com/city/n${i + 1}.json`;
      docs[`https://tiles.example.com/city/n${i}.json`] = {
        asset: { version: '1.1' },
        geometricError: 50,
        root: {
          boundingVolume: BOX,
          geometricError: 10,
          refine: 'ADD',
          content: { uri: `n${i + 1}.json` },
        },
      };
      if (i === MAX_EXTERNAL_DEPTH + 1) docs[next] = externalDoc('leaf.pnts');
    }
    const { run } = expanderOver(docs);
    await expect(
      run({ boundingVolume: BOX, geometricError: 50, refine: 'ADD', content: { uri: 'n0.json' } }),
    ).rejects.toThrow(/deeper than/i);
  });

  it('refuses an external URI that escapes the tileset origin', async () => {
    const { run } = expanderOver({});
    await expect(
      run({
        boundingVolume: BOX,
        geometricError: 50,
        refine: 'ADD',
        content: { uri: 'https://attacker.example.net/evil.json' },
      }),
    ).rejects.toThrow(/external tileset/i);
  });

  it('leaves a document with no external references untouched and fetches nothing', async () => {
    const { run, fetched } = expanderOver({});
    const root = {
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'ADD',
      content: { uri: 'leaf.pnts' },
    };
    const out = (await run(root)) as { root: unknown };
    expect(fetched).toEqual([]);
    expect(out.root).toEqual(root);
  });
});
