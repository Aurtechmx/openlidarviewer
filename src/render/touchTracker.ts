/**
 * touchTracker.ts — the two-finger tracking state machine.
 *
 * Lifted out of `Viewer._onCanvasPointerMove`, where it was inlined among the
 * DOM concerns (pointerType gating, pointer capture, render bumps). Those stay
 * on the Viewer; this owns only the pure part: the map of active touch points
 * and the decision, on each move, of whether two fingers form a gesture.
 *
 * It runs the already-extracted `decompose2Pointer` and returns a delta the
 * Viewer applies to the camera, or null when there is nothing to apply. It
 * never sees a DOM event, so it tests in Node — which is the point, since the
 * cases that break a two-finger recogniser (a third finger, one lifting
 * mid-gesture, a move from a pointer that was never tracked) are exactly the
 * ones a touchscreen-only test could not reach.
 */

import { decompose2Pointer, isZero } from './touchGesture';
import type { GestureDelta, GestureThresholds } from './touchGesture';

interface TrackedPoint {
  x: number;
  y: number;
}

export class TouchTracker {
  private readonly _points = new Map<number, TrackedPoint>();
  private readonly _thresholds?: GestureThresholds;

  /** Optional custom thresholds; defaults match `decompose2Pointer`. */
  constructor(thresholds?: GestureThresholds) {
    this._thresholds = thresholds;
  }

  /** How many touch points are currently down. */
  get size(): number {
    return this._points.size;
  }

  /** Record a finger going down at canvas-local (x, y). */
  down(id: number, x: number, y: number): void {
    this._points.set(id, { x, y });
  }

  /** Drop a finger. Unknown id is a no-op — an up can outlive its down. */
  up(id: number): void {
    this._points.delete(id);
  }

  /** Forget every tracked finger (tool takes the canvas, viewer disposes). */
  clear(): void {
    this._points.clear();
  }

  /**
   * Report a move for finger `id`, and get back the gesture to apply, or null.
   *
   * Null when: the pointer was never tracked; fewer or more than two fingers
   * are down (the model is strictly two-pointer, so three is ambiguous); or
   * the resulting delta is below the recogniser's noise thresholds.
   *
   * The moved finger's stored position is updated ONLY when it was already
   * tracked, so an untracked move cannot smuggle a third point into the map.
   */
  move(id: number, x: number, y: number): GestureDelta | null {
    const prev = this._points.get(id);
    if (!prev) return null;

    const cur: TrackedPoint = { x, y };

    // Two-pointer gesture: needs the moved finger plus exactly one other.
    if (this._points.size === 2) {
      let other: TrackedPoint | null = null;
      for (const [otherId, p] of this._points) {
        if (otherId !== id) {
          other = p;
          break;
        }
      }
      if (other) {
        // The other finger stays put for this frame; its own move runs later
        // in the same tick. Measure prev->cur for the mover against a still
        // other point.
        const delta = decompose2Pointer(prev, other, cur, other, this._thresholds);
        this._points.set(id, cur);
        return isZero(delta) ? null : delta;
      }
    }

    // Not a two-finger frame — still record the position so a later return to
    // two fingers measures from where this one actually is.
    this._points.set(id, cur);
    return null;
  }
}
