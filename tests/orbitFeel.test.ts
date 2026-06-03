/**
 * orbitFeel.test.ts
 *
 * Pure-helper tests for the orbit-feel tunables that drive the v0.3.6
 * camera navigation. Verifies:
 *   • The constant values match the contract documented in orbitFeel.ts.
 *     This is a regression guard: a future commit that nudges any of
 *     these numbers will fail the test deliberately, forcing the author
 *     to update both the value AND the documented rationale.
 *   • `isWithinSettleWindow` returns true inside the [0, settleMs) window
 *     after the last interaction, false outside, and degrades safely on
 *     edge inputs (clock skew, no prior gesture, non-finite arguments).
 *   • The soft-clamp lerp + streaming-bounds lerp factors converge to
 *     the documented timing — the lerps are not so aggressive they snap,
 *     not so soft the target never settles.
 */

import { describe, it, expect } from 'vitest';
import {
  DAMPING_FACTOR,
  ROTATE_SPEED,
  SETTLE_MS,
  SOFT_CLAMP_LERP_PER_FRAME,
  STREAMING_LERP_PER_FRAME,
  EXPAND_FRACTION,
  isWithinSettleWindow,
} from '../src/render/orbitFeel';
import { lerpTowardCenter } from '../src/render/orbitCenter';

describe('orbit-feel constants — regression guard', () => {
  it('DAMPING_FACTOR is 0.07 (middle ground between v0.3.5 snappy and model-viewer soft)', () => {
    expect(DAMPING_FACTOR).toBe(0.07);
    // Should always sit between the snappy v0.3.5 baseline and the over-
    // coast value the first smoothness pass tried.
    expect(DAMPING_FACTOR).toBeGreaterThan(0.05);
    expect(DAMPING_FACTOR).toBeLessThan(0.08);
  });

  it('ROTATE_SPEED is 0.95 (a hair below default to suit survey work)', () => {
    expect(ROTATE_SPEED).toBe(0.95);
    expect(ROTATE_SPEED).toBeGreaterThan(0.85); // v0.3.5 baseline lower bound
    expect(ROTATE_SPEED).toBeLessThanOrEqual(1.0);
  });

  it('SETTLE_MS is 280 (long enough for damping at 0.07 to decay)', () => {
    expect(SETTLE_MS).toBe(280);
    // 60-fps damping at 0.07 settles in ~15-30 frames = 250-500 ms.
    // The window must straddle the lower bound and stay shorter than
    // a user can perceive a "pause" before the clamp engages (~500 ms).
    expect(SETTLE_MS).toBeGreaterThanOrEqual(200);
    expect(SETTLE_MS).toBeLessThanOrEqual(400);
  });

  it('SOFT_CLAMP_LERP_PER_FRAME is 0.12 (~0.5 s pull-back at 60 fps)', () => {
    expect(SOFT_CLAMP_LERP_PER_FRAME).toBe(0.12);
    expect(SOFT_CLAMP_LERP_PER_FRAME).toBeGreaterThan(0);
    expect(SOFT_CLAMP_LERP_PER_FRAME).toBeLessThan(0.25);
  });

  it('STREAMING_LERP_PER_FRAME is 0.05 (slow refinement glide, never snaps)', () => {
    expect(STREAMING_LERP_PER_FRAME).toBe(0.05);
    expect(STREAMING_LERP_PER_FRAME).toBeLessThan(SOFT_CLAMP_LERP_PER_FRAME);
  });

  it('EXPAND_FRACTION is 0.4 (40% of AABB diagonal inflation)', () => {
    expect(EXPAND_FRACTION).toBe(0.4);
    expect(EXPAND_FRACTION).toBeGreaterThan(0);
    expect(EXPAND_FRACTION).toBeLessThan(1);
  });
});

describe('isWithinSettleWindow', () => {
  it('returns true within the settle window', () => {
    expect(isWithinSettleWindow(1000, 1000)).toBe(true);   // delta = 0
    expect(isWithinSettleWindow(1100, 1000)).toBe(true);   // 100 ms < 280
    expect(isWithinSettleWindow(1279, 1000)).toBe(true);   // 279 ms < 280
  });

  it('returns false at and past the settle boundary', () => {
    expect(isWithinSettleWindow(1280, 1000)).toBe(false);  // 280 ms boundary
    expect(isWithinSettleWindow(1500, 1000)).toBe(false);
    expect(isWithinSettleWindow(60_000, 1000)).toBe(false);
  });

  it('returns false when no gesture has happened yet (lastInteractMs = 0)', () => {
    expect(isWithinSettleWindow(1000, 0)).toBe(false);
    expect(isWithinSettleWindow(0, 0)).toBe(false);
  });

  it('handles clock-skew (lastInteractMs > nowMs) without trapping', () => {
    // If clocks go backward (system sleep / NTP correction), the function
    // must not return true forever — it returns false so the maintenance
    // pass runs normally.
    expect(isWithinSettleWindow(500, 1000)).toBe(false);
  });

  it('rejects non-finite inputs', () => {
    expect(isWithinSettleWindow(Number.NaN, 1000)).toBe(false);
    expect(isWithinSettleWindow(1000, Number.NaN)).toBe(false);
    expect(isWithinSettleWindow(Infinity, 1000)).toBe(false);
  });

  it('honours a custom settleMs override', () => {
    expect(isWithinSettleWindow(1500, 1000, 600)).toBe(true);  // 500 < 600
    expect(isWithinSettleWindow(1500, 1000, 400)).toBe(false); // 500 > 400
  });
});

describe('soft-clamp lerp convergence', () => {
  it('reaches the clamp target within ~30 frames using SOFT_CLAMP_LERP_PER_FRAME', () => {
    // Start 100 m outside the envelope; clamped target is the envelope
    // edge. After ~30 frames (= 0.5 s @ 60 fps) the residual should be
    // below 5 %.
    let v: readonly [number, number, number] = [100, 0, 0];
    const target: readonly [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 30; i++) {
      v = lerpTowardCenter(v, target, SOFT_CLAMP_LERP_PER_FRAME) as typeof v;
    }
    expect(v[0]).toBeGreaterThan(0);          // never overshoots
    expect(v[0]).toBeLessThan(5);             // within 5%
  });

  it('asymptotically settles — never snaps in a single frame', () => {
    // First frame must apply <50% of the correction. If a future commit
    // pushes the lerp factor above 0.5 this test catches it.
    let v: readonly [number, number, number] = [100, 0, 0];
    v = lerpTowardCenter(v, [0, 0, 0], SOFT_CLAMP_LERP_PER_FRAME) as typeof v;
    expect(v[0]).toBeGreaterThan(50);
  });
});

describe('streaming-refinement lerp convergence', () => {
  it('settles within ~60 frames using STREAMING_LERP_PER_FRAME', () => {
    // Streaming refinement is intentionally slower than the clamp. At
    // 0.05/frame, ~60 frames should bring residual below 5 %.
    let v: readonly [number, number, number] = [100, 0, 0];
    for (let i = 0; i < 60; i++) {
      v = lerpTowardCenter(v, [0, 0, 0], STREAMING_LERP_PER_FRAME) as typeof v;
    }
    expect(v[0]).toBeGreaterThan(0);
    expect(v[0]).toBeLessThan(5);
  });

  it('moves no more than 5 % of the way per frame', () => {
    // Sanity check the slow-drift contract — a fresh bounds shift never
    // snaps the camera.
    let v: readonly [number, number, number] = [100, 0, 0];
    v = lerpTowardCenter(v, [0, 0, 0], STREAMING_LERP_PER_FRAME) as typeof v;
    expect(v[0]).toBeCloseTo(95, 1);
  });
});
