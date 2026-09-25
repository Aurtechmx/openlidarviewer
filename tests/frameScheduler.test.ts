import { describe, expect, it } from 'vitest';

import { FrameScheduler, IDLE_HEARTBEAT_MS, type FrameSchedulerHost } from '../src/render/frameScheduler';

/**
 * A fake clock, animation frame and timer. `flushFrame` and `flushTimer` are
 * the only ways time moves, so every test states exactly how many frames ran.
 */
class Harness {
  now = 0;
  frames = 0;
  timers = 0;
  wants = false;

  private _frame: (() => void) | null = null;
  private _timer: { at: number; cb: () => void } | null = null;
  private _nextHandle = 1;
  private _cancelled: number[] = [];

  readonly host: FrameSchedulerHost = {
    requestFrame: (cb) => { this._frame = cb; return this._nextHandle++; },
    cancelFrame: (handle) => { this._frame = null; this._cancelled.push(handle); },
    setTimer: (cb, ms) => { this._timer = { at: this.now + ms, cb }; return this._nextHandle++; },
    clearTimer: () => { this._timer = null; },
    nowMs: () => this.now,
    needsFrame: () => this.wants,
    runFrame: () => { this.frames += 1; },
  };

  get frameScheduled(): boolean { return this._frame !== null; }
  get timerScheduled(): boolean { return this._timer !== null; }
  get cancelled(): readonly number[] { return this._cancelled; }

  /** Run the pending animation frame, advancing the clock by one 60 Hz frame. */
  flushFrame(): void {
    const cb = this._frame;
    if (!cb) throw new Error('no frame scheduled');
    this._frame = null;
    this.now += 1000 / 60;
    cb();
  }

  /** Run the pending timer at its deadline. */
  flushTimer(): void {
    const timer = this._timer;
    if (!timer) throw new Error('no timer scheduled');
    this._timer = null;
    this.timers += 1;
    this.now = timer.at;
    timer.cb();
  }
}

describe('starting', () => {
  it('draws the first frame without being asked', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    expect(s.state).toBe('stopped');
    s.start();
    expect(s.state).toBe('scheduled');
    h.flushFrame();
    expect(h.frames).toBe(1);
  });

  it('ignores a second start', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    s.start();
    h.flushFrame();
    expect(h.frames).toBe(1);
    expect(h.frameScheduled).toBe(false);
  });
});

describe('sleeping', () => {
  it('stops scheduling frames once nothing wants one', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    expect(h.frames).toBe(1);
    expect(h.frameScheduled).toBe(false);
    expect(s.state).toBe('sleeping');
  });

  it('idles at the heartbeat rather than at the panel rate', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    // Ten seconds of idling: one heartbeat frame per interval and nothing
    // between them, against the ~600 a self-scheduling loop would run.
    for (let i = 0; i < 40; i++) {
      h.flushTimer();
      h.flushFrame();
    }
    expect(h.timers).toBe(40);
    expect(h.frames).toBe(41);
    expect(h.now).toBeGreaterThanOrEqual(40 * IDLE_HEARTBEAT_MS);
  });

  it('keeps drawing while something still wants a frame', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    h.wants = true;
    s.start();
    for (let i = 0; i < 10; i++) h.flushFrame();
    expect(h.frames).toBe(10);
    expect(s.state).toBe('scheduled');
    h.wants = false;
    h.flushFrame();
    expect(s.state).toBe('sleeping');
  });
});

describe('waking', () => {
  it('schedules a frame from sleep', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    expect(s.state).toBe('sleeping');
    s.wake();
    expect(s.state).toBe('scheduled');
    h.flushFrame();
    expect(h.frames).toBe(2);
  });

  it('cancels the idle timer when it wakes, so the poll does not pile up', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    expect(h.timerScheduled).toBe(true);
    s.wake();
    expect(h.timerScheduled).toBe(false);
  });

  it('is idempotent: repeated wakes do not queue extra frames', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    s.wake();
    s.wake();
    s.wake();
    h.flushFrame();
    expect(h.frames).toBe(2);
    expect(h.frameScheduled).toBe(false);
  });

  it('keeps one chain when a frame wakes the scheduler from inside itself', () => {
    const pending: (() => void)[] = [];
    let wake = (): void => {};
    const s = new FrameScheduler({
      requestFrame: (cb) => pending.push(cb),
      cancelFrame: () => {},
      setTimer: () => 0,
      clearTimer: () => {},
      nowMs: () => 0,
      needsFrame: () => true,
      runFrame: () => wake(),
    });
    wake = () => s.wake();
    s.start();
    for (let k = 0; k < 8; k++) {
      expect(pending.length).toBe(1);
      pending.shift()!();
    }
    expect(pending.length).toBe(1);
  });

  it('does nothing before start or after stop', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.wake();
    expect(h.frameScheduled).toBe(false);
    s.start();
    h.flushFrame();
    s.stop();
    s.wake();
    expect(h.frameScheduled).toBe(false);
    expect(s.state).toBe('stopped');
  });
});

describe('the idle heartbeat', () => {
  it('draws a frame a change nobody announced can appear in', () => {
    // The hole this closes: `needsFrame` answers what has ASKED, so a scene
    // change that never invalidated leaves it false forever. A scheduler that
    // only re-asked would never draw that change at all.
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    expect(s.state).toBe('sleeping');
    h.flushTimer();
    expect(s.state).toBe('scheduled');
    h.flushFrame();
    expect(h.frames).toBe(2);
    expect(h.wants).toBe(false); // nothing ever asked
  });

  it('bounds a missed wake to the heartbeat interval', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    const asleepAt = h.now;
    h.wants = true; // nobody called wake
    h.flushTimer();
    expect(h.now - asleepAt).toBeLessThanOrEqual(IDLE_HEARTBEAT_MS + 1e-9);
    expect(s.state).toBe('scheduled');
  });

  it('returns to the heartbeat once the work that woke it is done', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    h.wants = true;
    s.start();
    h.flushFrame();
    h.flushFrame();
    expect(h.timerScheduled).toBe(false); // full rate, no heartbeat
    h.wants = false;
    h.flushFrame();
    expect(s.state).toBe('sleeping');
    expect(h.timerScheduled).toBe(true);
  });
});

describe('stopping', () => {
  it('cancels an outstanding frame', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    h.wants = true;
    s.start();
    expect(h.frameScheduled).toBe(true);
    s.stop();
    expect(h.frameScheduled).toBe(false);
    expect(h.cancelled.length).toBe(1);
  });

  it('cancels the idle timer', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    expect(h.timerScheduled).toBe(true);
    s.stop();
    expect(h.timerScheduled).toBe(false);
  });

  it('does not schedule anything from a frame that lands after it stops', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    h.wants = true;
    s.start();
    // The browser can run a callback that was already in flight. Simulate it
    // by stopping between the request and the callback.
    const flush = () => h.flushFrame();
    s.stop();
    expect(() => flush()).toThrow(); // stop cancelled it, so there is nothing to run
    expect(h.frameScheduled).toBe(false);
    expect(h.timerScheduled).toBe(false);
  });

  it('resumes from start after a stop, keeping nothing outstanding in between', () => {
    const h = new Harness();
    const s = new FrameScheduler(h.host);
    s.start();
    h.flushFrame();
    s.stop();
    expect(s.state).toBe('stopped');
    s.start();
    expect(s.state).toBe('scheduled');
    h.flushFrame();
    expect(h.frames).toBe(2);
  });
});
