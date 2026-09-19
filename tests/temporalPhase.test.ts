import { describe, it, expect } from 'vitest';
import {
  temporalPhase,
  drawnThisPhase,
  DEFAULT_PHASE_COUNT,
  type PhaseCount,
} from '../src/render/continuity/temporalPhase';
import { fadeHashUnit } from '../src/render/streaming/fadeDither';

const COUNTS: PhaseCount[] = [2, 4, 8];

describe('temporalPhase', () => {
  it('defaults to four phases', () => {
    expect(DEFAULT_PHASE_COUNT).toBe(4);
  });

  it.each(COUNTS)('lands inside [0, k) for k=%i', (k) => {
    for (let i = 0; i < 20000; i++) {
      const p = temporalPhase(i, 0, k);
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(k);
    }
  });

  // The whole point of the partition: the phase depends on identity alone, so
  // asking twice, or a thousand frames apart, gives the same answer.
  it('is stable for a given point and seed', () => {
    for (let i = 0; i < 500; i++) {
      expect(temporalPhase(i, 7)).toBe(temporalPhase(i, 7));
    }
  });

  it('reuses the existing dither hash rather than a second one', () => {
    for (let i = 0; i < 500; i++) {
      expect(temporalPhase(i, 3, 4)).toBe(Math.floor(4 * fadeHashUnit(i + 3)));
    }
  });

  // A hash that clusters would defeat the purpose: a frame would draw a
  // contiguous block of a node rather than a spread across it.
  it.each(COUNTS)('spreads points evenly across k=%i', (k) => {
    const n = 40000;
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) counts[temporalPhase(i, 0, k)]++;
    const expected = n / k;
    for (const c of counts) expect(Math.abs(c - expected) / expected).toBeLessThan(0.01);
  });

  it('gives two nodes different phases for the same instance index', () => {
    const a = Array.from({ length: 200 }, (_, i) => temporalPhase(i, 0));
    const b = Array.from({ length: 200 }, (_, i) => temporalPhase(i, 1));
    expect(a).not.toEqual(b);
  });

  // Every point must be drawn by exactly one phase of a sweep. A point in no
  // phase never appears; a point in two is drawn twice.
  it.each(COUNTS)('assigns each point exactly one phase of k=%i', (k) => {
    for (let i = 0; i < 2000; i++) {
      const drawn = Array.from({ length: k }, (_, p) => drawnThisPhase(i, 5, p, k));
      expect(drawn.filter(Boolean).length).toBe(1);
    }
  });

  // No clamp guards the top of the range, so the reason it cannot be exceeded
  // is pinned here. Scaling a double by a power of two shifts its exponent and
  // rounds nothing, so the largest hash below 1 stays below the count. A phase
  // equal to the count would be drawn by no frame and the point would vanish.
  it.each(COUNTS)('cannot reach k=%i even at the largest hash below 1', (k) => {
    const maxHash = 1 - Number.EPSILON / 2;
    expect(k * maxHash).toBeLessThan(k);
    expect(Math.floor(k * maxHash)).toBe(k - 1);
  });

  it('admits only power-of-two phase counts, which is what makes that exact', () => {
    for (const k of COUNTS) expect(Number.isInteger(Math.log2(k))).toBe(true);
  });
});
