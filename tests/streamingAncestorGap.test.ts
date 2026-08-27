/**
 * streamingAncestorGap.test.ts — a hole in the middle of a chain must not hide
 * the ancestors above it.
 *
 * COPC parses an entry whose point count is zero as structure and adds no node
 * for it, so a real hierarchy can have a gap between a leaf and its grandparent.
 * The ancestor walk reads parents out of the node store, and a store miss ended
 * the walk, which is correct for a hierarchy page that has not arrived and wrong
 * for a hole whose upper ids are perfectly well known.
 *
 * Three shipped consumers read these walks, and each fails differently:
 * `buildAncestorProtection` drops an ancestor's eviction protection while its
 * descendants are resident, `buildRefinedAwayIds` leaves a coarse node marked
 * not-superseded once its replacement arrived, and `computeExportFrontier` keeps
 * that ancestor beside its own descendants, so an export carries the same ground
 * twice and its point total over-reports.
 */

import { describe, it, expect } from 'vitest';
import { forEachAncestorId, parentLookupFromStore } from '../src/render/streaming/streamingHierarchy';

/** A store holding only the ids given; anything else is a miss. */
function storeOf(records: ReadonlyMap<string, string | undefined>) {
  return {
    get(id: string) {
      if (!records.has(id)) return undefined;
      return { record: { parentId: records.get(id) } };
    },
  };
}

describe('an octree id can find its own parent', () => {
  it('walks past a node the hierarchy skipped', () => {
    // 2-0-0-0 is the empty middle: parsed as structure, never stored.
    const store = storeOf(new Map([
      ['3-0-0-0', '2-0-0-0'],
      ['1-0-0-0', '0-0-0-0'],
      ['0-0-0-0', undefined],
    ]));
    const seen: string[] = [];
    forEachAncestorId('3-0-0-0', parentLookupFromStore(store), (a) => seen.push(a));
    expect(
      seen,
      'the walk stopped at the empty node, losing every real ancestor above it',
    ).toEqual(['2-0-0-0', '1-0-0-0', '0-0-0-0']);
  });

  it('still prefers what the store recorded', () => {
    // A source whose parents are not key-derivable must keep winning.
    const store = storeOf(new Map([['3-1-1-1', 'some-other-id'], ['some-other-id', undefined]]));
    const seen: string[] = [];
    forEachAncestorId('3-1-1-1', parentLookupFromStore(store), (a) => seen.push(a));
    expect(seen).toEqual(['some-other-id']);
  });

  it('stops at the root rather than walking below depth zero', () => {
    const seen: string[] = [];
    forEachAncestorId('0-0-0-0', parentLookupFromStore(storeOf(new Map())), (a) => seen.push(a));
    expect(seen).toEqual([]);
  });

  it('stops for an id that is not key-shaped, which is how EPT terminates', () => {
    // A hierarchy page that has not arrived leaves its ancestors genuinely
    // unknown. Inventing ids there would protect nodes that may not exist.
    const seen: string[] = [];
    forEachAncestorId('ept-page-7', parentLookupFromStore(storeOf(new Map())), (a) => seen.push(a));
    expect(seen).toEqual([]);
  });

  it('derives the whole chain when the store is empty but the ids are keys', () => {
    const seen: string[] = [];
    forEachAncestorId('2-3-1-0', parentLookupFromStore(storeOf(new Map())), (a) => seen.push(a));
    expect(seen).toEqual(['1-1-0-0', '0-0-0-0']);
  });
});
