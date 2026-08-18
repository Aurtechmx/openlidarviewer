/**
 * residentStickiness.test.ts
 *
 * The admission-side anti-thrash pass, and the exemption that makes it safe.
 *
 * Resident stickiness gives an already-shown node a small score bonus so noise
 * at the budget boundary cannot bump it out and pay an evict → re-decode →
 * re-fade cycle for nothing. The danger is the failure mode that reverted an
 * earlier attempt: if a coarse node can hold its slot against its OWN children,
 * the scene stops refining. `buildRefiningCandidateIds` is the guard, and these
 * tests exercise the guard, not just the bonus.
 */

import { describe, it, expect } from 'vitest';
import { buildRefiningCandidateIds } from '../src/render/streaming/StreamingScheduler';
import { selectWithinBudget } from '../src/render/streaming/streamingBudget';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { ScoredCandidate } from '../src/render/streaming/streamingBudget';

/** A candidate at an octree key, with the shape the scheduler passes. */
function cand(
  depth: number, x: number, y: number, z: number, score: number, pointCount = 100,
): { node: StreamingNode; candidate: ScoredCandidate } {
  const id = `${depth}/${x}/${y}/${z}`;
  return {
    node: { record: { id, key: { depth, x, y, z }, pointCount } } as unknown as StreamingNode,
    candidate: { id, pointCount, score },
  };
}

describe('buildRefiningCandidateIds — the LOD-freeze guard', () => {
  it('marks a parent whose CHILD is also a candidate', () => {
    const scored = [cand(0, 0, 0, 0, 10), cand(1, 0, 0, 0, 9)];
    const refining = buildRefiningCandidateIds(scored);
    expect(refining.has('0/0/0/0')).toBe(true);   // the parent is being refined away
    expect(refining.has('1/0/0/0')).toBe(false);  // the child is the refinement
  });

  it('marks EVERY ancestor in the chain, not just the immediate parent', () => {
    const scored = [cand(0, 0, 0, 0, 10), cand(1, 0, 0, 0, 9), cand(2, 0, 0, 0, 8)];
    const refining = buildRefiningCandidateIds(scored);
    expect(refining.has('0/0/0/0')).toBe(true);
    expect(refining.has('1/0/0/0')).toBe(true);
    expect(refining.has('2/0/0/0')).toBe(false);
  });

  it('marks nothing when candidates are siblings with no descendant among them', () => {
    const scored = [cand(1, 0, 0, 0, 10), cand(1, 1, 0, 0, 9), cand(1, 0, 1, 0, 8)];
    expect(buildRefiningCandidateIds(scored).size).toBe(0);
  });

  it('does not mark a parent whose candidate descendant is in a DIFFERENT subtree', () => {
    // 1/1/0/0 is not under 0/0/0/0's child path from 1/0/0/0's perspective; the
    // only true ancestor chain is by bit-shift, so an unrelated deep node in
    // another octant must not exempt a coarse node it does not refine.
    const scored = [cand(1, 0, 0, 0, 10), cand(2, 2, 0, 0, 9)];
    const refining = buildRefiningCandidateIds(scored);
    // 2/2/0/0 shifts to 1/1/0/0, which is NOT a candidate, so nothing is marked.
    expect(refining.size).toBe(0);
  });

  it('an empty candidate list marks nothing and does not throw', () => {
    expect(buildRefiningCandidateIds([]).size).toBe(0);
  });
});

describe('resident stickiness composed with the exemption', () => {
  const budget = 100; // exactly one 100-point node fits

  it('WITHOUT stickiness the marginally-higher newcomer always wins', () => {
    const resident = new Set(['1/0/0/0']);
    const picked = selectWithinBudget(
      [{ id: '1/1/0/0', pointCount: 100, score: 1.05 }, { id: '1/0/0/0', pointCount: 100, score: 1.0 }],
      budget,
    );
    expect(picked.has('1/1/0/0')).toBe(true);
    expect(picked.has('1/0/0/0')).toBe(false);
    expect(resident.size).toBe(1); // untouched: no stickiness was requested
  });

  it('WITH stickiness a resident node holds its slot against boundary noise', () => {
    const picked = selectWithinBudget(
      [{ id: '1/1/0/0', pointCount: 100, score: 1.05 }, { id: '1/0/0/0', pointCount: 100, score: 1.0 }],
      budget,
      { resident: new Set(['1/0/0/0']), refining: new Set(), stickyMargin: 0.15 },
    );
    // 1.0 x 1.15 = 1.15 > 1.05, so the node already on screen stays.
    expect(picked.has('1/0/0/0')).toBe(true);
    expect(picked.has('1/1/0/0')).toBe(false);
  });

  it('LOD IS NOT FROZEN: a resident parent loses to its own child despite the bonus', () => {
    // This is the reverted failure mode, set up so ONLY the bonus could cause it:
    // the child outranks the parent on raw score (1.05 > 1.00), but the parent
    // would overtake it with stickiness (1.00 x 1.15 = 1.15 > 1.05). The
    // exemption must strip that bonus because the child is right here.
    const scored = [cand(0, 0, 0, 0, 1.0), cand(1, 0, 0, 0, 1.05)];
    const refining = buildRefiningCandidateIds(scored);
    const picked = selectWithinBudget(
      scored.map((s) => s.candidate),
      budget,
      { resident: new Set(['0/0/0/0']), refining, stickyMargin: 0.15 },
    );
    expect(refining.has('0/0/0/0')).toBe(true); // the guard fired
    expect(picked.has('1/0/0/0')).toBe(true);   // refinement proceeds
    expect(picked.has('0/0/0/0')).toBe(false);

    // And prove the bonus WOULD have frozen it, so the guard is load-bearing
    // rather than incidental: same inputs, empty exemption set.
    const frozen = selectWithinBudget(
      scored.map((s) => s.candidate),
      budget,
      { resident: new Set(['0/0/0/0']), refining: new Set(), stickyMargin: 0.15 },
    );
    expect(frozen.has('0/0/0/0')).toBe(true);
    expect(frozen.has('1/0/0/0')).toBe(false);
  });

  it('a resident node with no refinement beneath it still keeps its bonus', () => {
    // Same shape as above, but the child is NOT a candidate this tick, so the
    // parent is not refinement's target and stickiness legitimately applies.
    const scored = [cand(0, 0, 0, 0, 1.0), cand(1, 5, 5, 5, 1.05)];
    const refining = buildRefiningCandidateIds(scored);
    expect(refining.size).toBe(0);
    const picked = selectWithinBudget(
      scored.map((s) => s.candidate),
      budget,
      { resident: new Set(['0/0/0/0']), refining, stickyMargin: 0.15 },
    );
    expect(picked.has('0/0/0/0')).toBe(true);
  });

  it('a margin of 0 reproduces the plain greedy fill exactly (the shipping default)', () => {
    const candidates = [
      { id: 'a', pointCount: 60, score: 1.05 },
      { id: 'b', pointCount: 60, score: 1.0 },
    ];
    const plain = selectWithinBudget(candidates, budget);
    const zeroMargin = selectWithinBudget(candidates, budget, {
      resident: new Set(['b']), refining: new Set(), stickyMargin: 0,
    });
    expect([...zeroMargin]).toEqual([...plain]);
  });
});
