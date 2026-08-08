/**
 * doubleTapDetector.test.ts — the touch double-tap timing state machine.
 */

import { describe, it, expect } from 'vitest';
import { DoubleTapDetector } from '../src/render/doubleTapDetector';

describe('DoubleTapDetector', () => {
  it('reports a double-tap for two quick taps at the same spot', () => {
    const d = new DoubleTapDetector();
    expect(d.tap(1000, 100, 100)).toBe(false); // first tap
    expect(d.tap(1200, 105, 98)).toBe(true); // 200 ms later, 5 px away → double
  });

  it('does not fire when the taps are too far apart in time', () => {
    const d = new DoubleTapDetector(300, 30);
    expect(d.tap(1000, 100, 100)).toBe(false);
    expect(d.tap(1400, 100, 100)).toBe(false); // 400 ms > 300 ms
  });

  it('does not fire when the taps are too far apart in space', () => {
    const d = new DoubleTapDetector(300, 30);
    expect(d.tap(1000, 100, 100)).toBe(false);
    expect(d.tap(1100, 200, 100)).toBe(false); // 100 px > 30 px
  });

  it('consumes a double-tap so three taps read as one double plus a fresh single', () => {
    const d = new DoubleTapDetector();
    expect(d.tap(1000, 50, 50)).toBe(false);
    expect(d.tap(1100, 50, 50)).toBe(true); // double
    expect(d.tap(1200, 50, 50)).toBe(false); // consumed → this is a fresh first tap
    expect(d.tap(1300, 50, 50)).toBe(true); // and this completes the next double
  });

  it('a far tap becomes the new anchor, so the next nearby tap can complete a double', () => {
    const d = new DoubleTapDetector(300, 30);
    expect(d.tap(1000, 100, 100)).toBe(false);
    expect(d.tap(1100, 300, 300)).toBe(false); // too far → new anchor
    expect(d.tap(1200, 305, 300)).toBe(true); // near the new anchor → double
  });

  it('reset clears the pending tap', () => {
    const d = new DoubleTapDetector();
    expect(d.tap(1000, 10, 10)).toBe(false);
    d.reset();
    expect(d.tap(1100, 10, 10)).toBe(false); // no pending anchor after reset
  });
});
