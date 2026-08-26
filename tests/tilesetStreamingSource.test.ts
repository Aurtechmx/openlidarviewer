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
import { TilesetStreamingSource, resolveTileUrl } from '../src/render/streaming/TilesetStreamingSource';
import { parseTileset } from '../src/io/tiles3d/tileset';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

function ts(root: unknown) {
  return parseTileset(JSON.stringify({ asset: { version: '1.0' }, geometricError: 100, root }));
}

const TREE = ts({
  boundingVolume: BOX,
  geometricError: 50,
  refine: 'REPLACE',
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
    expect(modes).toContain('rgb');
    expect(modes).not.toContain('intensity');
    expect(modes).not.toContain('classification');
  });
});

describe('addressing a tile', () => {
  it('resolves a content URI against the tileset document, not the host root', () => {
    expect(resolveTileUrl('https://host/data/tileset.json', 'sub/a.pnts')).toBe(
      'https://host/data/sub/a.pnts',
    );
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
