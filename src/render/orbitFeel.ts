/**
 * orbitFeel.ts
 *
 * The set of tunables that describes "how the orbit camera feels" — pulled
 * out as a pure module so the values are documented in one place,
 * regression-guarded by tests, and importable by both Viewer.ts (browser)
 * and the Node test suite.
 *
 * The constants here were tuned through v0.3.6's smoothness pass and the
 * follow-up "axis feels weird" debug fix:
 *
 *   • DAMPING_FACTOR — three.js OrbitControls' damping (lower = longer
 *     glide after release). The v0.3.5 baseline was 0.08 (snappy). The
 *     smoothness pass first tried 0.05 (model-viewer's default) but that
 *     over-coasted on UTM-scale survey scenes. 0.07 is the settled middle
 *     — a hair smoother than v0.3.5, no over-coast on large scenes.
 *
 *   • ROTATE_SPEED — multiplier on rotate-gesture angular velocity. 0.85
 *     was the v0.3.5 baseline (deliberately slowed for survey work). The
 *     first smoothness pass tried 1.0 (default) but combined with lower
 *     damping it made the rotation feel slippery. 0.95 keeps the active
 *     drag responsive without the over-coast.
 *
 *   • SETTLE_MS — the grace window after OrbitControls' 'end' event during
 *     which the orbit-centre maintenance pass (soft-clamp + streaming
 *     refinement) suspends itself. Without this gap, the maintenance lerp
 *     ran *during* OrbitControls' damping tail, producing the "weird axis"
 *     feel reported in v0.3.6. 280 ms is long enough for a 60-fps damping
 *     curve at 0.07 to decay below the noise floor.
 *
 *   • SOFT_CLAMP_LERP_PER_FRAME — when the orbit target drifts outside the
 *     inflated cloud AABB, the maintenance pass lerps it back at this rate
 *     per frame. 0.12 produces a smooth ~0.5 s pull-back glide rather than
 *     a one-frame snap. Test convergence is below.
 *
 *   • STREAMING_LERP_PER_FRAME — streaming-bounds refinement lerp factor.
 *     Set deliberately low so the orbit target glides toward the live cloud
 *     centre as new octree nodes finish decoding without ever snapping.
 *
 *   • EXPAND_FRACTION — envelope inflation as a fraction of the AABB
 *     diagonal. 0.25 gives the user freedom to pan past the edge of the
 *     cloud for inspection without ever orbiting empty space.
 *
 * Pure — no DOM, no three.js. Tests in `tests/orbitFeel.test.ts`.
 */

/** OrbitControls dampingFactor. Lower = longer glide after release. */
export const DAMPING_FACTOR = 0.07;

/** OrbitControls rotateSpeed multiplier on rotate-gesture velocity. */
export const ROTATE_SPEED = 0.95;

/**
 * Grace window after the last OrbitControls 'end' event, in milliseconds.
 * The orbit-centre maintenance pass skips itself within this window so the
 * soft-clamp pull-back doesn't race the damping tail.
 */
export const SETTLE_MS = 280;

/** Per-frame lerp factor for soft-clamping the orbit target back into the AABB. */
export const SOFT_CLAMP_LERP_PER_FRAME = 0.12;

/** Per-frame lerp factor for streaming-bounds refinement of the orbit target. */
export const STREAMING_LERP_PER_FRAME = 0.05;

/**
 * Envelope inflation expressed as a fraction of the AABB diagonal.
 * v0.3.6: bumped 0.25 → 0.4 after users on large aerial surveys hit the
 * clamp boundary while still well within useful pan range. 40% of a 1 km
 * scan's diagonal is ~570 m of pan headroom on each side; on a small
 * indoor scan it's still tight enough that you can't fly into the void.
 */
export const EXPAND_FRACTION = 0.4;

/**
 * True while the orbit-centre maintenance pass should suspend itself
 * because OrbitControls' damping is still settling after a gesture.
 *
 * `nowMs` and `lastInteractMs` are both monotonically-increasing high-res
 * timestamps in milliseconds; `performance.now()` in browsers, `Date.now()`
 * as a fallback. The function is pure — pulled out of Viewer.ts so the
 * timing contract is unit-testable in Node.
 *
 * Edge cases:
 *   • `lastInteractMs === 0` (no gesture yet) → false; the maintenance pass
 *     runs as soon as a cloud attaches.
 *   • `lastInteractMs > nowMs` (clock skew) → false; we don't trap forever.
 */
export function isWithinSettleWindow(
  nowMs: number,
  lastInteractMs: number,
  settleMs: number = SETTLE_MS,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastInteractMs)) return false;
  if (lastInteractMs <= 0) return false;
  const delta = nowMs - lastInteractMs;
  if (delta < 0) return false;
  return delta < settleMs;
}
