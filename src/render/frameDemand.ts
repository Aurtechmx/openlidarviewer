/**
 * frameDemand.ts — one owner for "does the loop need to run".
 *
 * Three things answered a piece of that question and none of them owned it.
 * `RenderActivityGate` held the deadlines and decided whether a scheduled
 * frame draws. `RenderInvalidation` holds the reasons. `FrameScheduler` owns
 * the animation frame. The Viewer held all three and the wiring between them,
 * which meant every caller had to know which of the three to reach for, and
 * getting it wrong is silent: bump without invalidating and a sleeping loop
 * never hears you.
 *
 * Here there is one object and four verbs. `input` and `cameraMoved` are what
 * a listener calls; `changed` is what anything else that alters the picture
 * calls; `needsFrame` is what the scheduler asks. The three parts stay
 * separate modules, each testable on its own, and this is the only place that
 * knows they belong together.
 *
 * The two bumps differ in exactly one way, and it is the one the second
 * deadline exists for: camera motion also stands the motion-gated effects
 * down, and a hover or a colour-mode switch must not. See
 * `renderActivityGate.ts` for the pop that taught us.
 *
 * No DOM and no three.js. The clock and the live signals arrive as functions,
 * so this tests in Node against a fake.
 */
import { browserFrameScheduler, type FrameScheduler, type FrameSchedulerState } from './frameScheduler';
import { RenderActivityGate } from './renderActivityGate';
import { RenderInvalidation, type RenderInvalidationReason } from './renderInvalidation';

/** The live signals that run without asking each frame. */
export interface FrameDemandSignals {
  /** Monotonic milliseconds. */
  nowMs: () => number;
  /** A camera tween is animating. */
  tweening: () => boolean;
  /** The streaming scheduler has in-flight or queued fetches. */
  streamingBusy: () => boolean;
  /**
   * Decoded streaming nodes are waiting for a metered GPU commit.
   *
   * Separate from {@link streamingBusy}, which answers about FETCHES: the
   * scheduler's `queued` and `loading` counts both reach zero while nodes sit
   * decoded-but-uncommitted, and the store's own comment says as much — a
   * readiness verdict reading only those two "would fire too early".
   *
   * Without this the loop could sleep with points decoded and undrawn. Fades
   * hid it, because a fading node keeps the chain alive on its own; turn fades
   * off, as the mobile and low-quality paths do, and the remaining commits
   * would drain one pump per 250 ms safety heartbeat instead of one per frame.
   * On the shipped `immediate` commit mode nothing is ever pending here, so
   * this reads false and the loop behaves exactly as before.
   */
  commitPending: () => boolean;
  /** A node fade is part way through. */
  fading: () => boolean;
}

export class FrameDemand {
  private readonly _gate = new RenderActivityGate();
  private readonly _invalidation = new RenderInvalidation();
  private readonly _signals: FrameDemandSignals;
  private _scheduler: FrameScheduler | null = null;
  private readonly _drawn = new Set<() => void>();

  constructor(signals: FrameDemandSignals) {
    this._signals = signals;
  }

  /** The activity gate, for the render loop's own reads. */
  get gate(): RenderActivityGate {
    return this._gate;
  }

  /** What the scheduler is doing, or `stopped` before the backend is up. */
  get schedulerState(): FrameSchedulerState {
    return this._scheduler?.state ?? 'stopped';
  }

  /**
   * Input that does not move the camera: a hover, a key, a panel.
   *
   * Full-rate frames for the holdover window, with the motion-gated effects
   * left alone.
   */
  input(): void {
    this._gate.bump(this._signals.nowMs());
    this.changed('camera-input');
  }

  /** The camera moved: full rate, and the motion-gated effects stand down. */
  cameraMoved(): void {
    this._gate.bumpCamera(this._signals.nowMs());
    this.changed('camera-input');
  }

  /**
   * Something changed what is drawn. Records the reason and makes sure a
   * frame is scheduled.
   *
   * A reason recorded before the backend is up is kept rather than dropped:
   * the scheduler's first frame is unconditional and clears it there.
   */
  changed(reason: RenderInvalidationReason): void {
    this._invalidation.invalidate(reason, this._signals.nowMs());
    this._scheduler?.wake();
  }

  /** A condition that was asking has finished. */
  finished(reason: RenderInvalidationReason): void {
    this._invalidation.release(reason);
  }

  /**
   * Does anything want a frame?
   *
   * The invalidation set answers for everything that asked. The three signals
   * beside it run without asking: a tween and an in-flight streaming session
   * own their own progress, and a fade advances on its own timer. Anything
   * else has to call {@link changed}, and the scheduler's idle heartbeat is
   * what bounds the cost of forgetting to.
   *
   * Deliberately not the gate's `shouldRender`, whose idle heartbeat is always
   * eventually true: a loop that asked it would never sleep.
   */
  needsFrame(nowMs: number): boolean {
    if (this._invalidation.needsFrame(nowMs)) return true;
    if (this._signals.tweening()) return true;
    return this._signals.streamingBusy() || this._signals.commitPending() || this._signals.fading();
  }

  /**
   * Run `listener` after every frame that drew. Returns the unsubscribe.
   *
   * For HUD elements that mirror the camera and have no state of their own:
   * the view cube is the case this exists for. It polled the heading on an
   * animation frame of its own, sixty times a second for as long as a scan
   * was open, to read a number that cannot change without a frame. Reading it
   * after the frame that could have changed it is the same picture for none
   * of the cost.
   *
   * Deliberately narrow. This is not a frame event anything may subscribe to:
   * a listener that needs to DRAW should ask for a frame through
   * {@link changed} instead, or it will paint one frame behind.
   */
  onDrawnFrame(listener: () => void): () => void {
    this._drawn.add(listener);
    return () => this._drawn.delete(listener);
  }

  /** Tell the listeners a frame drew. */
  frameDrawn(): void {
    for (const listener of this._drawn) listener();
  }

  /** Should this scheduled frame actually draw? */
  shouldRender(): boolean {
    return this._gate.shouldRender(this._signals.nowMs(), {
      tweening: this._signals.tweening(),
      streamingBusy: this._signals.streamingBusy(),
    });
  }

  /**
   * Begin scheduling frames, running `frame` on each one.
   *
   * The callback is bound on the first start and kept across later ones, so a
   * restart after the tab comes back resumes the loop it already had.
   */
  start(frame: () => void): void {
    this._scheduler ??= browserFrameScheduler({
      nowMs: this._signals.nowMs,
      needsFrame: (nowMs) => this.needsFrame(nowMs),
      runFrame: () => {
        this._invalidation.consumeOnce();
        frame();
      },
    });
    this._scheduler.start();
  }

  /** Stop scheduling. Reasons already recorded survive for the restart. */
  stop(): void {
    this._scheduler?.stop();
  }

  /** Stop and forget the scheduler and its listeners, for teardown. */
  dispose(): void {
    this._scheduler?.stop();
    this._scheduler = null;
    this._drawn.clear();
  }
}

/**
 * The damping-settle gate and the pose watch travel with this module because
 * they decide whether a change should bump the demand above at all: the settle
 * gate answers when the damping tail has stopped mattering, and the pose watch
 * carries walk and fly motion, which OrbitControls never reports. `Viewer`
 * reaches all three through this one import, which is what the module-graph
 * ratchet is counting, and they are one concern. `renderActivityGate.ts`
 * re-exports the same two for the same reason.
 */
export { CameraPoseWatch, DampingSettleGate } from './renderActivityGate';
