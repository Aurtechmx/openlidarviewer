import { describe, it, expect } from 'vitest';
import {
  mergeDecision,
  depthCompatible,
  DEFAULT_DEPTH_EPSILON,
  type ColorSemantics,
} from '../src/render/continuity/depthMerge';

const EPS = DEFAULT_DEPTH_EPSILON;

describe('depthCompatible', () => {
  it('holds a surface together at its own depth', () => {
    expect(depthCompatible(10, 10)).toBe(true);
    expect(depthCompatible(10, 10 * 2 ** (EPS / 2))).toBe(true);
  });

  it('separates depths beyond the tolerance', () => {
    expect(depthCompatible(10, 10 * 2 ** (EPS * 2))).toBe(false);
    expect(depthCompatible(10, 40)).toBe(false);
  });

  // The reason for comparing logarithms: the same fractional gap has to read the
  // same next to the camera and across a valley. A world-unit epsilon cannot.
  it('applies the same relative tolerance at every scale', () => {
    const ratioInside = 2 ** (EPS / 2);
    const ratioOutside = 2 ** (EPS * 2);
    for (const z of [0.05, 1, 100, 10_000, 1e6]) {
      expect(depthCompatible(z, z * ratioInside)).toBe(true);
      expect(depthCompatible(z, z * ratioOutside)).toBe(false);
    }
  });

  it('is symmetric', () => {
    for (const [a, b] of [[10, 10.1], [1, 50], [3, 3]]) {
      expect(depthCompatible(a, b)).toBe(depthCompatible(b, a));
    }
  });

  // log2(0) is -Infinity, and its difference with anything is Infinity or NaN.
  // NaN fails every comparison, so an unguarded test would answer "incompatible"
  // for a reason that has nothing to do with the surfaces.
  it.each([0, -1, -0, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a depth of %p rather than reaching log2',
    (bad) => {
      expect(depthCompatible(bad, 10)).toBe(false);
      expect(depthCompatible(10, bad)).toBe(false);
    },
  );
});

describe('mergeDecision', () => {
  it('accepts the first sample at an empty pixel', () => {
    expect(mergeDecision(10, 0, 0)).toBe('accept');
    expect(mergeDecision(10, 999, 0)).toBe('accept');
  });

  // A buffer cleared to a stale depth must not make a first sample lose to
  // nothing, so weight decides emptiness, not depth.
  it('treats zero weight as empty whatever the history depth says', () => {
    expect(mergeDecision(1000, 1, 0)).toBe('accept');
    expect(mergeDecision(1000, 1, -5)).toBe('accept');
  });

  it('replaces history the sample is clearly in front of', () => {
    expect(mergeDecision(5, 50, 1)).toBe('replace');
  });

  it('keeps history the sample is clearly behind', () => {
    expect(mergeDecision(50, 5, 1)).toBe('keep');
  });

  it('blends a sample on the same surface', () => {
    expect(mergeDecision(10, 10 * 2 ** (EPS / 2), 1)).toBe('blend');
    expect(mergeDecision(10, 10, 4)).toBe('blend');
  });

  it('keeps history against a degenerate sample depth', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(mergeDecision(bad, 10, 1)).toBe('keep');
    }
  });

  // The four outcomes have to partition: every input lands on exactly one, and
  // a pixel that should hold a near surface never ends up holding a far one.
  it('never discards the nearer surface', () => {
    for (const zs of [0.1, 1, 10, 100]) {
      for (const zh of [0.1, 1, 10, 100]) {
        const d = mergeDecision(zs, zh, 1);
        if (d === 'replace') expect(zs).toBeLessThan(zh);
        if (d === 'keep') expect(zs).toBeGreaterThan(zh);
        if (d === 'blend') expect(depthCompatible(zs, zh)).toBe(true);
      }
    }
  });

  it('honours a caller-supplied tolerance', () => {
    expect(mergeDecision(10, 12, 1)).toBe('replace');
    expect(mergeDecision(10, 12, 1, 1)).toBe('blend');
  });
});

describe('categorical colour', () => {
  const sameSurface = 10 * 2 ** (EPS / 2);

  // Classification numbers are labels. A colour between two of them is not a
  // value at all: it reads as a class the data does not contain, which is the
  // honesty gate the colour modes already apply, arriving through time.
  it('never blends two labels on one surface', () => {
    expect(mergeDecision(10, sameSurface, 1, EPS, 'categorical')).not.toBe('blend');
    expect(mergeDecision(10, sameSurface, 1, EPS, 'continuous')).toBe('blend');
  });

  it('takes the nearer label rather than making a third', () => {
    expect(mergeDecision(10, 10.05, 1, EPS, 'categorical')).toBe('replace');
    expect(mergeDecision(10.05, 10, 1, EPS, 'categorical')).toBe('keep');
  });

  // Without a deterministic tie-break a surface carrying two classes alternates
  // between them frame after frame, which is the sparkle the stable temporal
  // partition exists to prevent, returning through colour.
  it('settles an exact tie on what is already there', () => {
    expect(mergeDecision(10, 10, 1, EPS, 'categorical')).toBe('keep');
    for (let i = 0; i < 20; i++) expect(mergeDecision(10, 10, 1, EPS, 'categorical')).toBe('keep');
  });

  it.each(['continuous', 'categorical'] as ColorSemantics[])(
    'still accepts a first sample and still keeps a nearer history under %s',
    (semantics) => {
      expect(mergeDecision(10, 0, 0, EPS, semantics)).toBe('accept');
      expect(mergeDecision(50, 5, 1, EPS, semantics)).toBe('keep');
      expect(mergeDecision(5, 50, 1, EPS, semantics)).toBe('replace');
    },
  );

  it('defaults to continuous, so an unaware caller is unchanged', () => {
    expect(mergeDecision(10, sameSurface, 1, EPS)).toBe('blend');
  });
});
