/**
 * touchGestureAccumulation.test.ts — a slow gesture is still a gesture.
 *
 * Deltas were measured between CONSECUTIVE pointer events, and the stored
 * position advanced whether or not the dead zone was crossed. Motion slower
 * than the threshold per event was measured, discarded, and forgotten. A
 * deliberate two-finger pan of 100 px, delivered a pixel at a time, emitted
 * nothing at all — and because the loss is per event, the same physical gesture
 * worked or failed depending on how fast the device reported it.
 *
 * The rule now is that the dead zone rejects JITTER, not intent: sub-threshold
 * movement accumulates against a baseline that only advances when its own
 * component fires. Each component keeps its own baseline, so a pan crossing its
 * threshold cannot re-anchor a pinch that is still accumulating.
 */

import { describe, it, expect } from 'vitest';
import { TouchTracker } from '../src/render/touchTracker';
import { DEFAULT_GESTURE_THRESHOLDS } from '../src/render/touchGesture';

/** Two fingers down, 100 px apart on the x axis. */
function twoDown(): TouchTracker {
  const t = new TouchTracker();
  t.down(1, 0, 0);
  t.down(2, 100, 0);
  return t;
}

describe('a slow two-finger pan', () => {
  it('is not lost when delivered one pixel at a time', () => {
    const t = twoDown();
    let panY = 0;
    for (let y = 1; y <= 100; y += 1) {
      for (const d of [t.move(1, 0, y), t.move(2, 100, y)]) if (d) panY += d.dPan.y;
    }
    // The recogniser cannot emit the final sub-threshold remainder, so the
    // total lands within one dead zone of the 100 px the fingers travelled.
    expect(panY).toBeGreaterThan(100 - DEFAULT_GESTURE_THRESHOLDS.panDeadZone * 2);
    expect(panY).toBeLessThanOrEqual(100);
  });

  it('reports the same total however finely the events are divided', () => {
    // The defect made the outcome depend on event rate: the same physical
    // gesture worked on a device that reported coarsely and vanished on one
    // that reported finely.
    const total = (steps: number): number => {
      const t = twoDown();
      let sum = 0;
      for (let i = 1; i <= steps; i += 1) {
        const y = (100 * i) / steps;
        for (const d of [t.move(1, 0, y), t.move(2, 100, y)]) if (d) sum += d.dPan.y;
      }
      return sum;
    };
    const coarse = total(5);
    const fine = total(200);
    expect(fine).toBeGreaterThan(coarse - DEFAULT_GESTURE_THRESHOLDS.panDeadZone * 2);
    expect(fine).toBeLessThanOrEqual(coarse + 1e-9);
  });
});

describe('the dead zone still rejects jitter', () => {
  it('emits nothing while a finger wobbles about its resting place', () => {
    const t = twoDown();
    let emitted = 0;
    // Sub-pixel oscillation never departs from the baseline, so it never
    // accumulates: this is the wobble the dead zone exists to absorb.
    for (let i = 0; i < 200; i += 1) {
      if (t.move(1, 0, i % 2 === 0 ? 0.4 : -0.4)) emitted += 1;
    }
    expect(emitted).toBe(0);
  });

  it('still suppresses a move that changes nothing', () => {
    const t = twoDown();
    expect(t.move(2, 100, 0)).toBeNull();
  });
});

describe('components accumulate independently', () => {
  it('lets a slow pinch survive a pan that fires first', () => {
    // Both fingers drift down together (a pan) while separating very slowly (a
    // pinch). With one shared baseline, every pan emission re-anchored the
    // pinch and it could never reach its own threshold.
    const t = twoDown();
    let pinch = 0;
    for (let i = 1; i <= 60; i += 1) {
      const spread = i * 0.25;
      const drift = i * 2;
      for (const d of [t.move(1, -spread, drift), t.move(2, 100 + spread, drift)]) {
        if (d) pinch += d.dPinch;
      }
    }
    expect(pinch).toBeGreaterThan(0);
  });
});

describe('changing fingers re-anchors rather than jumping', () => {
  it('does not emit a jump when a second finger arrives late', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.move(1, 0, 500); // a long one-finger drag: no two-finger gesture at all
    t.down(2, 100, 500);
    // The pair starts here. A baseline carried from before would report the
    // 500 px the first finger travelled alone.
    expect(t.move(2, 100, 501)).toBeNull();
  });

  it('re-anchors when a third finger joins and leaves', () => {
    const t = twoDown();
    t.down(3, 50, 400);
    expect(t.move(1, 0, 40)).toBeNull(); // three fingers: ambiguous, stays quiet
    t.up(3);
    // Back to two, measured from where they are now, not from before the third.
    expect(t.move(1, 0, 41)).toBeNull();
  });
});

describe('a stray event does not discard accumulated movement', () => {
  it('treats an up for a finger that was never down as a real no-op', () => {
    // The contract on `up` says an unknown id is a no-op — "an up can outlive
    // its down". Re-anchoring on it made that false: the stray event reset all
    // three components and a slow pan lost a third of its travel.
    const pan = (stray: boolean): number => {
      const t = twoDown();
      let sum = 0;
      for (let y = 1; y <= 20; y += 1) {
        if (stray && y === 10) t.up(99);
        for (const d of [t.move(1, 0, y), t.move(2, 100, y)]) if (d) sum += d.dPan.y;
      }
      return sum;
    };
    expect(pan(true)).toBe(pan(false));
  });

  it('treats a repeat down for a tracked finger as a position report', () => {
    const t = twoDown();
    let sum = 0;
    for (let y = 1; y <= 20; y += 1) {
      if (y === 10) t.down(1, 0, y); // same finger, no up in between
      for (const d of [t.move(1, 0, y), t.move(2, 100, y)]) if (d) sum += d.dPan.y;
    }
    expect(sum).toBeGreaterThan(20 - DEFAULT_GESTURE_THRESHOLDS.panDeadZone * 2);
  });

  it('still re-anchors when a finger genuinely leaves the pair', () => {
    const t = twoDown();
    t.move(1, 0, 4); // sub-threshold, accumulating
    t.up(2);         // the pair is gone
    t.down(3, 200, 200);
    // Measured from the NEW pair, not from anything the old one had banked.
    expect(t.move(1, 0, 5)).toBeNull();
  });
});
