/**
 * doubleTapDetector.ts — the double-tap timing state machine.
 *
 * On a touchscreen the browser's `dblclick` event does not reach a canvas that
 * carries `touch-action: none` and captures its pointers (the case on iOS/
 * WebKit, which is every browser on iPhone). So the double-tap that focuses the
 * camera on a point has to be recognised from the raw taps. This owns only that
 * decision — the time-and-distance test between two completed single taps — and
 * sees no DOM event, so it tests in Node.
 *
 * The Viewer feeds it only CLEAN single taps: one finger, no drag, no second
 * finger during the sequence. This keeps a pinch or an orbit-drag from ever
 * being read as a tap, and leaves this file with just the pure question: did
 * this tap land soon enough and close enough to the last one to be a double?
 */

export class DoubleTapDetector {
  private _lastMs = -Infinity;
  private _lastX = 0;
  private _lastY = 0;
  private readonly maxGapMs: number;
  private readonly maxDistPx: number;

  /**
   * @param maxGapMs  Two taps farther apart in time than this are separate.
   * @param maxDistPx Two taps farther apart in space than this are separate.
   */
  constructor(maxGapMs = 300, maxDistPx = 30) {
    this.maxGapMs = maxGapMs;
    this.maxDistPx = maxDistPx;
  }

  /**
   * Register a completed single tap at time `t` (ms) and canvas-local (x, y).
   * Returns true when it completes a double-tap with the previous tap.
   *
   * A recognised double-tap CONSUMES the state, so three taps in a row read as
   * one double-tap plus a fresh single tap — never two overlapping doubles.
   */
  tap(t: number, x: number, y: number): boolean {
    const dx = x - this._lastX;
    const dy = y - this._lastY;
    const inTime = t - this._lastMs <= this.maxGapMs;
    const inRange = dx * dx + dy * dy <= this.maxDistPx * this.maxDistPx;
    if (inTime && inRange) {
      this._lastMs = -Infinity; // consume, so a third tap starts clean
      return true;
    }
    this._lastMs = t;
    this._lastX = x;
    this._lastY = y;
    return false;
  }

  /** Forget the pending tap (tool takes the canvas, viewer disposes). */
  reset(): void {
    this._lastMs = -Infinity;
  }
}
