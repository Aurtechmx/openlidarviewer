/**
 * tests/fadeDither.test.ts
 *
 * Locks the opaque screen-door dissolve maths that replaces the streaming
 * cross-fade's transparent alpha (the COPC-open flicker fix). The TSL size-graph
 * node in Viewer.ts mirrors these exactly, so a regression in the shader is
 * caught here rather than by watching a render.
 */

import { describe, it, expect } from 'vitest';
import { fadeHashUnit, fadeDitherKeep, PHI_CONJUGATE } from '../src/render/streaming/fadeDither';

describe('fadeHashUnit — per-instance dissolve hash', () => {
  it('always lands in [0, 1)', () => {
    for (let i = 0; i < 10000; i++) {
      const h = fadeHashUnit(i);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it('is deterministic', () => {
    expect(fadeHashUnit(42)).toBe(fadeHashUnit(42));
  });

  it('matches the TSL mirror formula fract(i · φ⁻¹)', () => {
    const i = 12345;
    const expected = i * PHI_CONJUGATE - Math.floor(i * PHI_CONJUGATE);
    expect(fadeHashUnit(i)).toBe(expected);
  });

  it('spreads consecutive indices across the interval (low-discrepancy)', () => {
    // Bucket the first 1000 hashes into tenths; a Weyl sequence fills every
    // bucket roughly evenly — no empty decile, none dominant.
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 1000; i++) buckets[Math.floor(fadeHashUnit(i) * 10)]++;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(50); // even fill would be 100 each
      expect(count).toBeLessThan(150);
    }
  });
});

describe('fadeDitherKeep — opaque discard decision', () => {
  it('keeps every point once fully faded in (progress >= 1)', () => {
    for (let i = 0; i < 1000; i++) expect(fadeDitherKeep(i, 1)).toBe(1);
  });

  it('discards every point when fully dissolved (progress <= 0)', () => {
    // hashUnit is in [0,1); at progress 0 only a hash of exactly 0 would keep,
    // and i·φ⁻¹ is never an integer for i>0, so nothing survives progress 0
    // except index 0 (hash 0). Check a representative non-zero range.
    for (let i = 1; i < 1000; i++) expect(fadeDitherKeep(i, 0)).toBe(0);
  });

  it('is monotonic in progress — a fade-in only ever adds points', () => {
    // A point visible at progress p must stay visible at any p2 > p (no
    // on/off flicker within a sweep). Check across a rising progress ramp.
    for (let i = 0; i < 500; i++) {
      let everDropped = false;
      let prevKeep = 0;
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const keep = fadeDitherKeep(i, p);
        if (keep < prevKeep) everDropped = true;
        prevKeep = keep;
      }
      expect(everDropped).toBe(false);
    }
  });

  it('reveals roughly `progress` fraction of points at a given step', () => {
    // At progress 0.5, about half the points should be kept (uniform hash).
    let kept = 0;
    const n = 4000;
    for (let i = 0; i < n; i++) kept += fadeDitherKeep(i, 0.5);
    expect(kept / n).toBeGreaterThan(0.45);
    expect(kept / n).toBeLessThan(0.55);
  });
});
