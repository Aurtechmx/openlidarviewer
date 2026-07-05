/**
 * exportFrontier.test.ts
 *
 * Pins the deterministic export frontier (v0.5.7 Gate 5): keep the deepest
 * resident node per octree path, drop ancestors that have a resident descendant,
 * and exclude fading-out nodes — so a resident-snapshot export never carries
 * overlapping LOD samples of the same region. Also covers the `keyFromId`
 * parser the wiring uses to turn a resident map id back into a key.
 */

import { describe, it, expect } from 'vitest';
import { computeExportFrontier, type FrontierNode } from '../src/render/streaming/exportFrontier';
import { keyId, keyFromId } from '../src/io/copc/voxelKey';
import type { VoxelKey } from '../src/io/copc/copcTypes';

function node(depth: number, x: number, y: number, z: number, fadingOut = false): FrontierNode {
  const key: VoxelKey = { depth, x, y, z };
  return { id: keyId(key), key, fadingOut };
}

describe('computeExportFrontier', () => {
  it('keeps a lone resident node', () => {
    const keep = computeExportFrontier([node(0, 0, 0, 0)]);
    expect([...keep]).toEqual(['0-0-0-0']);
  });

  it('drops a parent when one child is resident, keeping the child', () => {
    // root (0-0-0-0) and its first child (1-0-0-0) both resident.
    const keep = computeExportFrontier([node(0, 0, 0, 0), node(1, 0, 0, 0)]);
    expect(keep.has('1-0-0-0')).toBe(true);
    expect(keep.has('0-0-0-0')).toBe(false);
  });

  it('keeps both siblings when the parent is not resident', () => {
    const keep = computeExportFrontier([node(1, 0, 0, 0), node(1, 1, 0, 0)]);
    expect([...keep].sort()).toEqual(['1-0-0-0', '1-1-0-0']);
  });

  it('collapses a grandparent/parent/child chain to the deepest node only', () => {
    const keep = computeExportFrontier([
      node(0, 0, 0, 0),
      node(1, 0, 0, 0),
      node(2, 0, 0, 0),
    ]);
    expect([...keep]).toEqual(['2-0-0-0']);
  });

  it('excludes a fading-out node entirely', () => {
    const keep = computeExportFrontier([node(2, 3, 1, 0, /* fadingOut */ true)]);
    expect(keep.size).toBe(0);
  });

  it('keeps the resident children while a fading-out parent is excluded', () => {
    // The classic cross-fade moment: parent fading out, two children resident.
    const keep = computeExportFrontier([
      node(0, 0, 0, 0, /* fadingOut */ true),
      node(1, 0, 0, 0),
      node(1, 1, 0, 0),
    ]);
    expect([...keep].sort()).toEqual(['1-0-0-0', '1-1-0-0']);
    expect(keep.has('0-0-0-0')).toBe(false);
  });

  it('a parent whose only descendant is fading out is NOT dropped', () => {
    // The child is leaving; the parent must remain to cover the region.
    const keep = computeExportFrontier([
      node(0, 0, 0, 0),
      node(1, 0, 0, 0, /* fadingOut */ true),
    ]);
    expect([...keep]).toEqual(['0-0-0-0']);
  });

  it('keeps spatially disjoint nodes at different depths', () => {
    const keep = computeExportFrontier([
      node(1, 0, 0, 0),
      node(3, 7, 7, 7),
      node(2, 2, 1, 0),
    ]);
    expect(keep.size).toBe(3);
  });

  it('returns an antichain — no kept node is an ancestor of another', () => {
    const keep = computeExportFrontier([
      node(0, 0, 0, 0),
      node(1, 0, 0, 0),
      node(1, 1, 1, 1),
      node(2, 0, 0, 0),
      node(2, 2, 2, 2),
    ]);
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
