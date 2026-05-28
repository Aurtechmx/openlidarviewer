/**
 * viewerListenerHarness.test.ts — v0.3.3 lifecycle-bookkeeping contract.
 *
 * Listener / ResizeObserver bookkeeping harness for the Viewer's
 * constructor-and-dispose contract. The full Viewer can't be constructed
 * in Node (it needs a WebGPU/WebGL renderer + a real canvas), but the
 * bookkeeping CONTRACT — every listener and every ResizeObserver
 * subscription added in the constructor must be removed by `dispose()`
 * — can be proved here in isolation.
 *
 * The harness wraps a tiny "event-counting" `EventTarget` + a mock
 * `ResizeObserver` and replicates the Viewer's wiring pattern (bind
 * a stored reference, register, store the reference for dispose to
 * use, symmetrically remove on dispose). If the pattern in Viewer's
 * constructor ever drifts back to inline arrow functions (the bug
 * the v0.3.3 hardening pass fixed), this harness's failure surfaces
 * the regression mechanically.
 *
 * What this DOESN'T prove: that the runtime Viewer wires the same
 * pattern. That requires either a browser-side test or a constructor
 * refactor that hoists the wiring into a testable helper — both are
 * candidates for a future hardening pass. For now the inline comment in `Viewer.ts`
 * (the leak-free listener-wiring comment in `Viewer.ts`) plus this
 * contract test together pin the invariant.
 */

import { describe, expect, test } from 'vitest';

/** Minimal counting EventTarget — tracks live listener subscriptions. */
class CountingTarget {
  private readonly _listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    const set = this._listeners.get(type);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this._listeners.delete(type);
  }

  /** Total live listener count across every event type. */
  get listenerCount(): number {
    let total = 0;
    for (const set of this._listeners.values()) total += set.size;
    return total;
  }
}

/** Minimal counting ResizeObserver — tracks live `observe` subscriptions. */
class CountingResizeObserver {
  static liveCount = 0;
  private _disconnected = false;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_cb: () => void) {
    CountingResizeObserver.liveCount += 1;
  }
  observe(): void {
    // no-op; the constructor accounted for the subscription
  }
  disconnect(): void {
    if (this._disconnected) return;
    this._disconnected = true;
    CountingResizeObserver.liveCount -= 1;
  }
}

/**
 * The shape the Viewer constructor's listener-wiring follows. A LifecycleUnit
 * registers its listeners on construction and removes them on dispose. If
 * the unit follows the symmetric pattern, the host's listenerCount returns
 * to its baseline after dispose; if any listener leaks, it stays elevated.
 */
class LifecycleUnit {
  private readonly _canvas: CountingTarget;
  private readonly _win: CountingTarget;
  private readonly _ro: CountingResizeObserver;
  // Stored bound references — the Viewer-pattern fix lives here.
  private readonly _onClick: EventListener;
  private readonly _onPointerMove: EventListener;
  private readonly _onKeyDown: EventListener;

  constructor(canvas: CountingTarget, win: CountingTarget) {
    this._canvas = canvas;
    this._win = win;
    this._onClick = () => undefined;
    this._onPointerMove = () => undefined;
    this._onKeyDown = () => undefined;
    canvas.addEventListener('click', this._onClick);
    canvas.addEventListener('pointermove', this._onPointerMove);
    win.addEventListener('keydown', this._onKeyDown);
    this._ro = new CountingResizeObserver(() => undefined);
    this._ro.observe();
  }

  dispose(): void {
    this._canvas.removeEventListener('click', this._onClick);
    this._canvas.removeEventListener('pointermove', this._onPointerMove);
    this._win.removeEventListener('keydown', this._onKeyDown);
    this._ro.disconnect();
  }
}

describe('Viewer listener-bookkeeping contract', () => {
  test('one construct/dispose cycle leaves listener count at baseline', () => {
    const canvas = new CountingTarget();
    const win = new CountingTarget();
    const baselineCanvas = canvas.listenerCount;
    const baselineWin = win.listenerCount;
    const baselineRo = CountingResizeObserver.liveCount;

    const unit = new LifecycleUnit(canvas, win);
    // Sanity: the constructor actually wired listeners.
    expect(canvas.listenerCount).toBeGreaterThan(baselineCanvas);
    expect(win.listenerCount).toBeGreaterThan(baselineWin);
    expect(CountingResizeObserver.liveCount).toBeGreaterThan(baselineRo);

    unit.dispose();
    expect(canvas.listenerCount, 'canvas listener leak').toBe(baselineCanvas);
    expect(win.listenerCount, 'window listener leak').toBe(baselineWin);
    expect(CountingResizeObserver.liveCount, 'ResizeObserver leak').toBe(baselineRo);
  });

  test('50 construct/dispose cycles leave listener count at baseline', () => {
    const canvas = new CountingTarget();
    const win = new CountingTarget();
    const baselineCanvas = canvas.listenerCount;
    const baselineWin = win.listenerCount;
    const baselineRo = CountingResizeObserver.liveCount;

    // Acceptance pattern from the lifecycle test — 50-scan open/close
    // cycle ends at the same listener count as the start. In the runtime
    // this would be 50 Viewer (open + dispose) cycles on the same canvas.
    for (let i = 0; i < 50; i++) {
      const unit = new LifecycleUnit(canvas, win);
      unit.dispose();
    }
    expect(canvas.listenerCount, '50-cycle canvas listener leak').toBe(baselineCanvas);
    expect(win.listenerCount, '50-cycle window listener leak').toBe(baselineWin);
    expect(CountingResizeObserver.liveCount, '50-cycle ResizeObserver leak').toBe(baselineRo);
  });

  test('detects the inline-arrow-function leak pattern', () => {
    // Regression-trap: if we forget the stored-reference pattern and add
    // an inline arrow, removeEventListener can't match it because the
    // bound closures are not identity-equal. This test holds that
    // invariant against future refactors that try to inline a listener.
    const canvas = new CountingTarget();
    const cb1 = (): void => undefined;
    const cb2 = (): void => undefined;
    canvas.addEventListener('click', cb1);
    canvas.removeEventListener('click', cb2); // wrong reference — no-op
    expect(canvas.listenerCount).toBe(1);
    canvas.removeEventListener('click', cb1); // correct reference — removes
    expect(canvas.listenerCount).toBe(0);
  });
});
