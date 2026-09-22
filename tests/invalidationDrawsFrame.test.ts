/**
 * invalidationDrawsFrame.test.ts: a reason that wakes the loop gets a paint.
 *
 * The loop used to call `consumeOnce()` at the top of the frame, which cleared
 * the once-reasons and reported nothing. `shouldRender` then had no idea the
 * frame had been requested on purpose, so a `style` or `tool-overlay`
 * invalidation could wake a sleeping viewer and lose its frame to the idle
 * throttle. That is worse than never asking: the change a once-reason
 * describes has already happened, and nothing will raise it a second time.
 *
 * The loop serves the frame now. These tests drive the real scheduler with a
 * hand-cranked clock and frame queue, so what is measured is the actual
 * wake-serve-draw-sleep path rather than a description of it.
 */
import { describe, expect, it } from 'vitest';

import { FrameDemand, type SchedulerFactory } from '../src/render/frameDemand';
import { RENDER_HOLDOVER_MS } from '../src/render/renderActivityGate';
import { FrameScheduler } from '../src/render/frameScheduler';
import { ALL_INVALIDATION_REASONS, KIND } from '../src/render/renderInvalidation';

/** A scheduler whose frames and timers only advance when the test says so. */
class Crank {
  now = 0;
  private _frame: (() => void) | null = null;
  private _timer: { at: number; cb: () => void } | null = null;
  private _next = 1;

  readonly factory: SchedulerFactory = (hooks) =>
    new FrameScheduler({
      requestFrame: (cb) => { this._frame = cb; return this._next++; },
      cancelFrame: () => { this._frame = null; },
      setTimer: (cb, ms) => { this._timer = { at: this.now + ms, cb }; return this._next++; },
      clearTimer: () => { this._timer = null; },
      nowMs: hooks.nowMs,
      needsFrame: hooks.needsFrame,
      runFrame: hooks.runFrame,
    });

  /** Run the next animation frame, if one is scheduled. */
  tick(): boolean {
    const f = this._frame;
    if (!f) return false;
    this._frame = null;
    f();
    return true;
  }

  /** Jump to the pending timer and fire it, which is the heartbeat waking. */
  fireTimer(): boolean {
    const t = this._timer;
    if (!t) return false;
    this._timer = null;
    this.now = t.at;
    t.cb();
    return true;
  }

  get sleeping(): boolean { return this._frame === null && this._timer !== null; }
}

/** A demand with every live signal quiet, driven by `crank`. */
function driven() {
  const crank = new Crank();
  const draws: number[] = [];
  const d = new FrameDemand({
    nowMs: () => crank.now,
    tweening: () => false,
    streamingBusy: () => false,
    commitPending: () => false,
    fading: () => false,
  }, crank.factory);
  // One loop iteration: ask the gate, record the paint, tell the gate.
  d.start(() => {
    if (d.shouldRender()) { draws.push(crank.now); d.gate.noteRendered(); d.frameDrawn(); }
    else d.gate.noteSkipped();
  });
  crank.tick();          // the scheduler's first frame is unconditional
  draws.length = 0;      // and is not what these tests are about
  return { crank, draws, d };
}

describe('a once-reason is never consumed without a paint', () => {
  const onceReasons = ALL_INVALIDATION_REASONS.filter((r) => KIND[r] === 'once');

  it('covers every once-reason the table declares', () => {
    expect(onceReasons).toEqual(
      expect.arrayContaining(['style', 'filter', 'clip', 'viewport', 'tool-overlay', 'streaming-ready']),
    );
  });

  it.each(onceReasons)('%s wakes a sleeping loop and draws exactly once', (reason) => {
    const { crank, draws, d } = driven();
    // Settle: frames keep being requested until nothing asks, then it sleeps.
    while (crank.tick());
    expect(crank.sleeping).toBe(true);
    draws.length = 0;

    d.changed(reason);
    expect(crank.tick()).toBe(true);
    expect(draws, `${reason} produced no paint`).toHaveLength(1);

    // And it settles again rather than spinning on a reason already served.
    while (crank.tick());
    expect(draws).toHaveLength(1);
    expect(crank.sleeping).toBe(true);
  });
});

describe('a while-reason draws for as long as it is held', () => {
  it('draws each frame while held, then lets the loop sleep once released', () => {
    const { crank, draws, d } = driven();
    while (crank.tick());
    draws.length = 0;

    d.changed('gpu-commit-pending');
    for (let i = 0; i < 4; i++) expect(crank.tick()).toBe(true);
    expect(draws.length).toBeGreaterThanOrEqual(4);

    const drawnWhileHeld = draws.length;
    d.finished('gpu-commit-pending');
    while (crank.tick());
    expect(crank.sleeping).toBe(true);
    // A held reason that is never released is a loop that never sleeps, which
    // is the battery bug on the other side of this contract.
    expect(draws.length).toBeGreaterThanOrEqual(drawnWhileHeld);
  });
});

describe('the heartbeat is still the backstop', () => {
  it('draws without any reason once the idle counter comes round', () => {
    const { crank, draws } = driven();
    while (crank.tick());
    draws.length = 0;
    // Nothing asked. Only the timer can restart the loop, and the gate only
    // yields after its idle count, which is what keeps a missed wake bounded.
    for (let i = 0; i < 12 && draws.length === 0; i++) {
      crank.fireTimer();
      while (crank.tick());
    }
    expect(draws.length).toBeGreaterThan(0);
  });
});

/**
 * The defect that sent the visual setters from `input()` to a reason.
 *
 * `input()` extends the activity holdover and records `camera-input`, a
 * holdover reason. The gate's only check for it is `now < activityUntilMs`,
 * 350 ms wide. A browser is free to run the woken frame later than that: a
 * busy main thread, a throttled tab, a slow first frame after a panel
 * re-render. When it does, the gate finds the window expired, skips the
 * paint, and nothing raises the change again, because the mutation already
 * happened. Toggling a class left the mask written and the picture stale.
 *
 * Measured in a browser before the fix: a class-visibility toggle drew on 2 of
 * 8 attempts on a settled scene, with the frame arriving about a second after
 * the click. A once-reason is held until a frame serves it, so the same delay
 * costs a late paint rather than no paint.
 */
describe('a delayed frame still paints what asked for it', () => {
  const LATE_MS = RENDER_HOLDOVER_MS + 50;

  it('loses the paint when only the activity holdover asked', () => {
    // Kept as the contrast: this is what the four setters used to do, and why
    // the picture could stay stale. If this ever starts passing, the gate has
    // gained another way through and the reason below is no longer load-bearing.
    const { crank, draws, d } = driven();
    while (crank.tick());
    draws.length = 0;
    d.input();
    crank.now += LATE_MS;
    crank.tick();
    expect(draws).toHaveLength(0);
  });

  it.each(['filter', 'clip', 'style'] as const)('keeps the paint when %s asked', (reason) => {
    const { crank, draws, d } = driven();
    while (crank.tick());
    draws.length = 0;
    d.changed(reason);
    crank.now += LATE_MS;
    expect(crank.tick()).toBe(true);
    expect(draws, `${reason} lost its paint to a late frame`).toHaveLength(1);
  });
});
