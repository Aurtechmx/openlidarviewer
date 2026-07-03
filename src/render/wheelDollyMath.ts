/**
 * wheelDollyMath.ts
 *
 * Pure, dependency-free maths for the P2 application-owned wheel / trackpad
 * dolly (program §P2). Same leaf-module contract as `navMath` / `panMath`: keep
 * the numbers here so a typo is caught by the suite, not by squinting at a
 * scroll. The controller (`WheelDollyController`, browser-bound) owns pointer
 * pivots, event listeners, and yielding control to OrbitControls; it calls into these.
 *
 * Two concerns, both deterministic and time-based so the same synthetic input
 * sequence produces the same final zoom at 60, 120, or 144 Hz (within a small
 * discretisation tolerance):
 *
 *   1. Delta normalisation — a `WheelEvent.deltaY` means different things per
 *      `deltaMode` (pixels / lines / pages). Normalise to CSS pixels first.
 *   2. A log-space velocity model — wheel impulses add to a velocity; each frame
 *      a dolly `scale = exp(velocity · dt)` is applied and the velocity decays by
 *      `exp(-friction · dt)`. Log-space makes zoom symmetric (a notch in then a
 *      notch out returns to the same radius) and refresh-rate stable.
 */

/** `WheelEvent.deltaMode` values, redeclared to avoid a DOM import in a leaf module. */
export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

/**
 * Normalise a raw wheel delta to CSS pixels.
 *
 * @param delta Raw `WheelEvent.deltaY` (or X).
 * @param deltaMode `WheelEvent.deltaMode` (0 pixel, 1 line, 2 page).
 * @param lineHeightPx Measured/configured line height in CSS px (line mode).
 * @param viewportHeightPx Viewport height in CSS px (page mode).
 * @returns Delta in CSS pixels. Non-finite `delta` collapses to 0; invalid
 *   line/page metrics fall back to sane constants (16 px, 800 px).
 */
export function normalizeWheelDeltaPx(
  delta: number,
  deltaMode: number,
  lineHeightPx: number,
  viewportHeightPx: number,
): number {
  if (!Number.isFinite(delta)) return 0;
  switch (deltaMode) {
    case DOM_DELTA_LINE:
      return delta * (Number.isFinite(lineHeightPx) && lineHeightPx > 0 ? lineHeightPx : 16);
    case DOM_DELTA_PAGE:
      return delta * (Number.isFinite(viewportHeightPx) && viewportHeightPx > 0 ? viewportHeightPx : 800);
    case DOM_DELTA_PIXEL:
    default:
      return delta;
  }
}

/**
 * Symmetric ceiling on dolly velocity so a violent trackpad flick — or a wheel
 * event with a pathological `deltaY` — can't accumulate a velocity that blows
 * past the per-frame clamp for many frames in a row (a "runaway zoom"). A
 * non-finite or non-positive `maxVelocity` disables the clamp (returns the input
 * unchanged), which is the default so callers opt in explicitly.
 */
export function clampDollyVelocity(velocity: number, maxVelocity = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(velocity)) return 0;
  if (!(maxVelocity > 0) || !Number.isFinite(maxVelocity)) return velocity;
  if (velocity > maxVelocity) return maxVelocity;
  if (velocity < -maxVelocity) return -maxVelocity;
  return velocity;
}

/**
 * Add a wheel impulse to the current dolly velocity. Pure — the sign of
 * `sensitivity` decides zoom-in vs zoom-out at the call site. The result is
 * passed through {@link clampDollyVelocity} so a single huge delta cannot
 * push the velocity past `maxVelocity` (default: unbounded, a no-op).
 */
export function applyWheelImpulse(
  velocity: number,
  normalizedDeltaPx: number,
  sensitivity: number,
  maxVelocity = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isFinite(normalizedDeltaPx) || !Number.isFinite(sensitivity)) return velocity;
  return clampDollyVelocity(velocity + normalizedDeltaPx * sensitivity, maxVelocity);
}

/** One frame's dolly step. */
export interface DollyStep {
  /** Multiplicative scale to apply to the camera-target distance this frame. */
  readonly scale: number;
  /** The decayed velocity to carry into the next frame. */
  readonly velocity: number;
}

/**
 * Advance the dolly one frame. Log-space + time-based:
 *   scale        = exp(velocity · dt)
 *   nextVelocity = velocity · exp(-friction · dt)
 *
 * @param velocity Current dolly velocity (log-space, per second).
 * @param dtSec Elapsed seconds since the last frame (must be > 0).
 * @param frictionPerSec Exponential decay rate per second (≥ 0).
 * @param maxFrameScale Symmetric clamp on the per-frame scale so a long dt can't
 *   teleport the camera (default 1.15).
 */
export function stepDolly(
  velocity: number,
  dtSec: number,
  frictionPerSec: number,
  maxFrameScale = 1.15,
): DollyStep {
  if (!Number.isFinite(velocity) || velocity === 0 || !(dtSec > 0)) {
    return { scale: 1, velocity: Number.isFinite(velocity) ? velocity : 0 };
  }
  const friction = Number.isFinite(frictionPerSec) && frictionPerSec > 0 ? frictionPerSec : 0;
  const maxLog = Math.log(maxFrameScale > 1 ? maxFrameScale : 1.15);
  let logScale = velocity * dtSec;
  if (logScale > maxLog) logScale = maxLog;
  else if (logScale < -maxLog) logScale = -maxLog;
  const scale = Math.exp(logScale);
  const nextVelocity = friction > 0 ? velocity * Math.exp(-friction * dtSec) : velocity;
  return { scale, velocity: nextVelocity };
}

/** Whether the velocity has decayed below a settle threshold (motion stopped). */
export function isDollySettled(velocity: number, settleThreshold = 0.002): boolean {
  return !Number.isFinite(velocity) || Math.abs(velocity) < settleThreshold;
}
