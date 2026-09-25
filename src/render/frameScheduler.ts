/**
 * frameScheduler.ts — one owner for the animation frame.
 *
 * The loop scheduled itself: each iteration asked for the next one, so
 * requestAnimationFrame ran at the panel's rate from the moment the backend
 * came up until the tab was hidden. Skipping the draw kept the GPU idle and
 * left the callback, the CPU pipeline and the whole per-frame body running
 * sixty times a second over a scene nobody was touching. The only thing that
 * ever stopped it was the visibility handler, which is to say the loop stopped
 * when the window did.
 *
 * Here the loop runs because something asked. `wake` schedules a frame if one
 * is not already scheduled; after each frame the scheduler asks the host
 * whether anything still wants one, and if nothing does it stops. Nothing is
 * scheduled while it sleeps.
 *
 * ── THE IDLE HEARTBEAT ──────────────────────────────────────────────────────
 * A loop that sleeps is only as complete as the list of things that wake it,
 * and that list has to cover every source in the viewer: input, tweens, fades,
 * decoded nodes, pending commits, device recovery, and every panel that
 * changes what is drawn. A missed source in a self-scheduling loop costs
 * nothing, because the next frame was coming anyway. A missed source here
 * leaves the change invisible, and a viewer showing a stale picture is
 * indistinguishable from a broken one.
 *
 * The render gate already had an answer to this and it is older than any wake
 * call: an idle heartbeat, drawing once every `IDLE_HEARTBEAT_FRAMES` skipped
 * frames, roughly ten times a second. It exists precisely because not
 * everything that changes the scene announces it.
 *
 * So a sleeping scheduler does not merely re-ask. It draws one frame every
 * `IDLE_HEARTBEAT_MS` and then decides again, which is the same heartbeat
 * expressed in time rather than in frames — the units the rest of this cluster
 * moved to for the same reason, that a frame count means different things on
 * different panels. A change nobody announced appears within a quarter of a
 * second instead of never, and the idle cost is four frames a second instead
 * of the sixty a self-scheduling loop pays.
 *
 * A prior version of this module re-asked without drawing. That is tidier and
 * it is wrong: `needsFrame` answers what has asked, so a silent change leaves
 * it false forever and the poll re-asks a question whose answer never changes.
 *
 * ── WHAT IT DOES NOT DECIDE ─────────────────────────────────────────────────
 * Whether a scheduled frame actually draws is still the render gate's
 * question, and what the frame does is still the render loop's. This decides
 * only whether there is a next frame at all.
 *
 * The clock, requestAnimationFrame and the timer all arrive through the host,
 * so the whole thing runs in Node against fakes.
 */

/**
 * How often a sleeping scheduler draws its heartbeat frame.
 *
 * Short enough that a change nobody announced reads as lag rather than as a
 * stale picture, long enough that idling costs four frames a second rather
 * than sixty.
 */
export const IDLE_HEARTBEAT_MS = 250;

/** What the scheduler needs from the outside world. */
export interface FrameSchedulerHost {
  /** Schedule a callback for the next animation frame; returns a handle. */
  requestFrame(callback: () => void): number;
  /** Cancel a frame scheduled by {@link requestFrame}. */
  cancelFrame(handle: number): void;
  /** Schedule a callback after `ms`; returns a handle. */
  setTimer(callback: () => void, ms: number): number;
  /** Cancel a timer scheduled by {@link setTimer}. */
  clearTimer(handle: number): void;
  /** Monotonic milliseconds. */
  nowMs(): number;
  /** Does anything want a frame right now? */
  needsFrame(nowMs: number): boolean;
  /** Run one frame. */
  runFrame(): void;
}

/** What the scheduler is doing, for a trace and for the tests. */
export type FrameSchedulerState = 'stopped' | 'scheduled' | 'sleeping';

export class FrameScheduler {
  private _frame: number | null = null;
  private _timer: number | null = null;
  private _running = false;

  private readonly _host: FrameSchedulerHost;

  constructor(host: FrameSchedulerHost) {
    this._host = host;
  }

  get state(): FrameSchedulerState {
    if (!this._running) return 'stopped';
    return this._frame !== null ? 'scheduled' : 'sleeping';
  }

  /**
   * Begin. The first frame is scheduled unconditionally: there is a scene to
   * put on the screen and nothing has had the chance to ask for it yet.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._schedule();
  }

  /**
   * Stop, cancelling whatever is outstanding.
   *
   * The visibility handler and teardown both use this. A stopped scheduler
   * ignores `wake`, so a decode landing in a hidden tab cannot restart the
   * loop behind the handler's back; `start` is how it comes back.
   */
  stop(): void {
    this._running = false;
    if (this._frame !== null) {
      this._host.cancelFrame(this._frame);
      this._frame = null;
    }
    this._clearTimer();
  }

  /**
   * Something wants a frame.
   *
   * Idempotent and cheap, so a caller that cannot tell whether it has already
   * asked may ask again: with a frame already scheduled this does nothing at
   * all.
   */
  wake(): void {
    if (!this._running || this._frame !== null) return;
    this._clearTimer();
    this._schedule();
  }

  private _schedule(): void {
    // A wake from inside a frame (a camera change during the nav update) has
    // already scheduled the next one; a second request would start a second
    // chain, and every chain that wakes itself again doubles.
    if (this._frame !== null) return;
    this._frame = this._host.requestFrame(() => {
      this._frame = null;
      // The frame runs before the question is asked, so a frame that creates
      // work for the next one (a decode committed, a fade started) is already
      // reflected when the scheduler decides whether to sleep.
      this._host.runFrame();
      if (!this._running || this._frame !== null) return;
      if (this._host.needsFrame(this._host.nowMs())) this._schedule();
      else this._sleep();
    });
  }

  private _sleep(): void {
    if (this._timer !== null) return;
    this._timer = this._host.setTimer(() => {
      this._timer = null;
      if (!this._running) return;
      // Draw the heartbeat frame, then ask again. Whether that frame reaches
      // the GPU is still the render gate's decision.
      this._schedule();
    }, IDLE_HEARTBEAT_MS);
  }

  private _clearTimer(): void {
    if (this._timer === null) return;
    this._host.clearTimer(this._timer);
    this._timer = null;
  }
}

/**
 * A scheduler bound to the browser's own frame and timer.
 *
 * The three hooks are everything a caller has to supply; requestAnimationFrame,
 * setTimeout and their cancellations live here rather than at the call site, so
 * the Viewer says what a frame is and this says how one is scheduled.
 */
export function browserFrameScheduler(hooks: {
  nowMs: () => number;
  needsFrame: (nowMs: number) => boolean;
  runFrame: () => void;
}): FrameScheduler {
  return new FrameScheduler({
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle),
    nowMs: hooks.nowMs,
    needsFrame: hooks.needsFrame,
    runFrame: hooks.runFrame,
  });
}
