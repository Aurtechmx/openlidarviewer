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

describe('a sweep covers the image exactly once', () => {
  it('draws every point in exactly one phase', () => {
    // The property the accumulation rests on. A point in no phase is missing
    // from the finished image; a point in two is drawn twice into a history
    // that is meant to be the sum of one pass over the samples.
    for (const phaseCount of COUNTS) {
      for (const seed of [0, 7, 1234]) {
        for (let i = 0; i < 4096; i++) {
          let drawn = 0;
          for (let phase = 0; phase < phaseCount; phase++) {
            if (drawnThisPhase(i, seed, phase, phaseCount)) drawn += 1;
          }
          expect(drawn, `point ${i} at ${phaseCount} phases, seed ${seed}`).toBe(1);
        }
      }
    }
  });

  it('never assigns a phase outside the range', () => {
    for (const phaseCount of COUNTS) {
      for (let i = 0; i < 4096; i++) {
        const phase = temporalPhase(i, 11, phaseCount);
        expect(Number.isInteger(phase)).toBe(true);
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(phaseCount);
      }
    }
  });

  it('splits the work evenly enough that no frame carries a spike', () => {
    // The Weyl sequence is low-discrepancy, so each phase should take close to
    // its share. A partition that did not would show as one slow frame in
    // every sweep, which is the thing phases exist to avoid.
    for (const phaseCount of COUNTS) {
      const counts = new Array(phaseCount).fill(0);
      const points = 8192;
      for (let i = 0; i < points; i++) counts[temporalPhase(i, 5, phaseCount)] += 1;
      const share = points / phaseCount;
      for (const c of counts) expect(Math.abs(c - share) / share).toBeLessThan(0.01);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(points);
    }
  });

  it('depends on the point and its node, and on nothing else', () => {
    // No frame number and no clock: a partition that re-rolled per frame would
    // move points between phases mid-sweep and the image would sparkle.
    const first = Array.from({ length: 256 }, (_, i) => temporalPhase(i, 3, 4));
    for (let repeat = 0; repeat < 5; repeat++) {
      const again = Array.from({ length: 256 }, (_, i) => temporalPhase(i, 3, 4));
      expect(again).toEqual(first);
    }
  });
});
