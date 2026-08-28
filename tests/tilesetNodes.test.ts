/**
 * tilesetNodes.test.ts — a tileset seen as streaming nodes.
 *
 * The interesting decisions are the ones the format does not settle: what a
 * tile's point count is before its body is read, which tiles become nodes at
 * all, and how the parent chain survives tiles that carry no content.
 */

import { describe, it, expect } from 'vitest';
import { tilesetNodes, ASSUMED_TILE_POINTS, contentKind } from '../src/io/tiles3d/tilesetNodes';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { MAX_PNTS_TILE_POINTS } from '../src/io/tiles3d/pnts';

/** A tileset document with the given root tile tree. */
function ts(root: unknown) {
  return parseTileset(JSON.stringify({ asset: { version: '1.0' }, geometricError: 100, root }));
}

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

describe('which tiles become nodes', () => {
  it('makes a node per tile that has content', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
      children: [
        { boundingVolume: BOX, geometricError: 10, content: { uri: 'a.pnts' } },
        { boundingVolume: BOX, geometricError: 10, content: { uri: 'b.pnts' } },
      ],
    });
    const idx = tilesetNodes(t);
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts', 'a.pnts', 'b.pnts']);
  });

  it('produces no node for a tile that carries no content', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      children: [{ boundingVolume: BOX, geometricError: 10, content: { uri: 'only.pnts' } }],
    });
    const idx = tilesetNodes(t);
    expect(idx.records.map((r) => r.id)).toEqual(['only.pnts']);
  });

  it('keeps the parent chain across a structural tile', () => {
    // root(content) -> middle(NO content) -> leaf(content).
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
      children: [
        {
          boundingVolume: BOX,
          geometricError: 25,
          children: [{ boundingVolume: BOX, geometricError: 10, content: { uri: 'leaf.pnts' } }],
        },
      ],
    });
    const idx = tilesetNodes(t);
    const leaf = idx.records.find((r) => r.id === 'leaf.pnts');
    expect(
      leaf?.parentId,
      'the leaf must chain to the nearest ancestor that has a node, not to a tile with none',
    ).toBe('root.pnts');
  });

  it('records a skip rather than dropping a tile silently', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'dup.pnts' },
      children: [{ boundingVolume: BOX, geometricError: 10, content: { uri: 'dup.pnts' } }],
    });
    const idx = tilesetNodes(t);
    expect(idx.records).toHaveLength(1);
    expect(idx.skipped.join(' ')).toContain('same content');
  });
});

describe('the point count a tileset does not state', () => {
  it('admits every tile with the same realistic estimate', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
    });
    expect(tilesetNodes(t).records[0].pointCount).toBe(ASSUMED_TILE_POINTS);
  });

  it('estimates high of a typical tile, because the scheduler can only absorb over-estimates', () => {
    // The admission gate refuses a decode when resident + in-flight is at the
    // cap. Over-estimating dispatches fewer decodes; under-estimating admits
    // more than the budget intends, which it cannot take back.
    expect(ASSUMED_TILE_POINTS).toBeGreaterThanOrEqual(100_000);
  });

  it('does NOT inflate the estimate to the parser ceiling, which would starve streaming', () => {
    // This estimate drives resident/concurrency pressure, not memory safety.
    // Reserving MAX_PNTS_TILE_POINTS per node would treat a few-hundred-point
    // tile as millions and admit almost nothing. The memory bound lives in the
    // PNTS decoder's decoded-byte ceiling instead, where the real count is known.
    expect(ASSUMED_TILE_POINTS).toBeLessThan(MAX_PNTS_TILE_POINTS);
  });
});

describe('what the scheduler and decoder are handed', () => {
  it('carries depth and a per-tile transform', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
      children: [
        {
          boundingVolume: BOX,
          geometricError: 10,
          transform: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1],
          content: { uri: 'child.pnts' },
        },
      ],
    });
    const idx = tilesetNodes(t);
    expect(idx.records.find((r) => r.id === 'child.pnts')?.depth).toBe(1);
    expect(idx.transform.get('child.pnts')?.[12]).toBe(5);
  });

  it('bounds every node, so nothing is culled against an empty box', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
    });
    const b = tilesetNodes(t).records[0].bounds;
    expect(b).toHaveLength(6);
    expect(b[3] - b[0]).toBeGreaterThan(0);
  });
});

describe('what may become a node', () => {
  const tree = (uri: string) =>
    ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
      children: [{ boundingVolume: BOX, geometricError: 10, content: { uri } }],
    });

  it('refuses to make a node from a nested tileset', () => {
    const idx = tilesetNodes(tree('sub/tileset.json'));
    expect(
      idx.records.map((r) => r.id),
      'a .json fetched and handed to the point-tile decoder fails on bytes that ' +
        'were never point data',
    ).toEqual(['root.pnts']);
    expect(idx.skipped.join(' ')).toContain('external tileset');
  });

  it('refuses mesh content by name rather than fetching it', () => {
    const idx = tilesetNodes(tree('b.b3dm'));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts']);
    expect(idx.skipped.join(' ')).toContain('not a point tile');
  });

  it('does not assume an extensionless content URI is a point tile', () => {
    // 3D Tiles 1.1 permits content with no extension, identified by its magic
    // header. Guessing would decode whatever arrived as points.
    const idx = tilesetNodes(tree('tile-00417'));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts']);
    expect(idx.skipped.join(' ')).toContain('undeclared');
  });

  it('classifies the three named forms and the undeclared one', () => {
    expect(contentKind('a.pnts')).toBe('pnts');
    expect(contentKind('a.PNTS?v=2')).toBe('pnts');
    expect(contentKind('sub/tileset.json#x')).toBe('tileset');
    expect(contentKind('a.b3dm')).toBe('other');
    expect(contentKind('tile-1')).toBe('unknown');
  });
});
