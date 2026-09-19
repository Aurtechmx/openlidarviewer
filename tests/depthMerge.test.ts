import { describe, it, expect } from 'vitest';
import {
  mergeDecision,
  depthCompatible,
  DEFAULT_DEPTH_EPSILON,
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
