/**
 * touchGesture.ts
 *
 * Two-pointer gesture decomposition. Pure, unit-testable in Node — no DOM,
 * no three.js. The seam every Viewer touch handler reads through.
 *
 * The inherited Three.js `OrbitControls` touch model interprets any
 * two-finger motion as either pinch-zoom or pan. That leaves twist
 * impossible: a user who learned the rotate gesture from Google Maps,
 * Procreate, or Photoshop iPad puts two fingers down, twists them, and
 * the camera dollies instead of rotating. This module fixes that by
 * decomposing every 2-pointer frame into three independent deltas:
 *
 *   - **Δdistance / midDistance** → pinch / zoom (dimensionless ratio)
 *   - **Δangle**                  → twist / rotate (radians)
 *   - **Δcentroid**               → pan (pixels)
 *
 * The three signals are mathematically orthogonal — a clean pinch
 * produces zero angle delta, a clean twist produces zero distance delta.
 * A user doing all three at once gets a proportional response on each
 * axis, which feels like physical paper and matches the Maps / Procreate
 * convention.
 *
 * Per-signal dead-zones suppress touchscreen noise. The recogniser only
 * reports a delta whose magnitude exceeds its dead-zone, keeping every
 * delta either intentional or zero.
 *
 * The "advanced" touch model (3-finger zoom, opt-in) lives in a sibling
 * module; this file is the 2-pointer base every model shares.
 */

/** A single touch point — local to the canvas, in pixels. */
export interface Pointer {
  x: number;
  y: number;
}

/** The decomposed per-frame deltas the recogniser hands the Viewer. */
export interface GestureDelta {
  /**
   * Multiplicative dolly factor. `0` means no zoom; `+0.04` means dolly
   * in by 4%; `-0.04` means dolly out. Already dead-zoned — read it
   * as "apply directly" without further thresholding.
   */
  dPinch: number;
  /**
   * Twist angle in radians. Positive = counter-clockwise as seen by the
   * user on screen. In Orbit mode the Viewer applies this as yaw around
   * the world up vector. Dead-zoned.
   */
  dTwist: number;
  /** Centroid pan in screen pixels — `{ x, y }` since the last frame. */
  dPan: { x: number; y: number };
}

/** Tunable thresholds. The defaults are the recommendation from D.7. */
export interface GestureThresholds {
  /** Dimensionless `|Δdistance / midDistance|` below which pinch is ignored. */
  pinchDeadZone: number;
  /** Radians; `|Δangle|` below which twist is ignored. */
  twistDeadZone: number;
  /** Pixels; `|Δcentroid|` below which pan is ignored. */
  panDeadZone: number;
}

export const DEFAULT_GESTURE_THRESHOLDS: GestureThresholds = {
  pinchDeadZone: 0.03,
  twistDeadZone: 0.07, // ≈ 4°
  panDeadZone: 6,
};

/** Distance between two pointers, in canvas pixels. */
function distanceBetween(a: Pointer, b: Pointer): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Angle of the AB segment, in radians, taken from the screen's +X axis
 * with Y inverted (since canvas Y grows downward). This is the angle a
 * user would feel as "the angle of the line between their fingers".
 */
function angleOf(a: Pointer, b: Pointer): number {
  return Math.atan2(-(b.y - a.y), b.x - a.x);
}

/** Mid-point of two pointers. */
function midpoint(a: Pointer, b: Pointer): Pointer {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

/**
 * Smallest signed angular delta between `to` and `from`, in radians,
 * wrapped to (−π, π]. Avoids the unwrapping bug where a twist that
 * crosses the −π / +π boundary would otherwise read as a full-turn
 * spike.
 */
function angleDelta(from: number, to: number): number {
  let d = to - from;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/**
 * Decompose the per-frame motion of a 2-pointer gesture into its three
 * orthogonal components. Returns zero on a stationary gesture (or one
 * whose deltas all sit below their dead-zones).
 *
 * The function is intentionally allocation-light: a single `GestureDelta`
 * object per call, no intermediate arrays. Allocating once per
 * `pointermove` is well within budget even on the lowest-tier mobile
 * device profile.
 */
export function decompose2Pointer(
  prevA: Pointer,
  prevB: Pointer,
  curA: Pointer,
  curB: Pointer,
  thresholds: GestureThresholds = DEFAULT_GESTURE_THRESHOLDS,
): GestureDelta {
  const prevDist = distanceBetween(prevA, prevB);
  const curDist = distanceBetween(curA, curB);
  const prevMid = midpoint(prevA, prevB);
  const curMid = midpoint(curA, curB);
  const midDist = (prevDist + curDist) * 0.5;

  // ── pinch ────────────────────────────────────────────────────────────
  // Normalise by the average distance so the ratio is dimensionless and
  // independent of how spread the fingers are. A 5 % spread reads the
  // same whether the fingers are 1 cm apart or 10 cm apart.
  let dPinch = 0;
  if (midDist > 1e-6) {
    const ratio = (curDist - prevDist) / midDist;
    if (Math.abs(ratio) > thresholds.pinchDeadZone) {
      dPinch = ratio;
    }
  }

  // ── twist ────────────────────────────────────────────────────────────
  let dTwist = 0;
  if (midDist > 1e-6) {
    const dAng = angleDelta(angleOf(prevA, prevB), angleOf(curA, curB));
    if (Math.abs(dAng) > thresholds.twistDeadZone) {
      dTwist = dAng;
    }
  }

  // ── pan ──────────────────────────────────────────────────────────────
  const panX = curMid.x - prevMid.x;
  const panY = curMid.y - prevMid.y;
  const panMag = Math.hypot(panX, panY);
  const dPan =
    panMag > thresholds.panDeadZone ? { x: panX, y: panY } : { x: 0, y: 0 };

  return { dPinch, dTwist, dPan };
}

/**
 * Tiny utility — true if the delta is "no movement at all worth applying".
 * The Viewer can short-circuit the camera-update path when this is true,
 * skipping a render request entirely.
 */
export function isZero(delta: GestureDelta): boolean {
  return (
    delta.dPinch === 0 &&
    delta.dTwist === 0 &&
    delta.dPan.x === 0 &&
    delta.dPan.y === 0
  );
}
