/**
 * tests/tilesetParse.test.ts
 *
 * Coverage for the v0.3.7 3D Tiles tileset.json parser. Pins the
 * required-field set, the three bounding-volume shapes, the refine
 * default, the optional transform / content / children walks, and the
 * tree helpers the streaming scheduler reads through.
 */

import { describe, it, expect } from 'vitest';
import {
  parseTileset,
  walkTiles,
  countTiles,
  type Tile,
  type Tileset,
} from '../src/io/tiles3d/tilesetParse';

// ── fixtures ────────────────────────────────────────────────────────────────

const minimalTilesetText = JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 500,
  root: {
    geometricError: 500,
    boundingVolume: { sphere: [0, 0, 0, 100] },
  },
});

function tilesetWith(rootExtras: Record<string, unknown>): string {
  return JSON.stringify({
    asset: { version: '1.0', tilesetVersion: 'v1.2.3' },
    geometricError: 500,
    root: {
      geometricError: 500,
      boundingVolume: { sphere: [0, 0, 0, 100] },
      ...rootExtras,
    },
  });
}

// ── parseTileset — required fields ──────────────────────────────────────────

describe('parseTileset — required fields', () => {
  it('accepts a minimal tileset with a sphere root', () => {
    const t = parseTileset(minimalTilesetText);
    expect(t.assetVersion).toBe('1.0');
    expect(t.tilesetVersion).toBeNull();
    expect(t.geometricError).toBe(500);
    expect(t.root.boundingVolume.kind).toBe('sphere');
    expect(t.root.children).toHaveLength(0);
  });

  it('propagates `tilesetVersion` when present', () => {
    const t = parseTileset(tilesetWith({}));
    expect(t.tilesetVersion).toBe('v1.2.3');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseTileset('{not json')).toThrow(/not valid JSON/);
  });

  it('throws when `asset` is missing', () => {
    expect(() =>
      parseTileset(
        JSON.stringify({ geometricError: 1, root: { geometricError: 1, boundingVolume: { sphere: [0, 0, 0, 1] } } }),
      ),
    ).toThrow(/asset/);
  });

  it('throws when `asset.version` is missing', () => {
    expect(() =>
      parseTileset(
        JSON.stringify({
          asset: {},
          geometricError: 1,
          root: { geometricError: 1, boundingVolume: { sphere: [0, 0, 0, 1] } },
        }),
      ),
    ).toThrow(/asset\.version/);
  });

  it('throws when root.geometricError is non-finite', () => {
    expect(() =>
      parseTileset(
        JSON.stringify({
          asset: { version: '1.0' },
          geometricError: 1,
          root: { geometricError: NaN, boundingVolume: { sphere: [0, 0, 0, 1] } },
        }),
      ),
    ).toThrow(/geometricError/);
  });

  it('throws when root.boundingVolume is missing', () => {
    expect(() =>
      parseTileset(
        JSON.stringify({
          asset: { version: '1.0' },
          geometricError: 1,
          root: { geometricError: 1 },
        }),
      ),
    ).toThrow(/boundingVolume/);
  });
});

// ── bounding volume shapes ──────────────────────────────────────────────────

describe('parseTileset — bounding volumes', () => {
  it('parses a sphere bounding volume', () => {
    const t = parseTileset(tilesetWith({}));
    expect(t.root.boundingVolume).toEqual({ kind: 'sphere', center: [0, 0, 0], radius: 100 });
  });

  it('parses a region bounding volume (6 numbers)', () => {
    const text = JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 1,
      root: {
        geometricError: 1,
        boundingVolume: { region: [-2, -1, 2, 1, 0, 100] },
      },
    });
    const t = parseTileset(text);
    expect(t.root.boundingVolume.kind).toBe('region');
    if (t.root.boundingVolume.kind === 'region') {
      expect(t.root.boundingVolume.west).toBe(-2);
      expect(t.root.boundingVolume.south).toBe(-1);
      expect(t.root.boundingVolume.east).toBe(2);
      expect(t.root.boundingVolume.north).toBe(1);
      expect(t.root.boundingVolume.minHeight).toBe(0);
      expect(t.root.boundingVolume.maxHeight).toBe(100);
    }
  });

  it('parses a box bounding volume (12 numbers)', () => {
    const text = JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 1,
      root: {
        geometricError: 1,
        boundingVolume: {
          box: [10, 20, 30, 1, 0, 0, 0, 2, 0, 0, 0, 3],
        },
      },
    });
    const t = parseTileset(text);
    expect(t.root.boundingVolume.kind).toBe('box');
    if (t.root.boundingVolume.kind === 'box') {
      expect(t.root.boundingVolume.center).toEqual([10, 20, 30]);
      expect(t.root.boundingVolume.halfAxisX).toEqual([1, 0, 0]);
      expect(t.root.boundingVolume.halfAxisY).toEqual([0, 2, 0]);
      expect(t.root.boundingVolume.halfAxisZ).toEqual([0, 0, 3]);
    }
  });

  it('throws when the bounding volume is none of region / box / sphere', () => {
    const text = JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 1,
      root: {
        geometricError: 1,
        boundingVolume: { region: [1, 2, 3] }, // wrong length
      },
    });
    expect(() => parseTileset(text)).toThrow(/region|box|sphere/);
  });
});

// ── refine, transform, content ──────────────────────────────────────────────

describe('parseTileset — refine / transform / content', () => {
  it('defaults refine to REPLACE when omitted', () => {
    const t = parseTileset(minimalTilesetText);
    expect(t.root.refine).toBe('REPLACE');
  });

  it('accepts refine = ADD', () => {
    const t = parseTileset(tilesetWith({ refine: 'ADD' }));
    expect(t.root.refine).toBe('ADD');
  });

  it('throws on an invalid refine value', () => {
    expect(() => parseTileset(tilesetWith({ refine: 'MAYBE' }))).toThrow(/refine/);
  });

  it('parses a 16-element transform when present', () => {
    const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
    const t = parseTileset(tilesetWith({ transform }));
    expect(t.root.transform).toEqual(transform);
  });

  it('rejects a transform of wrong length', () => {
    expect(() => parseTileset(tilesetWith({ transform: [1, 2, 3] }))).toThrow(/transform/);
  });

  it('leaves transform null when omitted', () => {
    const t = parseTileset(minimalTilesetText);
    expect(t.root.transform).toBeNull();
  });

  it('parses content.uri', () => {
    const t = parseTileset(tilesetWith({ content: { uri: 'tile.pnts' } }));
    expect(t.root.content?.uri).toBe('tile.pnts');
  });

  it('falls back to legacy content.url when uri is absent', () => {
    const t = parseTileset(tilesetWith({ content: { url: 'tile.pnts' } }));
    expect(t.root.content?.uri).toBe('tile.pnts');
  });

  it('rejects content without uri or url', () => {
    expect(() => parseTileset(tilesetWith({ content: {} }))).toThrow(/uri/);
  });

  it('parses an optional bounding volume on content', () => {
    const t = parseTileset(
      tilesetWith({
        content: { uri: 'a.pnts', boundingVolume: { sphere: [1, 2, 3, 4] } },
      }),
    );
    expect(t.root.content?.boundingVolume?.kind).toBe('sphere');
  });
});

// ── children walk ──────────────────────────────────────────────────────────

describe('parseTileset — children walk', () => {
  it('parses a 2-level tree of children', () => {
    const text = JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 1000,
      root: {
        geometricError: 1000,
        boundingVolume: { sphere: [0, 0, 0, 1000] },
        children: [
          {
            geometricError: 500,
            boundingVolume: { sphere: [-100, 0, 0, 500] },
            children: [
              {
                geometricError: 250,
                boundingVolume: { sphere: [-150, 0, 0, 250] },
              },
            ],
          },
          {
            geometricError: 500,
            boundingVolume: { sphere: [100, 0, 0, 500] },
          },
        ],
      },
    });
    const t = parseTileset(text);
    expect(t.root.children).toHaveLength(2);
    expect(t.root.children[0].children).toHaveLength(1);
    expect(t.root.children[0].children[0].geometricError).toBe(250);
  });

  it('rejects a children field that is not an array', () => {
    expect(() => parseTileset(tilesetWith({ children: 'nope' }))).toThrow(/children/);
  });
});

// ── tree helpers ───────────────────────────────────────────────────────────

describe('walkTiles + countTiles', () => {
  function buildSample(): Tileset {
    return parseTileset(
      JSON.stringify({
        asset: { version: '1.0' },
        geometricError: 1,
        root: {
          geometricError: 1,
          boundingVolume: { sphere: [0, 0, 0, 1] },
          children: [
            {
              geometricError: 1,
              boundingVolume: { sphere: [0, 0, 0, 1] },
            },
            {
              geometricError: 1,
              boundingVolume: { sphere: [0, 0, 0, 1] },
              children: [
                {
                  geometricError: 1,
                  boundingVolume: { sphere: [0, 0, 0, 1] },
                },
              ],
            },
          ],
        },
      }),
    );
  }

  it('countTiles returns the total node count (root + descendants)', () => {
    expect(countTiles(buildSample().root)).toBe(4);
  });

  it('walkTiles visits root first, then descendants pre-order', () => {
    const order: number[] = [];
    let counter = 0;
    const wrap = (t: Tile): Tile => {
      const tagged = t as Tile & { __id?: number };
      tagged.__id = counter++;
      return tagged;
    };
    const root = wrap(buildSample().root);
    for (const child of root.children) {
      wrap(child);
      for (const grand of child.children) wrap(grand);
    }
    walkTiles(root, (t) => {
      const tagged = t as Tile & { __id?: number };
      if (tagged.__id != null) order.push(tagged.__id);
    });
    expect(order[0]).toBe(0); // root first
    expect(order).toHaveLength(4);
  });

  it('walkTiles passes a depth integer (0 at root, increments per level)', () => {
    const depths: number[] = [];
    walkTiles(buildSample().root, (_t, depth) => {
      depths.push(depth);
    });
    expect(depths[0]).toBe(0); // root
    expect(Math.max(...depths)).toBe(2); // 2-level deep child
  });
});
