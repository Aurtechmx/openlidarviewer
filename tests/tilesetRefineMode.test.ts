/**
 * tilesetRefineMode.test.ts — the two refinement modes are not the same scene.
 *
 * ADD means a refined tile's content is additive: the parent IS drawn alongside
 * its children. REPLACE means the parent's content is replaced by them, so it
 * must NOT be drawn once they are selected.
 *
 * Both are served. Each node record carries the tile's own `refine` mode, and
 * the scheduler's replace frontier (`replaceFrontier.ts`) hides a REPLACE parent
 * once every one of its children is resident — an atomic parent → children swap.
 * So a REPLACE tile that refines into content becomes a node like any other; the
 * suppression is a render decision keyed on `refine`, not a parse-time refusal.
 * These cases pin that the mode is parsed, carried onto the record, and read by
 * the export frontier.
 */

import { describe, it, expect } from 'vitest';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { tilesetNodes } from '../src/io/tiles3d/tilesetNodes';
import { computeExportFrontier } from '../src/render/streaming/exportFrontier';

const BOX = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] };

const doc = (refine: string, childHasContent: boolean) =>
  JSON.stringify({
    asset: { version: '1.1' },
    geometricError: 100,
    root: {
      boundingVolume: BOX,
      geometricError: 50,
      refine,
      content: { uri: 'root.pnts' },
      children: [
        {
          boundingVolume: BOX,
          geometricError: 10,
          ...(childHasContent ? { content: { uri: 'child.pnts' } } : {}),
        },
      ],
    },
  });

describe('refinement mode', () => {
  it('serves an ADD tileset, parent and child together', () => {
    const idx = tilesetNodes(parseTileset(doc('ADD', true)));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts', 'child.pnts']);
    expect(idx.skipped).toEqual([]);
  });

  it('serves a REPLACE tile that refines into content, marking the parent replace', () => {
    // No longer refused: the parent becomes a node and the render-time replace
    // frontier hides it once its children cover it.
    const idx = tilesetNodes(parseTileset(doc('REPLACE', true)));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts', 'child.pnts']);
    expect(idx.skipped).toEqual([]);
    const root = idx.records.find((r) => r.id === 'root.pnts');
    expect(root?.refine).toBe('replace');
  });

  it("carries the tile's own refinement onto the node record", () => {
    const add = tilesetNodes(parseTileset(doc('ADD', true)));
    expect(add.records.map((r) => r.refine)).toEqual(['add', 'add']);
    // A REPLACE parent with content below carries 'replace'; the child, which
    // states no mode of its own, inherits it too.
    const rep = tilesetNodes(parseTileset(doc('REPLACE', true)));
    expect(rep.records.map((r) => r.refine)).toEqual(['replace', 'replace']);
    // A REPLACE leaf still records the mode the document declared.
    expect(tilesetNodes(parseTileset(doc('REPLACE', false))).records[0].refine).toBe('replace');
  });

  it('keeps an ADD parent in the export frontier beside its resident child', () => {
    // The data-loss case. An additive parent's points are its own, so an export
    // that drops it for having a resident child is missing the coarse level of
    // every additive tileset.
    const idx = tilesetNodes(parseTileset(doc('ADD', true)));
    const parentOf = (id: string): string | undefined =>
      idx.records.find((r) => r.id === id)?.parentId;
    const keep = computeExportFrontier(
      idx.records.map((r) => ({ id: r.id, refine: r.refine })),
      parentOf,
    );
    expect([...keep].sort()).toEqual(['child.pnts', 'root.pnts']);
  });

  it('drops a REPLACE parent from the export frontier when its child is resident', () => {
    // The mirror case: a replacing parent's points are re-represented by its
    // child, so the snapshot keeps only the finer node.
    const idx = tilesetNodes(parseTileset(doc('REPLACE', true)));
    const parentOf = (id: string): string | undefined =>
      idx.records.find((r) => r.id === id)?.parentId;
    const keep = computeExportFrontier(
      idx.records.map((r) => ({ id: r.id, refine: r.refine })),
      parentOf,
    );
    expect([...keep]).toEqual(['child.pnts']);
  });

  it('serves a REPLACE tile that refines into nothing', () => {
    const idx = tilesetNodes(parseTileset(doc('REPLACE', false)));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts']);
    expect(idx.skipped).toEqual([]);
  });

  it('serves a REPLACE tile whose content sits several levels below', () => {
    const deep = JSON.stringify({
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        boundingVolume: BOX,
        geometricError: 50,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: [
          {
            boundingVolume: BOX,
            geometricError: 20,
            children: [{ boundingVolume: BOX, geometricError: 5, content: { uri: 'deep.pnts' } }],
          },
        ],
      },
    });
    const idx = tilesetNodes(parseTileset(deep));
    expect(idx.records.map((r) => r.id)).toEqual(['root.pnts', 'deep.pnts']);
    expect(idx.skipped).toEqual([]);
    expect(idx.records.find((r) => r.id === 'root.pnts')?.refine).toBe('replace');
  });
});
