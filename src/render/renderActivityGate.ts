/**
 * renderActivityGate.ts — decides whether the render loop draws this frame.
 *
 * Lifted from `Viewer._shouldRenderFrame` plus its scattered activity
 * timestamp and heartbeat counter. The loop skips frames when nothing is
 * happening so the GPU idles, but must draw when a tween runs, when input is
 * recent, when streaming nodes are arriving, or on a periodic heartbeat that
 * keeps the scene fresh. That decision read `performance.now()` and the
 * scheduler, so it could only run inside a live loop.
 *
 * The gate takes the current time as an argument and a small "is streaming
 * busy" flag, so the whole decision is pure and tests in Node. The Viewer
 * keeps the loop, the clock reads, and the actual `render()` call, and tells
 * the gate whether the frame drew via `noteRendered` / `noteSkipped`.
 *
 * Behaviour is preserved exactly, including that `bump` assigns the deadline
 * unconditionally rather than taking a max. `performance.now()` is monotonic,
 * so successive bumps only ever increase; the unconditional write matches the
 * original and avoids implying a guard the loop does not rely on.
 */

/** How long after an input the loop keeps drawing at full rate. */
export const RENDER_HOLDOVER_MS = 350;

/** Idle frames between heartbeat renders when nothing else asks to draw. */
export const IDLE_HEARTBEAT_FRAMES = 6;

/** The per-frame inputs the decision needs beyond the clock. */
export interface RenderActivitySignals {
  /** A camera tween is in progress (intro, preset transition). */
  readonly tweening: boolean;
  /** The streaming scheduler has in-flight or queued node fetches. */
  readonly streamingBusy: boolean;
}

export class RenderActivityGate {
  private _activityUntilMs = 0;
  // Starts armed so the very first loop iteration draws — otherwise the scene
  // would not appear until the first input.
  private _idleHeartbeat = IDLE_HEARTBEAT_FRAMES;

  /** The activity deadline, exposed for the shared moving-camera signal. */
  get activityUntilMs(): number {
    return this._activityUntilMs;
  }

  /** Extend the full-rate window after an input. `now` is `performance.now()`. */
  bump(now: number): void {
    this._activityUntilMs = now + RENDER_HOLDOVER_MS;
  }

  /**
   * Draw this frame?
   *
   * Priority, highest first: a tween always draws; recent input draws until
   * the holdover expires; active streaming draws so new nodes appear without
   * latency; otherwise the heartbeat draws once the idle counter reaches the
   * threshold. The boundary is `now < until`, so the expiry instant is already
   * idle.
   */
  shouldRender(now: number, signals: RenderActivitySignals): boolean {
    if (signals.tweening) return true;
    if (now < this._activityUntilMs) return true;
    if (signals.streamingBusy) return true;
    return this._idleHeartbeat >= IDLE_HEARTBEAT_FRAMES;
  }

  /** The frame drew: reset the heartbeat so ticks stay evenly spaced. */
  noteRendered(): void {
    this._idleHeartbeat = 0;
  }

  /** The frame was skipped: advance toward the next heartbeat. */
  noteSkipped(): void {
    this._idleHeartbeat++;
  }
}
