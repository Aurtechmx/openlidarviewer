/**
 * adaptiveDpr.ts
 *
 * Pure maths for the P5 adaptive device-pixel-ratio (program §P5) — and the
 * first real consumer of the P3 angular-velocity model (`angularVelocity.ts`).
 *
 * Idea: rendering at full DPR (up to `MAX_PIXEL_RATIO`) while the camera is
 * spinning burns fill-rate no one can see — motion blur and persistence hide the
 * extra pixels. So drop the backing-store resolution WHILE MOVING and snap it
 * back to full the instant the view parks. How far to drop is driven by how fast
 * the camera is rotating (the P3 signal): a slow nudge barely reduces, a fast
 * orbit falls to the floor.
 *
 * Everything here is pure and deterministic so the policy is unit-tested in Node;
 * the Viewer render loop owns the stateful "apply it" side (tracking the previous
 * quaternion, calling `renderer.setPixelRatio`). Crucially, `setPixelRatio`
 * REALLOCATES the drawing buffer, so `shouldApplyDpr` rate-limits reductions and
 * lets restores-to-sharp happen immediately — bounding reallocation to roughly
 * one drop per motion episode and one restore on park.
 */

/** Never render below 1 device pixel per CSS pixel — points/text must stay legible. */
export const DPR_MOTION_FLOOR = 1.0;

/**
 * Baseline reduction factor applied the moment the camera is moving at all
 * (pan / dolly with no rotation still costs fill-rate). Angular speed reduces
 * further from here toward the floor.
 */
export const DPR_MOVING_BASE_FACTOR = 0.85;

/**
 * Angular speed (rad/s) at/above which the moving DPR reaches the floor.
 * ~1.2 rad/s is a brisk orbit (a full turn in ~5 s); anything faster is fully
 * reduced.
 */
export const DPR_FULL_REDUCTION_ANGULAR = 1.2;

/** Coarse quantisation step so tiny fluctuations never trigger a reallocation. */
export const DPR_QUANT_STEP = 0.25;

/** Minimum ms between APPLIED reductions — the reallocation rate limiter. */
export const DPR_MIN_APPLY_INTERVAL_MS = 250;

/** Inputs to the per-frame DPR policy. */
export interface DprInput {
  /** The parked target: `min(devicePixelRatio, MAX_PIXEL_RATIO)`. */
  readonly maxDpr: number;
  /** The existing motion gate (tween or recent input activity). */
  readonly moving: boolean;
  /** Camera angular speed in rad/s, from `angularVelocity` (P3). */
  readonly angularSpeed: number;
}

/** Clamp helper — `[0, 1]`. */
function clamp01(x: number): number {
  if (!(x > 0)) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * The ideal (unquantised) pixel ratio for this frame. Parked → full `maxDpr`.
 * Moving → interpolates from a baseline (`maxDpr · DPR_MOVING_BASE_FACTOR`) down
 * to the floor as angular speed rises to `DPR_FULL_REDUCTION_ANGULAR`. Never
 * below `DPR_MOTION_FLOOR`, never above `maxDpr`.
 */
export function targetPixelRatio(input: DprInput): number {
  const max = Number.isFinite(input.maxDpr) && input.maxDpr > 0 ? input.maxDpr : 1;
  if (!input.moving) return max;
  const floor = Math.min(max, DPR_MOTION_FLOOR);
  const base = Math.max(floor, max * DPR_MOVING_BASE_FACTOR);
  const spd = Number.isFinite(input.angularSpeed) && input.angularSpeed > 0 ? input.angularSpeed : 0;
  const t = clamp01(spd / DPR_FULL_REDUCTION_ANGULAR);
  return base + (floor - base) * t;
}

/**
 * Snap a ratio to a coarse bucket (default `DPR_QUANT_STEP`) so sub-step jitter
 * doesn't churn the drawing buffer. Never returns below one step.
 */
export function quantizeDpr(dpr: number, step: number = DPR_QUANT_STEP): number {
  const s = step > 0 && Number.isFinite(step) ? step : DPR_QUANT_STEP;
  const q = Math.round(dpr / s) * s;
  return q < s ? s : q;
}

/**
 * Whether to actually call `setPixelRatio`. A move UP (toward the sharp parked
 * resolution) is allowed immediately — parking should sharpen at once. A move
 * DOWN (reduction while moving) is rate-limited to `minIntervalMs` so the
 * reallocation cost is bounded. No change when the quantised target already
 * matches what's applied.
 */
export function shouldApplyDpr(
  appliedDpr: number,
  quantizedTarget: number,
  nowMs: number,
  lastChangeMs: number,
  minIntervalMs: number = DPR_MIN_APPLY_INTERVAL_MS,
): boolean {
  if (quantizedTarget === appliedDpr) return false;
  if (quantizedTarget > appliedDpr) return true; // sharpen immediately
  return nowMs - lastChangeMs >= minIntervalMs; // rate-limit reductions
}
