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

/**
 * The finger positions a component's next delta is measured from, keyed by
 * pointer id.
 *
 * Keyed, not an (a, b) pair: the pair has to be handed to `decompose2Pointer`
 * in the SAME finger order as the baseline it is compared against. Ordered by
 * anything else — insertion order on one side, mover-first on the other — the
 * two fingers can swap between the two arguments, which leaves distance and
 * midpoint unchanged but flips the segment's angle by π and reports a large
 * twist for a gesture that did not rotate.
 */
type Baseline = Map<number, TrackedPoint>;

/** The three gesture components, each tracked from its own baseline. */
type Component = 'pan' | 'pinch' | 'twist';
const COMPONENTS: readonly Component[] = ['pan', 'pinch', 'twist'];

export class TouchTracker {
  private readonly _points = new Map<number, TrackedPoint>();
  private readonly _thresholds?: GestureThresholds;
  /**
   * Where each component last emitted from.
   *
   * Deltas were measured between CONSECUTIVE events, and the stored position
   * advanced whether or not the dead zone was crossed. Motion slower than the
   * threshold per event was therefore measured, discarded and forgotten: a
   * deliberate 100 px two-finger pan delivered in 1 px steps emitted nothing at
   * all, and the slower the gesture the more completely it was lost. Movement
   * now accumulates against a baseline that only moves when its component
   * actually fires, so the dead zone rejects jitter without rejecting intent.
   *
   * One baseline PER COMPONENT. They share two fingers but not one intent:
   * with a single baseline, a pan crossing its dead zone would re-anchor the
   * slowly accumulating pinch and twist along with it.
   */
  private _base: Record<Component, Baseline> | null = null;

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
    this._resetBaselines();
  }

  /** Drop a finger. Unknown id is a no-op — an up can outlive its down. */
  up(id: number): void {
    this._points.delete(id);
    this._resetBaselines();
  }

  /** Forget every tracked finger (tool takes the canvas, viewer disposes). */
  clear(): void {
    this._points.clear();
    this._base = null;
  }

  /**
   * Re-anchor every component wherever the fingers are now.
   *
   * Runs whenever the set of fingers changes. A baseline carried across a
   * finger going down or up would measure from a pair that no longer exists,
   * and the first move of the new pair would jump.
   */
  private _resetBaselines(): void {
    if (this._points.size !== 2) {
      this._base = null;
      return;
    }
    const snap = (): Baseline => new Map(
      [...this._points].map(([pid, p]) => [pid, { ...p }]),
    );
    this._base = { pan: snap(), pinch: snap(), twist: snap() };
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
    // The live position always advances: it is where the finger IS. The
    // baselines below are where each component last measured FROM.
    this._points.set(id, cur);

    // Two-pointer gesture: needs the moved finger plus exactly one other.
    const base = this._base;
    if (this._points.size !== 2 || !base) return null;
    let other: TrackedPoint | null = null;
    let otherId = -1;
    for (const [pid, p] of this._points) {
      if (pid !== id) { other = p; otherId = pid; break; }
    }
    if (!other) return null;

    const out: GestureDelta = { dPinch: 0, dTwist: 0, dPan: { x: 0, y: 0 } };
    for (const c of COMPONENTS) {
      // From THIS component's baseline to where both fingers are now, so
      // movement too small to cross the dead zone is carried, not dropped.
      const from = base[c];
      const baseMover = from.get(id);
      const baseOther = from.get(otherId);
      if (!baseMover || !baseOther) continue;
      // Mover and other in the same slots on both sides, so the angle is
      // measured between comparable segments.
      const d = decompose2Pointer(baseMover, baseOther, cur, other, this._thresholds);
      let fired = false;
      if (c === 'pinch' && d.dPinch !== 0) { out.dPinch = d.dPinch; fired = true; }
      if (c === 'twist' && d.dTwist !== 0) { out.dTwist = d.dTwist; fired = true; }
      if (c === 'pan' && (d.dPan.x !== 0 || d.dPan.y !== 0)) { out.dPan = d.dPan; fired = true; }
      // Only a component that fired re-anchors; the others keep accumulating.
      if (fired) base[c] = new Map([[id, { ...cur }], [otherId, { ...other }]]);
    }
    return isZero(out) ? null : out;
  }
}
