/**
 * touchTracker.test.ts — the two-finger tracking state machine, in Node.
 *
 * This logic lived inside `Viewer._onCanvasPointerMove`: keep a map of active
 * touch points, and on each move decide whether exactly two fingers are down,
 * which one is the OTHER finger, and whether the resulting gesture is worth
 * applying. It could only be exercised by a real touchscreen, so the cases
 * that actually break it — a third finger, one lifting mid-gesture, a move
 * from an untracked pointer — had no coverage.
 *
 * The tracker owns the map and returns a gesture delta or null. It never sees
 * a DOM event: the Viewer's handler still does pointerType gating, capture,
 * and render bumps, then hands (id, x, y) to these methods.
 */

import { describe, it, expect } from 'vitest';
import { TouchTracker } from '../src/render/touchTracker';

describe('TouchTracker', () => {
  it('emits nothing with a single finger down', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    expect(t.move(1, 10, 0)).toBeNull();
  });

  it('emits nothing for a move from an untracked pointer', () => {
    // A move can arrive for a pointer whose down was gated out (a mouse, or a
    // touch that came in while a tool owned the canvas). It must be ignored,
    // not treated as a fresh finger.
    const t = new TouchTracker();
    t.down(1, 0, 0);
    expect(t.move(2, 5, 5)).toBeNull();
    expect(t.size).toBe(1);
  });

  it('produces a pinch delta once two fingers are down and one moves', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    // Finger 2 slides outward: the pair spreads, so a pinch component appears.
    const delta = t.move(2, 140, 0);
    expect(delta).not.toBeNull();
    expect(delta!.dPinch).not.toBe(0);
  });

  it('updates the moved finger so the next move is measured from its new spot', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    t.move(2, 140, 0);
    // Second move is 140 -> 140: no change for finger 2, finger 1 still at 0.
    // Nothing moved, so the delta is zero and suppressed.
    expect(t.move(2, 140, 0)).toBeNull();
  });

  it('suppresses a zero gesture (a move that does not change the pair)', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    // Re-report finger 2 at its own position — no pinch, twist or pan.
    expect(t.move(2, 100, 0)).toBeNull();
  });

  it('goes quiet when a third finger joins — the model is two-pointer only', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    t.down(3, 50, 100);
    expect(t.size).toBe(3);
    // Three fingers: ambiguous which pair, so no gesture until back to two.
    expect(t.move(2, 140, 0)).toBeNull();
  });

  it('resumes two-finger gestures after a third finger lifts', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    t.down(3, 50, 100);
    t.up(3);
    expect(t.size).toBe(2);
    expect(t.move(2, 140, 0)).not.toBeNull();
  });

  it('does not emit when a finger lifts mid-gesture', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    t.up(1);
    // Only finger 2 remains; a move from it is a one-finger move now.
    expect(t.move(2, 140, 0)).toBeNull();
  });

  it('clear() drops every tracked pointer', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    t.down(2, 100, 0);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.move(2, 140, 0)).toBeNull();
  });

  it('an up for an unknown pointer is a no-op, not an error', () => {
    const t = new TouchTracker();
    t.down(1, 0, 0);
    expect(() => t.up(99)).not.toThrow();
    expect(t.size).toBe(1);
  });

  it('detects a twist when the pair rotates about its midpoint', () => {
    const t = new TouchTracker();
    t.down(1, -100, 0);
    t.down(2, 100, 0);
    // Rotate finger 2 up around the origin midpoint: introduces a twist.
    const delta = t.move(2, 100, 40);
    expect(delta).not.toBeNull();
    expect(delta!.dTwist).not.toBe(0);
  });
});
