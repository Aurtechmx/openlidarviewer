/**
 * tiles3dImplicitTiling.test.ts — a tileset that states its hierarchy by rule
 * instead of by JSON.
 *
 * The first test here is the one that had to fail before anything was written.
 * A document declaring `implicitTiling` was refused at parse with "3D Tiles:
 * implicit tiling is not supported yet", so the tilesets that most need
 * streaming, the ones large enough that writing the tree out would be absurd,
 * could not be opened at all.
 *
 * WHAT THESE TESTS PIN, beyond "it opens":
 *
 *   the availability frames    a tile's presence and a child SUBTREE's presence
 *                              are different bitstreams of different lengths,
 *                              and reading one where the other belongs loses or
 *                              invents a whole level
 *   the URL gate               a subtree URI is authored by the same untrusted
 *                              document a content URI is, and is fetched
 *                              earlier, so it goes through the same refusals
 *   the ceilings               a three-hundred-byte document can describe an
 *                              enormous tree; each ceiling refuses by name
 *   the seam                   the expansion is an ordinary explicit document,
 *                              so `parseTileset` and `tilesetNodes` apply every
 *                              refusal they apply to an authored hierarchy
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';
import { resolveTilesetContentUrl } from '../src/io/tiles3d/tilesetUrl';
import {
  expandImplicitTileset,
  MAX_IMPLICIT_SUBTREES,
  MAX_IMPLICIT_TILES,
  type ExpandImplicitOptions,
} from '../src/io/tiles3d/implicitExpand';
import { parseImplicitTiling, substituteTemplateUri } from '../src/io/tiles3d/implicitTiling';
import { makeSubtree, bitstream, ALL_AVAILABLE, NONE_AVAILABLE } from './fixtures/subtree3d';

const ENTRY = 'https://tiles.example/data/tileset.json';
const BASE = 'https://tiles.example/data/';
/** Centred on the origin, eight metres of half-axis on each side. */
const BOX = { box: [0, 0, 0, 8, 0, 0, 0, 8, 0, 0, 0, 8] };

type Bodies = Map<string, ArrayBuffer>;

/** An options object over a fixed set of bodies, recording what was asked for. */
function serve(bodies: Bodies, extra: Partial<ExpandImplicitOptions> = {}) {
  const asked: string[] = [];
  const options: ExpandImplicitOptions = {
    entryUrl: ENTRY,
    fetchSubtreeBytes: async (url: string) => {
      asked.push(url);
      const body = bodies.get(url);
      if (!body) throw new Error(`the test served no body for ${url}`);
      return body;
    },
    ...extra,
  };
  return { options, asked };
}

/** A tileset whose root is implicitly tiled. Overrides go on the root tile. */
function implicitDoc(tiling: object, tile: Record<string, unknown> = {}): object {
  return {
    asset: { version: '1.1' },
    geometricError: 100,
    root: {
      boundingVolume: BOX,
      geometricError: 100,
      refine: 'ADD',
      content: { uri: 'content/{level}/{x}/{y}.pnts' },
      implicitTiling: {
        subdivisionScheme: 'QUADTREE',
        subtreeLevels: 2,
        availableLevels: 2,
        subtrees: { uri: 'subtrees/{level}/{x}/{y}.subtree' },
        ...tiling,
      },
      ...tile,
    },
  };
}

/** One quadtree subtree covering two levels, everything present. */
function fullQuadSubtree(): ArrayBuffer {
  return makeSubtree({
    tileAvailability: ALL_AVAILABLE,
    contentAvailability: ALL_AVAILABLE,
    childSubtreeAvailability: NONE_AVAILABLE,
  });
}

const ROOT_SUBTREE_URL = 'https://tiles.example/data/subtrees/0/0/0.subtree';

describe('3D Tiles implicit tiling: it opens', () => {
  it('expands an implicit quadtree into an explicit hierarchy the parser accepts', async () => {
    const { options, asked } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    expect(asked).toEqual([ROOT_SUBTREE_URL]);
    expect(tileset.root.contentUris[0] ?? null).toBe('content/0/0/0.pnts');
    expect(tileset.root.children.map((c) => c.contentUris[0] ?? null).sort()).toEqual([
      'content/1/0/0.pnts',
      'content/1/0/1.pnts',
      'content/1/1/0.pnts',
      'content/1/1/1.pnts',
    ]);
  });

  it('halves the geometric error once per level, from the implicit root down', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    expect(tileset.root.geometricError).toBe(100);
    for (const child of tileset.root.children) expect(child.geometricError).toBe(50);
  });

  it('subdivides the root box exactly, quarter by quarter', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    // QUADTREE halves x and y and leaves z whole, so each child is a 4x4x8
    // quarter column and the four centres are the four (±4, ±4, 0) corners.
    const centres = tileset.root.children
      .map((c) => (c.boundingVolume.box as number[]).slice(0, 3).join(','))
      .sort();
    expect(centres).toEqual(['-4,-4,0', '-4,4,0', '4,-4,0', '4,4,0']);
    for (const child of tileset.root.children) {
      const box = child.boundingVolume.box as number[];
      expect(box.slice(3)).toEqual([4, 0, 0, 0, 4, 0, 0, 0, 8]);
    }
  });

  it('expands an OCTREE tree, substituting {z} into both templates', async () => {
    const bodies: Bodies = new Map([
      [
        'https://tiles.example/data/s/0/0/0/0.subtree',
        makeSubtree({
          tileAvailability: ALL_AVAILABLE,
          contentAvailability: ALL_AVAILABLE,
          childSubtreeAvailability: NONE_AVAILABLE,
        }),
      ],
    ]);
    const { options } = serve(bodies);
    const doc = implicitDoc(
      {
        subdivisionScheme: 'OCTREE',
        subtrees: { uri: 's/{level}/{x}/{y}/{z}.subtree' },
      },
      { content: { uri: 'c/{level}/{x}/{y}/{z}.pnts' } },
    );
    const tileset = parseTileset(await expandImplicitTileset(doc, options));
    expect(tileset.root.contentUris[0] ?? null).toBe('c/0/0/0/0.pnts');
    expect(tileset.root.children).toHaveLength(8);
    expect(tileset.root.children.map((c) => c.contentUris[0] ?? null)).toContain('c/1/1/1/1.pnts');
    // OCTREE halves all three axes, so every half-axis is four.
    const box = tileset.root.children[0]!.boundingVolume.box as number[];
    expect(box).toEqual([-4, -4, -4, 4, 0, 0, 0, 4, 0, 0, 0, 4]);
  });

  it('subdivides a region volume rather than refusing it', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const doc = implicitDoc({}, { boundingVolume: { region: [-1, -1, 1, 1, 0, 100] } });
    const tileset = parseTileset(await expandImplicitTileset(doc, options));
    const regions = tileset.root.children.map((c) => (c.boundingVolume.region as number[]).join(','));
    // Longitude and latitude halve at zero; the height range stays whole under
    // QUADTREE subdivision.
    expect(regions.sort()).toEqual([
      '-1,-1,0,0,0,100',
      '-1,0,0,1,0,100',
      '0,-1,1,0,0,100',
      '0,0,1,1,0,100',
    ]);
  });

  it('leaves a document that declares no implicit tiling untouched', async () => {
    const explicit = {
      asset: { version: '1.1' },
      geometricError: 100,
      root: { boundingVolume: BOX, geometricError: 10, refine: 'ADD', content: { uri: 'a.pnts' } },
    };
    const { options, asked } = serve(new Map());
    expect(await expandImplicitTileset(explicit, options)).toEqual(explicit);
    expect(asked).toEqual([]);
  });
});

describe('3D Tiles implicit tiling: availability decides what exists', () => {
  it('omits tiles whose availability bit is clear', async () => {
    // Five bits: index 0 is the root, and indices 1..4 are the four level-1
    // children in Morton order, so index 1 + m addresses the child whose Morton
    // index within its level is m. Bits 0 and 2 set means the root, and the
    // child at Morton index 1, which is (x=1, y=0).
    const body = makeSubtree(
      {
        buffers: [{ byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
        tileAvailability: { bitstream: 0 },
        contentAvailability: ALL_AVAILABLE,
        childSubtreeAvailability: NONE_AVAILABLE,
      },
      { binary: bitstream([true, false, true, false, false], 5) },
    );
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, body]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    expect(tileset.root.children.map((c) => c.contentUris[0] ?? null)).toEqual(['content/1/1/0.pnts']);
  });

  it('gives a tile no content when only its content bit is clear', async () => {
    const body = makeSubtree(
      {
        buffers: [{ byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
        tileAvailability: ALL_AVAILABLE,
        contentAvailability: [{ bitstream: 0 }],
        childSubtreeAvailability: NONE_AVAILABLE,
      },
      // The root has no content; all four children do.
      { binary: bitstream([false, true, true, true, true], 5) },
    );
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, body]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    expect(tileset.root.contentUris).toEqual([]);
    expect(tileset.root.children).toHaveLength(4);
    expect(tileset.root.children.every((c) => c.contentUris.length > 0)).toBe(true);
  });

  it('follows an available child subtree into a second subtree file', async () => {
    // Two levels per subtree, four levels in the tree. The root subtree covers
    // levels 0 and 1; the child subtree it names covers levels 2 and 3.
    const root = makeSubtree(
      {
        buffers: [{ byteLength: 2 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }],
        tileAvailability: ALL_AVAILABLE,
        contentAvailability: ALL_AVAILABLE,
        childSubtreeAvailability: { bitstream: 0 },
      },
      // Sixteen child-subtree roots at level 2; only Morton index 0, which is
      // (x=0, y=0), is available.
      { binary: bitstream([true], 16) },
    );
    const child = makeSubtree({
      tileAvailability: ALL_AVAILABLE,
      contentAvailability: ALL_AVAILABLE,
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    const bodies: Bodies = new Map([
      [ROOT_SUBTREE_URL, root],
      ['https://tiles.example/data/subtrees/2/0/0.subtree', child],
    ]);
    const { options, asked } = serve(bodies);
    const tileset = parseTileset(
      await expandImplicitTileset(implicitDoc({ availableLevels: 4 }), options),
    );
    expect(asked).toEqual([
      ROOT_SUBTREE_URL,
      'https://tiles.example/data/subtrees/2/0/0.subtree',
    ]);
    const level1 = tileset.root.children;
    expect(level1).toHaveLength(4);
    // Only the (0,0) branch continues; the other three level-1 tiles are leaves.
    const withChildren = level1.filter((c) => c.children.length > 0);
    expect(withChildren).toHaveLength(1);
    expect(withChildren[0]!.contentUris[0] ?? null).toBe('content/1/0/0.pnts');
    const level2 = withChildren[0]!.children;
    expect(level2.map((c) => c.contentUris[0] ?? null)).toEqual(['content/2/0/0.pnts']);
    expect(level2[0]!.children.map((c) => c.contentUris[0] ?? null).sort()).toEqual([
      'content/3/0/0.pnts',
      'content/3/0/1.pnts',
      'content/3/1/0.pnts',
      'content/3/1/1.pnts',
    ]);
    // Ten tiles: 1 + 4 + 1 + 4, and the geometric error still halves per level.
    expect(level2[0]!.geometricError).toBe(25);
    expect(level2[0]!.children[0]!.geometricError).toBe(12.5);
  });

  it('stops at availableLevels rather than descending past the tree it declares', async () => {
    const { options, asked } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    // availableLevels 1 means the tree is the root alone, so the level-1 bits
    // in the subtree describe tiles the document says are not addressable.
    const tileset = parseTileset(
      await expandImplicitTileset(implicitDoc({ availableLevels: 1 }), options),
    );
    expect(tileset.root.children).toEqual([]);
    expect(asked).toEqual([ROOT_SUBTREE_URL]);
  });

  it('leaves an implicit root with no tree when its own availability bit is clear', async () => {
    const body = makeSubtree(
      {
        buffers: [{ byteLength: 1 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
        tileAvailability: { bitstream: 0 },
        contentAvailability: ALL_AVAILABLE,
        childSubtreeAvailability: NONE_AVAILABLE,
      },
      { binary: bitstream([false, true, true, true, true], 5) },
    );
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, body]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    expect(tileset.root.contentUris).toEqual([]);
    expect(tileset.root.children).toEqual([]);
  });

  it('refuses a child subtree its parent promised but whose own root is absent', async () => {
    const root = makeSubtree(
      {
        buffers: [{ byteLength: 2 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }],
        tileAvailability: ALL_AVAILABLE,
        childSubtreeAvailability: { bitstream: 0 },
      },
      { binary: bitstream([true], 16) },
    );
    const child = makeSubtree({
      tileAvailability: NONE_AVAILABLE,
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    const { options } = serve(
      new Map([
        [ROOT_SUBTREE_URL, root],
        ['https://tiles.example/data/subtrees/2/0/0.subtree', child],
      ]),
    );
    await expect(
      expandImplicitTileset(implicitDoc({ availableLevels: 4 }), options),
    ).rejects.toThrow(/declared available by its parent but states its own root tile is not/);
  });
});

describe('3D Tiles implicit tiling: external availability buffers', () => {
  const subtreeWithExternal = (uri: string) =>
    makeSubtree({
      buffers: [{ uri, byteLength: 1 }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 1 }],
      tileAvailability: { bitstream: 0 },
      contentAvailability: ALL_AVAILABLE,
      childSubtreeAvailability: NONE_AVAILABLE,
    });

  it('fetches a buffer named beside the subtree file and reads availability from it', async () => {
    const bits = bitstream([true, false, true, false, false], 5);
    const bodies: Bodies = new Map([
      [ROOT_SUBTREE_URL, subtreeWithExternal('availability.bin')],
      [
        'https://tiles.example/data/subtrees/0/0/availability.bin',
        bits.buffer.slice(0, 1) as ArrayBuffer,
      ],
    ]);
    const { options, asked } = serve(bodies);
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    // The buffer URI is relative to the SUBTREE file, not to the tileset root.
    expect(asked[1]).toBe('https://tiles.example/data/subtrees/0/0/availability.bin');
    // Bits 0 and 2 set: the root, and the level-1 child at Morton index 1,
    // which is (x=1, y=0).
    expect(tileset.root.children.map((c) => c.contentUris[0] ?? null)).toEqual(['content/1/1/0.pnts']);
  });

  it('refuses an availability buffer that escapes the tileset directory', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, subtreeWithExternal('../../../../secret.bin')]]));
    await expect(expandImplicitTileset(implicitDoc({}), options)).rejects.toThrow(
      /escapes the tileset directory \(\/secret\.bin\)/,
    );
  });

  it('refuses an availability buffer on another host', async () => {
    const { options } = serve(
      new Map([[ROOT_SUBTREE_URL, subtreeWithExternal('https://evil.example/a.bin')]]),
    );
    await expect(expandImplicitTileset(implicitDoc({}), options)).rejects.toThrow(
      /points outside the tileset's own host \(evil\.example\)/,
    );
  });
});

describe('3D Tiles implicit tiling: subtree URLs go through the tile-content gate', () => {
  /** What `resolveTilesetContentUrl` says about the same URI, for comparison. */
  function explicitRefusal(uri: string): string {
    const check = resolveTilesetContentUrl(BASE, uri);
    if (check.ok) throw new Error(`${uri} was not refused on the explicit path`);
    return check.reason;
  }

  const cases: readonly { readonly name: string; readonly template: string }[] = [
    { name: 'another host', template: 'https://evil.example/s/{level}/{x}/{y}.subtree' },
    { name: 'a protocol-relative host', template: '//evil.example/s/{level}/{x}/{y}.subtree' },
    { name: 'a directory escape', template: '../../../etc/{level}/{x}/{y}.subtree' },
    { name: 'a data: payload', template: 'data:application/octet-stream,{level}{x}{y}' },
    {
      name: 'embedded credentials',
      template: 'https://user:secret@tiles.example/data/s/{level}/{x}/{y}.subtree',
    },
  ];

  for (const { name, template } of cases) {
    it(`refuses a subtree URI naming ${name}, with the refusal the explicit path gives`, async () => {
      const { options, asked } = serve(new Map());
      // The template substituted at the root coordinate is what would be fetched.
      const substituted = substituteTemplateUri(template, 'QUADTREE', { level: 0, x: 0, y: 0 });
      const reason = explicitRefusal(substituted);
      await expect(
        expandImplicitTileset(implicitDoc({ subtrees: { uri: template } }), options),
      ).rejects.toThrow(reason);
      // Refused before a byte is requested, not after.
      expect(asked).toEqual([]);
    });
  }

  it('refuses a subtree URI longer than the content-URI ceiling', async () => {
    const template = `${'a'.repeat(2048)}/{level}/{x}/{y}.subtree`;
    const { options, asked } = serve(new Map());
    await expect(
      expandImplicitTileset(implicitDoc({ subtrees: { uri: template } }), options),
    ).rejects.toThrow(/longer than 1024 characters/);
    expect(asked).toEqual([]);
  });

  it('carries the entry URL query onto subtree requests, as tile requests carry it', async () => {
    const bodies: Bodies = new Map([
      [`${ROOT_SUBTREE_URL}?token=abc`, fullQuadSubtree()],
    ]);
    const { options, asked } = serve(bodies, { entryUrl: `${ENTRY}?token=abc` });
    await expandImplicitTileset(implicitDoc({}), options);
    expect(asked).toEqual([`${ROOT_SUBTREE_URL}?token=abc`]);
  });
});

describe('3D Tiles implicit tiling: ceilings refuse rather than truncate', () => {
  it('refuses more subtree files than the ceiling, and says the ceiling', async () => {
    const root = makeSubtree(
      {
        buffers: [{ byteLength: 2 }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 }],
        tileAvailability: ALL_AVAILABLE,
        childSubtreeAvailability: { bitstream: 0 },
      },
      { binary: bitstream([true, true], 16) },
    );
    const child = makeSubtree({
      tileAvailability: ALL_AVAILABLE,
      childSubtreeAvailability: NONE_AVAILABLE,
    });
    const bodies: Bodies = new Map([
      [ROOT_SUBTREE_URL, root],
      ['https://tiles.example/data/subtrees/2/0/0.subtree', child],
      ['https://tiles.example/data/subtrees/2/1/0.subtree', child],
    ]);
    const { options } = serve(bodies, { maxSubtrees: 2 });
    await expect(
      expandImplicitTileset(implicitDoc({ availableLevels: 4 }), options),
    ).rejects.toThrow(/needs more than 2 subtree files; refusing to expand it/);
  });

  it('refuses an expansion larger than the tile ceiling, and says the ceiling', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]), { maxTiles: 3 });
    await expect(expandImplicitTileset(implicitDoc({}), options)).rejects.toThrow(
      /expands to more than 3 tiles; refusing to expand it/,
    );
  });

  it('refuses a subtree body larger than the byte ceiling, and says the ceiling', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]), {
      maxSubtreeBytes: 16,
    });
    await expect(expandImplicitTileset(implicitDoc({}), options)).rejects.toThrow(
      /bytes, above the ceiling of 16; refusing to read it/,
    );
  });

  it('states the shipped ceilings, so a change to one is a change to this test', () => {
    expect(MAX_IMPLICIT_SUBTREES).toBe(512);
    expect(MAX_IMPLICIT_TILES).toBe(100_000);
  });

  it('refuses an availableLevels above the expansion ceiling', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    await expect(
      expandImplicitTileset(implicitDoc({ availableLevels: 25 }), options),
    ).rejects.toThrow(/25 availableLevels, above the ceiling of 24; refusing to expand it/);
  });
});

describe('3D Tiles implicit tiling: forms refused by name', () => {
  const refuse = async (doc: object, pattern: RegExp, bodies: Bodies = new Map()) => {
    const { options } = serve(bodies);
    await expect(expandImplicitTileset(doc, options)).rejects.toThrow(pattern);
  };

  it('refuses a sphere bounding volume, which has no exact subdivision', async () => {
    await refuse(
      implicitDoc({}, { boundingVolume: { sphere: [0, 0, 0, 10] } }),
      /sphere bounding volume, which has no exact subdivision/,
    );
  });

  it('refuses a tile that declares both implicitTiling and children', async () => {
    await refuse(
      implicitDoc({}, { children: [{ boundingVolume: BOX, geometricError: 1 }] }),
      /both implicitTiling and children, which state two different hierarchies/,
    );
  });

  it('refuses an implicit tile with no content template', async () => {
    const doc = implicitDoc({}) as { root: Record<string, unknown> };
    delete doc.root.content;
    await refuse(doc, /names no content template/);
  });

  it('refuses a subdivision scheme that is neither QUADTREE nor OCTREE', async () => {
    await refuse(
      implicitDoc({ subdivisionScheme: 'KDTREE' }),
      /subdivisionScheme "KDTREE", which is not QUADTREE or OCTREE/,
    );
  });

  it('names the extension maximumLevel spelling rather than reading it as availableLevels', () => {
    expect(() =>
      parseImplicitTiling({
        subdivisionScheme: 'QUADTREE',
        subtreeLevels: 2,
        maximumLevel: 3,
        subtrees: { uri: 's/{level}/{x}/{y}.subtree' },
      }),
    ).toThrow(/`maximumLevel` rather than 1.1's `availableLevels`/);
  });

  it('refuses an implicitTiling with no subtrees URI', () => {
    expect(() =>
      parseImplicitTiling({ subdivisionScheme: 'QUADTREE', subtreeLevels: 2, availableLevels: 2 }),
    ).toThrow(/subtrees.uri is not a non-empty string/);
  });

  it('refuses subtreeLevels below one', () => {
    expect(() =>
      parseImplicitTiling({
        subdivisionScheme: 'QUADTREE',
        subtreeLevels: 0,
        availableLevels: 2,
        subtrees: { uri: 's/{level}.subtree' },
      }),
    ).toThrow(/subtreeLevels is not an integer of at least 1/);
  });
});

describe('3D Tiles implicit tiling: template substitution', () => {
  it('substitutes each placeholder with its decimal ordinate', () => {
    expect(
      substituteTemplateUri('t/{level}-{x}-{y}.pnts', 'QUADTREE', { level: 3, x: 5, y: 7 }),
    ).toBe('t/3-5-7.pnts');
    expect(
      substituteTemplateUri('t/{level}/{x}/{y}/{z}.pnts', 'OCTREE', {
        level: 2,
        x: 1,
        y: 2,
        z: 3,
      }),
    ).toBe('t/2/1/2/3.pnts');
  });

  it('substitutes a placeholder that appears more than once', () => {
    expect(substituteTemplateUri('{level}/{level}/{x}.pnts', 'QUADTREE', { level: 4, x: 1, y: 0 })).toBe(
      '4/4/1.pnts',
    );
  });

  it('refuses {z} in a QUADTREE template, which has no z to substitute', () => {
    expect(() =>
      substituteTemplateUri('t/{level}/{x}/{y}/{z}.pnts', 'QUADTREE', { level: 1, x: 0, y: 0 }),
    ).toThrow(/substitutes \{z\}, which a QUADTREE coordinate does not have/);
  });

  it('refuses a placeholder it does not substitute rather than fetching it literally', () => {
    expect(() =>
      substituteTemplateUri('t/{level}/{face}.pnts', 'QUADTREE', { level: 1, x: 0, y: 0 }),
    ).toThrow(/carries the placeholder "\{face\}", which this reader does not substitute/);
  });

  it('refuses a template with no placeholder at all', () => {
    expect(() => substituteTemplateUri('t/all.pnts', 'QUADTREE', { level: 0, x: 0, y: 0 })).toThrow(
      /names one file for the whole tree/,
    );
  });
});

describe('3D Tiles implicit tiling: the seam with the explicit reader', () => {
  it('still refuses an unexpanded implicit document at parse', () => {
    expect(() => parseTileset(implicitDoc({}))).toThrow(/implicit tiling/);
  });

  it('builds the same node index an authored hierarchy would', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const tileset = parseTileset(await expandImplicitTileset(implicitDoc({}), options));
    const index = tilesetNodes(tileset, undefined, ENTRY);
    expect(index.skipped).toEqual([]);
    expect(index.records).toHaveLength(5);
    // Depth, parentage and the resolved absolute URL are what the scheduler
    // reads; none of them can tell an expanded tile from an authored one.
    expect(index.records[0]!.depth).toBe(0);
    expect(index.records[1]!.parentId).toBe('content/0/0/0.pnts');
    expect(index.contentUri.get('content/1/1/1.pnts')).toBe(
      'https://tiles.example/data/content/1/1/1.pnts',
    );
  });

  it('applies the parser tile ceiling to an expansion, as it does to an authored tree', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const expanded = await expandImplicitTileset(implicitDoc({}), options);
    expect(() => parseTileset(expanded, { maxTiles: 3 })).toThrow(
      /more than 3 tiles; refusing to parse it/,
    );
  });

  it('reports an expanded content URI that leaves the tileset, rather than fetching it', async () => {
    const { options } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]));
    const doc = implicitDoc({}, { content: { uri: 'https://evil.example/{level}/{x}/{y}.pnts' } });
    const tileset = parseTileset(await expandImplicitTileset(doc, options));
    const index = tilesetNodes(tileset, undefined, ENTRY);
    expect(index.records).toHaveLength(0);
    expect(index.skipped[0]).toMatch(/points outside the tileset's own host/);
  });

  it('stops on an aborted signal before it fetches anything', async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, asked } = serve(new Map([[ROOT_SUBTREE_URL, fullQuadSubtree()]]), {
      signal: controller.signal,
    });
    await expect(expandImplicitTileset(implicitDoc({}), options)).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});
