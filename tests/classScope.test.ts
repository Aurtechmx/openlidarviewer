/**
 * tests/classScope.test.ts
 *
 * Coverage for the class-filter scope descriptor and its human-readable
 * stamp (used on exports / snapshots to record which classes a view was
 * limited to). When every present class is visible the scope is "full"
 * and the stamp is empty; otherwise it is a subset carrying the visible
 * intersection plus the total count of present classes.
 */

import { describe, it, expect } from 'vitest';
import {
  fullScope,
  scopeFrom,
  scopeStamp,
  notScopedSentinel,
  type ClassScope,
} from '../src/render/class/classScope';

const NAMES: Record<number, string> = {
  2: 'ground',
  3: 'low veg',
  5: 'high veg',
};
const nameOf = (c: number): string => NAMES[c] ?? `class ${c}`;

describe('fullScope / scopeStamp(full)', () => {
  it('full scope stamps as empty string', () => {
    const scope = fullScope();
    expect(scope.kind).toBe('full');
    expect(scopeStamp(scope, nameOf)).toBe('');
  });
});

describe('scopeFrom', () => {
  it('all present codes visible -> full scope (no stamp)', () => {
    const scope = scopeFrom([2, 3, 5], [2, 3, 5], nameOf);
    expect(scope.kind).toBe('full');
    expect(scopeStamp(scope, nameOf)).toBe('');
  });

  it('subset of present codes -> subset scope', () => {
    const scope = scopeFrom([2], [2, 3, 5], nameOf);
    expect(scope.kind).toBe('subset');
    if (scope.kind === 'subset') {
      expect(scope.codes).toEqual([2]);
      expect(scope.totalPresent).toBe(3);
    }
  });

  it('intersects visible with present (ignores visible-but-absent codes)', () => {
    // 9 is visible but not present, so it must not appear in the scope.
    const scope = scopeFrom([2, 9], [2, 3, 5], nameOf);
    expect(scope.kind).toBe('subset');
    if (scope.kind === 'subset') {
      expect(scope.codes).toEqual([2]);
      expect(scope.totalPresent).toBe(3);
    }
  });
});

describe('scopeStamp(subset)', () => {
  it('stamps names joined by " + " with "k of m classes"', () => {
    const scope: ClassScope = {
      kind: 'subset',
      codes: [2],
      totalPresent: 3,
    };
    expect(scopeStamp(scope, nameOf)).toBe('ground · 1 of 3 classes');
  });

  it('joins multiple names with " + "', () => {
    const scope: ClassScope = {
      kind: 'subset',
      codes: [2, 5],
      totalPresent: 3,
    };
    expect(scopeStamp(scope, nameOf)).toBe('ground + high veg · 2 of 3 classes');
  });
});

describe('notScoped sentinel', () => {
  it('stamps the honesty disclaimer for an un-scopeable header metric', () => {
    expect(scopeStamp(notScopedSentinel(), nameOf)).toBe(
      'full cloud (header) — not class-scoped',
    );
  });

  it('factory returns the notScoped kind', () => {
    expect(notScopedSentinel().kind).toBe('notScoped');
  });
});
