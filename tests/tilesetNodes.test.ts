/**
 * tilesetNodes.test.ts — a tileset seen as streaming nodes.
 *
 * The interesting decisions are the ones the format does not settle: what a
 * tile's point count is before its body is read, which tiles become nodes at
 * all, and how the parent chain survives tiles that carry no content.
 */

import { describe, it, expect } from 'vitest';
import { tilesetNodes, ASSUMED_TILE_POINTS } from '../src/io/tiles3d/tilesetNodes';
import { parseTileset } from '../src/io/tiles3d/tileset';

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
  it('admits every tile with the same high estimate', () => {
    const t = ts({
      boundingVolume: BOX,
      geometricError: 50,
      refine: 'REPLACE',
      content: { uri: 'root.pnts' },
    });
    expect(tilesetNodes(t).records[0].pointCount).toBe(ASSUMED_TILE_POINTS);
  });

  it('estimates high, because the scheduler can only absorb over-estimates', () => {
    // The admission gate refuses a decode when resident + in-flight is at the
    // cap. Over-estimating dispatches fewer decodes; under-estimating admits
    // more than the budget intends, which it cannot take back.
    expect(ASSUMED_TILE_POINTS).toBeGreaterThanOrEqual(100_000);
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
