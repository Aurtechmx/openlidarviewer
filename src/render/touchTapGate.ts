/**
 * touchTapGate.ts — recognises a clean single-finger double-tap from raw pointer
 * events, keeping that bookkeeping out of the Viewer.
 *
 * Owns the whole "was this a tap, and did two of them make a double-tap" state
 * machine: the per-sequence down position, a drag-slop flag, a multi-touch flag
 * (a pinch or two-finger pan is never a tap), and the double-tap timing (via
 * DoubleTapDetector). The Viewer feeds it pointer down/move/up with the current
 * touch-point count and gets back the focus location on a recognised double-tap,
 * or null. Pure aside from the caller-supplied timestamp — tests in Node.
 */

import { DoubleTapDetector } from './doubleTapDetector';

const DRAG_SLOP_SQ = 100; // (10 px)^2 — beyond this a touch is a drag, not a tap

export interface TapPoint {
  readonly x: number;
  readonly y: number;
}

export class TouchTapGate {
  private readonly _dbl = new DoubleTapDetector();
  private _downX = 0;
  private _downY = 0;
  private _moved = false;
  private _seqHadTwo = false;

  /** A finger went down; `pointerCount` is the count AFTER this down. */
  down(pointerCount: number, x: number, y: number): void {
    if (pointerCount === 1) {
      this._downX = x;
      this._downY = y;
      this._moved = false;
      this._seqHadTwo = false;
    } else if (pointerCount >= 2) {
      this._seqHadTwo = true; // a pinch / two-finger pan — never a tap
    }
  }

  /** A finger moved; once it passes the drag slop the sequence is not a tap. */
  move(x: number, y: number): void {
    if (this._moved) return;
    const dx = x - this._downX;
    const dy = y - this._downY;
    if (dx * dx + dy * dy > DRAG_SLOP_SQ) this._moved = true;
  }

  /**
   * A finger lifted at time `t` (ms); `pointerCount` is the count AFTER this up.
   * Returns the point to focus on when a clean single-finger double-tap
   * completes (whole sequence lifted, no drag, no second finger), else null.
   */
  up(pointerCount: number, t: number, x: number, y: number): TapPoint | null {
    let hit: TapPoint | null = null;
    if (pointerCount === 0 && !this._moved && !this._seqHadTwo && this._dbl.tap(t, x, y)) {
      hit = { x, y };
    }
    if (pointerCount === 0) this._seqHadTwo = false; // sequence ended
    return hit;
  }

  /** Forget any pending tap (tool takes the canvas, viewer disposes). */
  reset(): void {
    this._dbl.reset();
    this._moved = false;
    this._seqHadTwo = false;
  }
}
