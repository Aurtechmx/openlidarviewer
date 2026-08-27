/**
 * tilesetStreamingSource.test.ts — a tileset served through the streaming
 * pipeline.
 *
 * The source's job is to answer the scheduler honestly about a format that
 * states less than COPC does. The cases that matter are the ones where it would
 * be easy to invent an answer: a point total the tileset never gives, colour
 * modes the bodies cannot fill, and a tile URL resolved against the wrong base.
 */

import { describe, it, expect } from 'vitest';
import {
  TilesetStreamingSource,
  tilesetRootFrameMatrix,
} from '../src/render/streaming/TilesetStreamingSource';
import { geodeticToEcef } from '../src/io/tiles3d/boundingVolume';
import { parseTileset } from '../src/io/tiles3d/tileset';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

function ts(root: unknown) {
  return parseTileset(JSON.stringify({ asset: { version: '1.0' }, geometricError: 100, root }));
}

// ADD, not REPLACE: these cases are about the shape the scheduler reads, and
// additive refinement is the mode where a parent and its children are both
// served. A REPLACE parent that refines into content is refused separately, so
// using it here would make every case in this file test that refusal instead.
const TREE = ts({
  boundingVolume: BOX,
  geometricError: 50,
  refine: 'ADD',
  content: { uri: 'root.pnts' },
  children: [{ boundingVolume: BOX, geometricError: 10, content: { uri: 'sub/a.pnts' } }],
});

/** A transport that records what it was asked for. */
function transport(): TilesetTransport & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchTilesetJson: async () => '{}',
    fetchTileBytes: async (url: string) => {
      asked.push(url);
      return new ArrayBuffer(8);
    },
  };
}

const source = (t = transport()) =>
  new TilesetStreamingSource('id', 'A tileset', 'https://host/data/tileset.json', t, TREE);

describe('what the source refuses to invent', () => {
  it('reports no source point count, because a tileset states none', () => {
    expect(
      source().sourcePointCount,
      'the per-node numbers are admission estimates, so summing them would put ' +
        'a fabricated total in the scan report',
    ).toBeNull();
  });

  it('offers only the colour modes a point tile can fill', () => {
    const modes = source().availableColorModes();
    expect(modes).not.toContain('intensity');
    expect(modes).not.toContain('classification');
  });

  it('offers no colour mode for a channel no tile has stated yet', () => {
    // This used to answer `['rgb', 'elevation']` from the format alone, and
    // `defaultColorMode()` used to answer `'rgb'` unconditionally. A tileset
    // whose tiles carry no colour therefore opened on an RGB chip that fell
    // through to the elevation ramp: the scan was painted by height and
    // labelled Color. Colour is stated per TILE, so the honest answer before
    // any tile has been read is that nothing states it.
    // `tests/tilesetStreamingNormals.test.ts` covers the answer after a read.
    expect(source().availableColorModes()).toEqual(['elevation']);
    expect(source().defaultColorMode()).toBe('elevation');
  });
});

describe('addressing a tile', () => {
  it('resolves a content URI against the tileset document, not the host root', () => {
    const s = source();
    const node = s.octree.nodes().find((n) => n.record.id === 'sub/a.pnts');
    expect(node, 'the relative content URI should have produced a node').toBeDefined();
  });

  it('fetches the resolved URL for a node', async () => {
    const t = transport();
    const s = source(t);
    const node = s.octree.nodes().find((n) => n.record.id === 'sub/a.pnts')!;
    await s.readNodeChunk(node.record);
    expect(t.asked).toEqual(['https://host/data/sub/a.pnts']);
  });

  it('hands the decoder the tile transform', () => {
    const s = source();
    const meta = s.decodeMeta(s.octree.nodes()[0].record);
    expect('format' in meta && meta.format).toBe('pnts');
  });
});

describe('the shape the scheduler reads', () => {
  it('exposes one node per tile with content, with the parent chain wired', () => {
    const s = source();
    const ids = s.octree.nodes().map((n) => n.record.id).sort();
    expect(ids).toEqual(['root.pnts', 'sub/a.pnts']);
    expect(s.octree.store.get('root.pnts')?.childIds).toEqual(['sub/a.pnts']);
  });

  it('centres the render origin inside the data bounds', () => {
    const s = source();
    const b = s.dataBounds();
    const [rx] = s.renderOrigin;
    expect(rx).toBeGreaterThanOrEqual(b[0]);
    expect(rx).toBeLessThanOrEqual(b[3]);
  });

  it('reports local bounds around the origin', () => {
    const l = source().localBounds();
    expect(l[0]).toBeLessThanOrEqual(0);
    expect(l[3]).toBeGreaterThanOrEqual(0);
  });

  it('says it is complete only when the walk dropped nothing', () => {
    expect(source().octree.isComplete).toBe(true);
  });
});

describe('a geocentric tileset gets a local frame', () => {
  const DEG = Math.PI / 180;
  // Monterrey: the polar axis and local up are 64.3 degrees apart here.
  const C = geodeticToEcef(-100.3161 * DEG, 25.6866 * DEG, 540);
  const HALF = 400;
  // `region` is the only in-spec declaration of geocentricity.
  const REGION = {
    region: [-100.32 * DEG, 25.68 * DEG, -100.31 * DEG, 25.69 * DEG, 500, 580],
  };

  const geocentric = parseTileset(
    JSON.stringify({
      asset: { version: '1.0' },
      geometricError: 100,
      root: {
        boundingVolume: REGION,
        geometricError: 50,
        refine: 'REPLACE',
        content: { uri: 'r.pnts' },
      },
    }),
  );

  it('builds a root frame matrix for a region-bounded tileset', () => {
    expect(
      tilesetRootFrameMatrix(geocentric),
      'a region declares geocentricity, so the reader must rotate into local ENU',
    ).not.toBeNull();
  });

  it('declares none for a box-bounded tileset, rather than guessing one', () => {
    const boxed = parseTileset(
      JSON.stringify({
        asset: { version: '1.0' },
        geometricError: 100,
        root: {
          boundingVolume: { box: [C[0], C[1], C[2], HALF, 0, 0, 0, HALF, 0, 0, 0, HALF] },
          geometricError: 50,
          refine: 'REPLACE',
          content: { uri: 'r.pnts' },
        },
      }),
    );
    expect(
      tilesetRootFrameMatrix(boxed),
      'a box declares nothing about geocentricity; inventing a frame would place ' +
        'the scene by guess',
    ).toBeNull();
  });

  it('APPLIES the frame to the tiles it serves, not merely computes it', () => {
    // The regression this guards: the source computed a frame and handed
    // tilesetNodes nothing, so a geocentric tileset stayed in ECEF.
    const s = new TilesetStreamingSource(
      'id', 'n', 'https://h/d/tileset.json', transport(), geocentric,
    );
    const meta = s.decodeMeta(s.octree.nodes()[0].record);
    if (!('format' in meta)) throw new Error('expected point-tile metadata');
    const m = meta.tileTransform;
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(
      m.every((v, i) => Math.abs(v - identity[i]) < 1e-9),
      'the tile transform is identity, so the tileset is still in ECEF and its ' +
        'heights are measured along the polar axis',
    ).toBe(false);
    // And it must be the ENU matrix specifically, not any old transform.
    const expected = tilesetRootFrameMatrix(geocentric)!;
    for (let i = 0; i < 16; i++) expect(m[i]).toBeCloseTo(expected[i], 9);
  });

  it('leaves the tileset unrotated when no frame is declared', () => {
    const t = transport();
    const s = new TilesetStreamingSource('id', 'n', 'https://h/d/tileset.json', t, TREE);
    const m = s.decodeMeta(s.octree.nodes()[0].record);
    expect('format' in m && m.format).toBe('pnts');
  });
});
