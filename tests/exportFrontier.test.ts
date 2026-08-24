/**
 * exportFrontier.test.ts
 *
 * Pins the deterministic export frontier (v0.5.7 Gate 5): keep the deepest
 * resident node per hierarchy path, drop ancestors that have a resident
 * descendant, and exclude fading-out nodes — so a resident-snapshot export never
 * carries overlapping LOD samples of the same region. Also covers the
 * `keyFromId` parser, which the octree formats still use to name their nodes.
 *
 * Every octree case below is unchanged from when the frontier derived ancestry
 * by shifting a `VoxelKey`. It now takes an explicit parent lookup instead, and
 * these are the fixtures that prove the two agree: the lookup here IS the octree
 * shift, so any keep-set that moved would be a regression rather than a
 * generalization.
 */

import { describe, it, expect } from 'vitest';
import { computeExportFrontier, type FrontierNode } from '../src/render/streaming/exportFrontier';
import { keyId, keyFromId } from '../src/io/copc/voxelKey';
import type { VoxelKey } from '../src/io/copc/copcTypes';

function node(depth: number, x: number, y: number, z: number, fadingOut = false): FrontierNode {
  return { id: keyId({ depth, x, y, z }), fadingOut };
}

/** The octree parent of an id, which is what the frontier used to derive itself. */
function octreeParentOf(id: string): string | undefined {
  const k = keyFromId(id);
  if (!k || k.depth === 0) return undefined;
  return keyId({ depth: k.depth - 1, x: k.x >> 1, y: k.y >> 1, z: k.z >> 1 });
}

describe('computeExportFrontier', () => {
  it('keeps a lone resident node', () => {
    const keep = computeExportFrontier([node(0, 0, 0, 0)], octreeParentOf);
    expect([...keep]).toEqual(['0-0-0-0']);
  });

  it('drops a parent when one child is resident, keeping the child', () => {
    // root (0-0-0-0) and its first child (1-0-0-0) both resident.
    const keep = computeExportFrontier([node(0, 0, 0, 0), node(1, 0, 0, 0)], octreeParentOf);
    expect(keep.has('1-0-0-0')).toBe(true);
    expect(keep.has('0-0-0-0')).toBe(false);
  });

  it('keeps both siblings when the parent is not resident', () => {
    const keep = computeExportFrontier([node(1, 0, 0, 0), node(1, 1, 0, 0)], octreeParentOf);
    expect([...keep].sort()).toEqual(['1-0-0-0', '1-1-0-0']);
  });

  it('collapses a grandparent/parent/child chain to the deepest node only', () => {
    const keep = computeExportFrontier([
      node(0, 0, 0, 0),
      node(1, 0, 0, 0),
      node(2, 0, 0, 0),
    ], octreeParentOf);
    expect([...keep]).toEqual(['2-0-0-0']);
  });

  it('excludes a fading-out node entirely', () => {
    const keep = computeExportFrontier([node(2, 3, 1, 0, /* fadingOut */ true)], octreeParentOf);
    expect(keep.size).toBe(0);
  });

  it('keeps the resident children while a fading-out parent is excluded', () => {
    // The classic cross-fade moment: parent fading out, two children resident.
    const keep = computeExportFrontier([
      node(0, 0, 0, 0, /* fadingOut */ true),
      node(1, 0, 0, 0),
      node(1, 1, 0, 0),
    ], octreeParentOf);
    expect([...keep].sort()).toEqual(['1-0-0-0', '1-1-0-0']);
    expect(keep.has('0-0-0-0')).toBe(false);
  });

  it('a parent whose only descendant is fading out is NOT dropped', () => {
    // The child is leaving; the parent must remain to cover the region.
    const keep = computeExportFrontier([
      node(0, 0, 0, 0),
      node(1, 0, 0, 0, /* fadingOut */ true),
    ], octreeParentOf);
    expect([...keep]).toEqual(['0-0-0-0']);
  });

  it('keeps spatially disjoint nodes at different depths', () => {
    const keep = computeExportFrontier([
      node(1, 0, 0, 0),
      node(3, 7, 7, 7),
      node(2, 2, 1, 0),
    ], octreeParentOf);
    expect(keep.size).toBe(3);
  });

  it('returns an antichain — no kept node is an ancestor of another', () => {
    const keep = computeExportFrontier([
      node(0, 0, 0, 0),
      node(1, 0, 0, 0),
      node(1, 1, 1, 1),
      node(2, 0, 0, 0),
      node(2, 2, 2, 2),
    ], octreeParentOf);
    const kept = [...keep].map((id) => keyFromId(id)!);
    for (const a of kept) {
      for (const b of kept) {
        if (a === b) continue;
        // b must not be a strict descendant of a.
        let p = b.depth > a.depth ? b : null;
        let isDesc = false;
        while (p && p.depth > a.depth) {
          p = { depth: p.depth - 1, x: p.x >> 1, y: p.y >> 1, z: p.z >> 1 };
          if (p.depth === a.depth && p.x === a.x && p.y === a.y && p.z === a.z) isDesc = true;
        }
        expect(isDesc).toBe(false);
      }
    }
  });
});

describe('keyFromId', () => {
  it('round-trips a valid key', () => {
    const k: VoxelKey = { depth: 5, x: 12, y: 3, z: 9 };
    expect(keyFromId(keyId(k))).toEqual(k);
  });

  it('rejects malformed ids', () => {
    expect(keyFromId('1-2-3')).toBeNull();
    expect(keyFromId('1-2-3-4-5')).toBeNull();
    expect(keyFromId('a-b-c-d')).toBeNull();
    expect(keyFromId('1--1-0-0')).toBeNull();
    expect(keyFromId('0-0-0-0')).toEqual({ depth: 0, x: 0, y: 0, z: 0 });
  });
});

describe('computeExportFrontier over a hierarchy that is not an octree', () => {
  /**
   * The irregular tree the 3D Tiles adapter produces: mixed child counts, mixed
   * depths, ids that carry no coordinate at all.
   *
   *   root
   *    ├─ A ─ A1
   *    ├─ B ─ B1, B2, B3
   *    └─ C
   */
  const PARENTS: Record<string, string | undefined> = {
    root: undefined,
    A: 'root', A1: 'A',
    B: 'root', B1: 'B', B2: 'B', B3: 'B',
    C: 'root',
  };
  const parentOf = (id: string): string | undefined => PARENTS[id];

  it('drops an ancestor with a resident descendant and keeps unrefined siblings', () => {
    const keep = computeExportFrontier(
      [{ id: 'root' }, { id: 'A' }, { id: 'A1' }, { id: 'C' }],
      parentOf,
    );
    expect([...keep].sort()).toEqual(['A1', 'C']);
  });

  it('keeps every child of a node with three children', () => {
    const keep = computeExportFrontier(
      [{ id: 'B' }, { id: 'B1' }, { id: 'B2' }, { id: 'B3' }],
      parentOf,
    );
    expect([...keep].sort()).toEqual(['B1', 'B2', 'B3']);
  });

  it('keeps a node whose parent is not in the hierarchy at all', () => {
    const keep = computeExportFrontier([{ id: 'orphan' }], () => undefined);
    expect([...keep]).toEqual(['orphan']);
  });
});

describe('computeExportFrontier under additive refinement', () => {
  const parentOf = (id: string): string | undefined =>
    ({ child: 'parent', grandchild: 'child' })[id];

  it('keeps an additive parent alongside its resident child', () => {
    const keep = computeExportFrontier(
      [{ id: 'parent', refine: 'add' }, { id: 'child' }],
      parentOf,
    );
    expect([...keep].sort()).toEqual(['child', 'parent']);
  });

  it('still drops a replacing parent, so the default is unchanged', () => {
    const keep = computeExportFrontier(
      [{ id: 'parent', refine: 'replace' }, { id: 'child' }],
      parentOf,
    );
    expect([...keep]).toEqual(['child']);
  });

  it('an additive node still drops its own replacing ancestor', () => {
    // `child` is additive, so it is kept; it is also a descendant of `parent`,
    // which replaces, so `parent` goes.
    const keep = computeExportFrontier(
      [{ id: 'parent' }, { id: 'child', refine: 'add' }, { id: 'grandchild' }],
      parentOf,
    );
    expect([...keep].sort()).toEqual(['child', 'grandchild']);
  });
});

describe('computeExportFrontier on a malformed hierarchy', () => {
  it('terminates on a parent cycle rather than hanging', () => {
    // A names B as its parent and B names A. A real tileset cannot produce
    // this; a hostile or corrupt one can.
    const parentOf = (id: string): string | undefined => (id === 'A' ? 'B' : 'A');
    const keep = computeExportFrontier([{ id: 'A' }, { id: 'B' }], parentOf);
    // Each is an ancestor of the other, so neither survives. The property under
    // test is that the call returns.
    expect(keep.size).toBe(0);
  });
});
