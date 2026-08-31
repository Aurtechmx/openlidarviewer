/**
 * replaceFrontier.test.ts — the live-render hidden set for a REPLACE hierarchy.
 *
 * The rule is the no-hole rule: a replacing parent is hidden (its children
 * shown) ONLY when every child is resident, and until then its whole subtree is
 * withheld so the parent keeps covering the region. These cases pin that an
 * additive hierarchy hides nothing, that a half-loaded level never uncovers the
 * surface, and that the transition is an atomic parent → children swap.
 */

import { describe, it, expect } from 'vitest';
import {
  computeReplaceHidden,
  type ReplaceFrontierNode,
} from '../src/render/streaming/replaceFrontier';

/** Terser node builder; residency and refine default to the common case. */
function node(
  id: string,
  opts: Partial<Omit<ReplaceFrontierNode, 'id'>> = {},
): ReplaceFrontierNode {
  return {
    id,
    refine: opts.refine,
    resident: opts.resident ?? true,
    childIds: opts.childIds ?? [],
    parentId: opts.parentId,
  };
}

describe('computeReplaceHidden', () => {
  it('hides nothing in a purely additive hierarchy', () => {
    // Root + two children, all additive and resident — the COPC/EPT shape.
    const nodes = [
      node('r', { childIds: ['a', 'b'] }),
      node('a', { parentId: 'r' }),
      node('b', { parentId: 'r' }),
    ];
    expect(computeReplaceHidden(nodes)).toEqual(new Set());
  });

  it('keeps a replacing parent while any child is still absent, and withholds the ones that arrived', () => {
    // r REPLACEs into a, b; only a is resident. r is not covered, so it keeps
    // drawing and a is withheld — no half-refined overlap, no hole.
    const nodes = [
      node('r', { refine: 'replace', childIds: ['a', 'b'] }),
      node('a', { parentId: 'r' }),
      node('b', { parentId: 'r', resident: false }),
    ];
    expect(computeReplaceHidden(nodes)).toEqual(new Set(['a']));
  });

  it('refines a replacing parent away once every child is resident', () => {
    const nodes = [
      node('r', { refine: 'replace', childIds: ['a', 'b'] }),
      node('a', { parentId: 'r' }),
      node('b', { parentId: 'r' }),
    ];
    // The parent is hidden; both children draw. Atomic swap, no overlap.
    expect(computeReplaceHidden(nodes)).toEqual(new Set(['r']));
  });

  it('refines through two replacing levels to the deepest fully-resident one', () => {
    // r -> {a} replace, a -> {x, y} replace, all resident.
    const nodes = [
      node('r', { refine: 'replace', childIds: ['a'] }),
      node('a', { refine: 'replace', childIds: ['x', 'y'], parentId: 'r' }),
      node('x', { parentId: 'a' }),
      node('y', { parentId: 'a' }),
    ];
    // r covered by a; a covered by x,y — both hidden, leaves {x, y}.
    expect(computeReplaceHidden(nodes)).toEqual(new Set(['r', 'a']));
  });

  it('withholds a grandchild while its parent level is incomplete', () => {
    // r -> {a} replace (a resident), a -> {x, y} replace but y absent.
    // a is a blocker: it keeps drawing, and x (resident) is withheld under it.
    const nodes = [
      node('r', { refine: 'replace', childIds: ['a'] }),
      node('a', { refine: 'replace', childIds: ['x', 'y'], parentId: 'r' }),
      node('x', { parentId: 'a' }),
      node('y', { parentId: 'a', resident: false }),
    ];
    // r is covered by resident a, so r hides; a draws (blocker); x withheld.
    expect(computeReplaceHidden(nodes)).toEqual(new Set(['r', 'x']));
  });

  it('never hides a node that is not resident', () => {
    const nodes = [
      node('r', { refine: 'replace', childIds: ['a', 'b'] }),
      node('a', { parentId: 'r', resident: false }),
      node('b', { parentId: 'r', resident: false }),
    ];
    // r has no resident children → not covered → draws. Absent children are not
    // in the hidden set (they draw nothing regardless).
    expect(computeReplaceHidden(nodes)).toEqual(new Set());
  });

  it('does not refine a replacing parent whose children were never selected', () => {
    // A parent straddling the frustum: its children are not in the store's
    // resident set. Conservative: keep the coarse parent rather than hole.
    const nodes = [node('r', { refine: 'replace', childIds: ['a', 'b'] })];
    expect(computeReplaceHidden(nodes)).toEqual(new Set());
  });
});
