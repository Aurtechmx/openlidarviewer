/**
 * continuityPressure.ts
 *
 * Which continuity tier a device should run, given how its frames are actually
 * going.
 *
 * The renderer already watches frame time and backs the streaming budget off
 * when it slips, across a band between 45 and 55 frames a second, with holds
 * that are deliberately lopsided: two seconds of slow frames to give ground,
 * five seconds of fast ones to take it back. Conceding quickly and recovering
 * slowly is what stops a controller hunting.
 *
 * So this does not sample frame time, and the thresholds are imported rather
 * than restated. Two controllers on one signal carrying their own numbers would
 * both back off on the same stutter, correcting twice for one problem, then
 * recover together and oscillate in step, which is the behaviour the programme
 * asks to avoid. One band, read from one place.
 *
 * What a device should run is bounded by what its backend can carry, and those
 * are different questions. The ceiling comes from capability and does not move
 * with frame rate, so this only proposes a tier at or below it: a device cannot
 * be promoted into something its backend cannot run by going fast.
 *
 * Pure: no clock, no device queries, no three.js. The caller measures and asks.
 * Display only.
 */
import { FPS_PRESSURE_HIGH_HOLD_MS, FPS_PRESSURE_LOW_HOLD_MS } from './streamingBudget';
import { TIER_ORDER, degrade, type ContinuityTier } from './continuityTier';

/** How the recent frames have been going. */
export interface PressureInput {
  /** Milliseconds the smoothed frame time has been above the high threshold. */
  readonly aboveHighMs: number;
  /** Milliseconds it has been below the low threshold. */
  readonly belowLowMs: number;
}

/** One rung richer, or null at the top. */
function promote(tier: ContinuityTier): ContinuityTier | null {
  const i = TIER_ORDER.indexOf(tier);
  return i <= 0 ? null : TIER_ORDER[i - 1];
}

/** Whether `a` is at least as rich as `b`. */
function atLeastAsRich(a: ContinuityTier, b: ContinuityTier): boolean {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b);
}

/**
 * The tier to run next.
 *
 * Moves one rung at a time. A device struggling badly gives ground again on the
 * following decision rather than dropping to the bottom at once, so one bad
 * second does not cost every capability.
 *
 * The ceiling wins in both directions. A tier above it is clamped down at once,
 * because a backend that cannot carry something does not become able to by
 * running fast.
 */
export function nextTierUnderPressure(
  current: ContinuityTier,
  ceiling: ContinuityTier,
  input: PressureInput,
): ContinuityTier {
  if (!atLeastAsRich(ceiling, current)) return ceiling;
  if (input.aboveHighMs >= FPS_PRESSURE_HIGH_HOLD_MS) return degrade(current) ?? current;
  if (input.belowLowMs >= FPS_PRESSURE_LOW_HOLD_MS) {
    const up = promote(current);
    if (up === null) return current;
    return atLeastAsRich(ceiling, up) ? up : current;
  }
  return current;
}
