/**
 * schedulerCadence.ts
 *
 * When the streaming scheduler should run, in milliseconds rather than frames.
 *
 * The cadence was a frame count: tick every sixth frame. That reads as 100 ms
 * on a 60 Hz panel and 42 ms on a 144 Hz one, so the scheduler ran nearly two
 * and a half times as often on the faster display and made correspondingly
 * different decisions about what to load. A monitor is not a policy input, and
 * a scan that streams differently because of the panel it is shown on cannot
 * be reasoned about from a trace.
 *
 * A 200 ms heartbeat ran alongside it, which bounded the slow end but not the
 * fast one: it is a floor on how rarely the scheduler runs, never a ceiling on
 * how often. Elapsed time gives both.
 *
 * The bands come from the existing refinement phase rather than a second
 * state machine. That phase already decides whether the camera is moving,
 * settling or refining, and a scheduler that decided it again could disagree
 * with the renderer about which one the viewer is in.
 *
 * The figures below are prototypes, named as such where they are defined. They
 * are a starting shape from the phase brief and not a measurement, and the
 * right values come from traces on hardware that is under pressure.
 *
 * What elapsed time cannot remove is quantisation. The decision is polled once
 * a frame, so a deadline is served on the next frame boundary after it and the
 * achieved interval is `ceil(interval / frameMs) * frameMs`. An 88 ms band
 * runs at 100 ms on a 60 Hz panel and at 90 ms on a 144 Hz one, so a residual
 * dependence on refresh rate remains, bounded by one frame instead of being
 * proportional to the rate. The old cadence varied by a factor of nearly two
 * and a half across the same span.
 *
 * Polling per frame is the reason, and it is deliberate. A timer would be
 * exactly refresh-independent and would fire between frames, handing the
 * scheduler a camera the renderer has not drawn from yet, which trades a
 * bounded timing error for a stale input.
 *
 * Pure: no clock of its own, no timers, no DOM. The caller passes the time it
 * already has.
 */
import type { RefinementPhase } from '../refinementPhase';

/** What the cadence is pacing for. */
export type CadenceBand = 'moving' | 'settling' | 'refining' | 'idle';

/**
 * Interval per band, in milliseconds.
 *
 * Prototype values. Moving is the shortest because the visible set is
 * changing fastest and a late decision shows as a hole; idle is the longest
 * and exists as background maintenance rather than as a refresh, which is why
 * it keeps the 250 ms shape of the heartbeat it replaces instead of stopping
 * altogether. A scheduler that stopped would depend on every wake reason
 * below being complete, and an incomplete list would strand a scan.
 */
export const CADENCE_MS: Readonly<Record<CadenceBand, number>> = Object.freeze({
  moving: 66,
  settling: 88,
  refining: 112,
  idle: 250,
});

/** The band a refinement phase paces at. */
export function bandFor(phase: RefinementPhase): CadenceBand {
  switch (phase) {
    case 'moving': return 'moving';
    case 'coverage': return 'settling';
    case 'center-refine': return 'refining';
    case 'full-refine': return 'idle';
  }
}

/**
 * Something that must not wait for the next deadline.
 *
 * Each is a change that invalidates what the scheduler last decided, so
 * holding the decision until a timer expires would leave the viewer looking at
 * a choice made for a different scene.
 */
export type WakeReason =
  /** A dataset was attached; there is no previous decision at all. */
  | 'dataset-attached'
  /** The projection changed, so every projected size is stale. */
  | 'projection-changed'
  /** The viewport changed materially, which moves every projected size. */
  | 'viewport-changed'
  /** The camera jumped rather than moved, so the visible set is unrelated. */
  | 'camera-jumped'
  /** A camera tween retargeted, so where it is heading has changed. */
  | 'tween-retargeted'
  /** Memory pressure needs an eviction decision now. */
  | 'memory-pressure'
  /** The visible frontier was invalidated by something other than the camera. */
  | 'frontier-invalidated';

/** Inputs to one frame's decision. */
export interface CadenceInput {
  /** Monotonic milliseconds. The caller's clock, never read here. */
  readonly nowMs: number;
  /** When the scheduler last ran, on the same clock. */
  readonly lastTickMs: number;
  /** The renderer's refinement phase this frame. */
  readonly phase: RefinementPhase;
  /** A reason to run immediately, or null for the ordinary paced case. */
  readonly wake?: WakeReason | null;
}

/**
 * Whether the scheduler should run this frame.
 *
 * A wake reason runs it whatever the clock says. Otherwise it runs once the
 * band's interval has elapsed.
 *
 * A clock that moves backwards, which a caller passing a fresh timebase can
 * produce, is treated as due rather than as a very long wait. The alternative
 * is a scheduler that stops until the old clock is caught up.
 */
export function shouldTick(input: CadenceInput): boolean {
  if (input.wake) return true;
  const { nowMs, lastTickMs } = input;
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastTickMs)) return true;
  const elapsed = nowMs - lastTickMs;
  if (elapsed < 0) return true;
  return elapsed >= CADENCE_MS[bandFor(input.phase)];
}

/**
 * How many ticks a paced run of `durationMs` should produce in a band.
 *
 * For tests and for reading a trace back. It is the figure a refresh rate must
 * not change, which is the whole point of the phase this implements.
 */
export function expectedTicks(durationMs: number, phase: RefinementPhase): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.floor(durationMs / CADENCE_MS[bandFor(phase)]);
}
