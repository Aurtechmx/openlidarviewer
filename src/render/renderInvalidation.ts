/**
 * renderInvalidation.ts — why the loop needs another frame.
 *
 * `RenderActivityGate` answers whether to draw, and it answers it from two
 * untyped deadlines and a heartbeat. A caller reaches for `bump` or
 * `bumpCamera` and the reason it had is gone at the call site: the gate knows
 * only that somebody wanted a frame. That is enough to draw and not enough to
 * sleep. A loop that stops when nothing asks for a frame has to be able to say
 * what is still asking, and a deadline cannot say it.
 *
 * The split between the two deadlines is the same fact told badly. One is
 * extended by camera motion and the other by anything, which is a property of
 * the REASON — hovering is not motion, a tween is — encoded in which method
 * the caller picked. Pick the wrong one and Eye Dome Lighting stands down over
 * a scene that never moved, which is the bug the second deadline was added to
 * fix. Here the reason carries it and `KIND` is the whole table.
 *
 * ── THIS IS NOT AN EVENT BUS ────────────────────────────────────────────────
 * Nothing subscribes, nothing is dispatched, and no reason reaches anything
 * except this module's own set. It holds a set of reasons and answers one
 * question about it. A general bus would let any part of the viewer listen for
 * `filter`, and then the invalidation vocabulary would quietly become the
 * application's event vocabulary, with parts of the app coupled through it.
 *
 * ── THREE KINDS OF REASON ───────────────────────────────────────────────────
 * `once` is a change that has already happened and needs one frame to become
 * visible: a style change, a new clip plane, a screenshot request. It clears
 * when a frame serves it.
 *
 * `holdover` is input, which arrives in a stream and whose last member is
 * indistinguishable from a pause. It keeps full-rate frames for
 * `RENDER_HOLDOVER_MS` after the most recent one, the window the activity gate
 * already uses, imported rather than restated so the two cannot drift.
 *
 * `while` is a condition that is still running: a tween, a fade, a pending GPU
 * commit, continuity convergence, device recovery. It holds until its owner
 * releases it, and this is where a sleeping loop can deadlock. If a metered
 * GPU queue drains only from rendered frames, then a queue that fills while
 * the loop is asleep is a queue that never drains. The rule is that the
 * transition from empty to non-empty invalidates; `release` is called on the
 * opposite transition, and a `while` reason that is never released is a loop
 * that never sleeps, which is the safe direction of that mistake.
 *
 * Pure in the sense that matters: no DOM, no three.js, no clock of its own,
 * no timers. The caller passes the time it already has, as everything else in
 * this cluster does.
 */
import { RENDER_HOLDOVER_MS } from './renderActivityGate';

/**
 * Why a frame is wanted.
 *
 * Kebab-case, matching `WakeReason` in the scheduler cadence rather than the
 * upper-case shape the phase brief sketched: two reason vocabularies in one
 * render loop should at least look like the same kind of thing.
 */
export type RenderInvalidationReason =
  /** Pointer, wheel or key input aimed at the camera. */
  | 'camera-input'
  /** OrbitControls damping has a tail left to run. */
  | 'camera-damping'
  /** A camera tween is animating. */
  | 'camera-tween'
  /** A streamed node became a visible candidate. */
  | 'streaming-ready'
  /** Decoded nodes are waiting on a metered GPU commit. */
  | 'gpu-commit-pending'
  /** A level-of-detail fade is part way through. */
  | 'lod-fade'
  /** The canvas or device pixel ratio changed. */
  | 'viewport'
  /** Colour mode, point size, lighting or another display setting changed. */
  | 'style'
  /** A classification or attribute filter changed what is drawn. */
  | 'filter'
  /** A clip plane or box moved. */
  | 'clip'
  /** A measurement, annotation or other tool overlay changed. */
  | 'tool-overlay'
  /** The continuity field has a phase left to contribute. */
  | 'continuity-phase'
  /** The graphics device was lost and is being rebuilt. */
  | 'device-recovery'
  /** A frame is being captured; it must be drawn whatever else is true. */
  | 'screenshot';

/** How long a reason keeps asking for frames. */
export type InvalidationKind = 'once' | 'holdover' | 'while';

/** The kind of each reason. This table is the whole policy. */
export const KIND: Readonly<Record<RenderInvalidationReason, InvalidationKind>> = Object.freeze({
  'camera-input': 'holdover',
  'camera-damping': 'while',
  'camera-tween': 'while',
  'streaming-ready': 'once',
  'gpu-commit-pending': 'while',
  'lod-fade': 'while',
  viewport: 'once',
  style: 'once',
  filter: 'once',
  clip: 'once',
  'tool-overlay': 'once',
  'continuity-phase': 'while',
  'device-recovery': 'while',
  screenshot: 'once',
});

/**
 * Which reasons are the camera actually moving.
 *
 * This is the distinction the second deadline exists for, stated once as data.
 * Hover, style, filter and a resize all want a frame and none of them is
 * motion, so none of them may stand EDL down or drop the pixel ratio.
 */
export const MOVES_CAMERA: ReadonlySet<RenderInvalidationReason> = Object.freeze(
  new Set<RenderInvalidationReason>(['camera-input', 'camera-damping', 'camera-tween']),
) as ReadonlySet<RenderInvalidationReason>;

/** Every reason, in the order declared above. For tests and for traces. */
export const ALL_INVALIDATION_REASONS: readonly RenderInvalidationReason[] = Object.freeze(
  Object.keys(KIND) as RenderInvalidationReason[],
);

/** What a served frame was asked for. */
export interface ServedFrame {
  /** The reasons that were asking when the frame ran, in declaration order. */
  readonly reasons: readonly RenderInvalidationReason[];
  /** Whether any of them was camera motion. */
  readonly cameraMoving: boolean;
}

/**
 * The set of reasons currently asking for frames.
 *
 * Small and deliberately dull: record, release, ask, serve. It holds no
 * clock, so every method that cares about time takes it.
 */
export class RenderInvalidation {
  /** `once` reasons waiting to be served. */
  private readonly _once = new Set<RenderInvalidationReason>();
  /** `while` reasons and their holders. */
  private readonly _while = new Set<RenderInvalidationReason>();
  /** `holdover` reasons and the time each stops asking. */
  private readonly _until = new Map<RenderInvalidationReason, number>();

  /**
   * Ask for a frame.
   *
   * Idempotent for every kind: a reason already asking stays asking, and a
   * holdover reason's window is extended from `nowMs`. A caller that cannot
   * tell whether it has already invalidated may invalidate again.
   */
  invalidate(reason: RenderInvalidationReason, nowMs = 0): void {
    switch (KIND[reason]) {
      case 'once':
        this._once.add(reason);
        return;
      case 'while':
        this._while.add(reason);
        return;
      case 'holdover':
        this._until.set(reason, (Number.isFinite(nowMs) ? nowMs : 0) + RENDER_HOLDOVER_MS);
        return;
    }
  }

  /**
   * Stop asking.
   *
   * The owner of a `while` condition calls this when the condition ends: the
   * tween finished, the queue emptied, the fade completed. Releasing a reason
   * that is not held does nothing, so an owner may release unconditionally.
   *
   * A `once` reason cannot be released, only served: the change it describes
   * has already happened, and forgetting it would leave the last frame
   * showing the state before it.
   */
  release(reason: RenderInvalidationReason): void {
    if (KIND[reason] === 'while') this._while.delete(reason);
  }

  /** Whether `reason` is asking for a frame at `nowMs`. */
  holds(reason: RenderInvalidationReason, nowMs = 0): boolean {
    switch (KIND[reason]) {
      case 'once': return this._once.has(reason);
      case 'while': return this._while.has(reason);
      case 'holdover': {
        const until = this._until.get(reason);
        // The expiry instant is already idle, matching the activity gate's
        // `now < until` boundary.
        return until !== undefined && nowMs < until;
      }
    }
  }

  /** Every reason asking at `nowMs`, in declaration order. */
  reasons(nowMs = 0): readonly RenderInvalidationReason[] {
    return ALL_INVALIDATION_REASONS.filter((reason) => this.holds(reason, nowMs));
  }

  /** Whether the loop needs a frame at all. The thing a sleeping loop asks. */
  needsFrame(nowMs = 0): boolean {
    if (this._once.size > 0 || this._while.size > 0) return true;
    for (const until of this._until.values()) if (nowMs < until) return true;
    return false;
  }

  /** Whether anything asking at `nowMs` is camera motion. */
  cameraMoving(nowMs = 0): boolean {
    for (const reason of MOVES_CAMERA) if (this.holds(reason, nowMs)) return true;
    return false;
  }

  /**
   * Run a frame: report what asked for it and clear the `once` reasons.
   *
   * `while` and `holdover` reasons survive, which is the difference between
   * them. Clearing happens after the reasons are collected, so the report
   * describes the frame that is about to be drawn rather than the state after
   * it.
   */
  serve(nowMs = 0): ServedFrame {
    const reasons = this.reasons(nowMs);
    const cameraMoving = this.cameraMoving(nowMs);
    this._once.clear();
    return { reasons, cameraMoving };
  }

  /**
   * Drop everything.
   *
   * For a dataset swap or a teardown, where the reasons describe a scene that
   * no longer exists. It clears `while` reasons too, so a caller that holds
   * one must re-assert it against the new scene.
   */
  clear(): void {
    this._once.clear();
    this._while.clear();
    this._until.clear();
  }
}
