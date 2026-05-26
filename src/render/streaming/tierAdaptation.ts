/**
 * tierAdaptation.ts
 *
 * v0.3.1 Phase 9 Task 29 — runtime FPS-driven device-tier adaptation.
 *
 * Watches a stream of FPS samples and decides when to step the device tier
 * up or down. Two hysteresis windows prevent oscillation:
 *   • {@link STEP_DOWN_FPS} for {@link STEP_DOWN_HOLD_MS} drops the tier
 *     (low motion is more painful than slightly lower fidelity);
 *   • {@link STEP_UP_FPS} for {@link STEP_UP_HOLD_MS} raises it back
 *     (longer hold so a momentary clear stretch doesn't redline the GPU
 *     after the next pan).
 *
 * The class is pure-state-machine (no DOM, no three.js) with an injectable
 * clock, so the tier transitions are unit-tested deterministically. The
 * Viewer wires `recordFps` to its frame loop and reacts to a returned
 * tier change by calling `applyStreamingProfile`.
 */

import type { DeviceTier } from '../deviceProfile';

/** FPS below this is "too slow" — start the step-down hold. */
export const STEP_DOWN_FPS = 24;
/** FPS above this is "comfortable headroom" — start the step-up hold. */
export const STEP_UP_FPS = 50;
/** How long the FPS must stay below {@link STEP_DOWN_FPS} before stepping down. */
export const STEP_DOWN_HOLD_MS = 3_000;
/** How long the FPS must stay above {@link STEP_UP_FPS} before stepping up. */
export const STEP_UP_HOLD_MS = 10_000;

/** Ordered tiers, low → high. */
const TIER_ORDER: readonly DeviceTier[] = ['low', 'medium', 'high'];

/** Step one tier higher, or null at the cap. */
export function tierStepUp(tier: DeviceTier): DeviceTier | null {
  const i = TIER_ORDER.indexOf(tier);
  if (i < 0 || i >= TIER_ORDER.length - 1) return null;
  return TIER_ORDER[i + 1];
}

/** Step one tier lower, or null at the floor. */
export function tierStepDown(tier: DeviceTier): DeviceTier | null {
  const i = TIER_ORDER.indexOf(tier);
  if (i <= 0) return null;
  return TIER_ORDER[i - 1];
}

/** Options for the FPS-driven adaptation state machine. */
export interface TierAdaptationOptions {
  /** Monotonic clock — injected for tests. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * The pure FPS-driven tier adapter. `recordFps` is the only mutator; it
 * returns the (possibly new) tier each tick so the caller can act on a
 * transition without comparing externally.
 */
export class TierAdaptation {
  private _tier: DeviceTier;
  private readonly _now: () => number;
  /** First wall time `fps < STEP_DOWN_FPS`, or null. */
  private _belowSinceTs: number | null = null;
  /** First wall time `fps > STEP_UP_FPS`, or null. */
  private _aboveSinceTs: number | null = null;

  constructor(initialTier: DeviceTier, options: TierAdaptationOptions = {}) {
    this._tier = initialTier;
    this._now =
      options.now ??
      (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  /** The tier the adapter is currently asking the runtime to honour. */
  get currentTier(): DeviceTier {
    return this._tier;
  }

  /** Force the tier (e.g. on quality-preset override) and reset the timers. */
  setTier(tier: DeviceTier): void {
    this._tier = tier;
    this._belowSinceTs = null;
    this._aboveSinceTs = null;
  }

  /**
   * Record one FPS sample. Returns the current tier — equal to the prior
   * tier on most ticks; a fresh tier on a step transition.
   *
   * The state machine has three branches:
   *   1. `fps < STEP_DOWN_FPS` — arm or hold the step-down timer; the
   *      step-up timer clears.
   *   2. `fps > STEP_UP_FPS` — arm or hold the step-up timer; the step-
   *      down timer clears.
   *   3. between the thresholds — neither edge advances; both timers
   *      clear, so a brief excursion past a threshold re-arms from scratch
   *      on its next entry.
   *
   * A transition that reaches its hold-time fires, then resets that
   * direction's timer — so a sustained outlier doesn't trigger an immediate
   * second step on the next sample.
   */
  recordFps(fps: number): DeviceTier {
    const now = this._now();
    if (fps < STEP_DOWN_FPS) {
      if (this._belowSinceTs === null) this._belowSinceTs = now;
      this._aboveSinceTs = null;
      if (now - this._belowSinceTs >= STEP_DOWN_HOLD_MS) {
        const next = tierStepDown(this._tier);
        if (next !== null) {
          this._tier = next;
          this._belowSinceTs = null;
        }
      }
    } else if (fps > STEP_UP_FPS) {
      if (this._aboveSinceTs === null) this._aboveSinceTs = now;
      this._belowSinceTs = null;
      if (now - this._aboveSinceTs >= STEP_UP_HOLD_MS) {
        const next = tierStepUp(this._tier);
        if (next !== null) {
          this._tier = next;
          this._aboveSinceTs = null;
        }
      }
    } else {
      // Comfortable middle band — neither timer advances.
      this._belowSinceTs = null;
      this._aboveSinceTs = null;
    }
    return this._tier;
  }
}
