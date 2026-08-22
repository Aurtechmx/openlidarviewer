/**
 * deviceProfile.ts
 *
 * Derives a coarse device-capability tier and the point budget that tier can
 * safely render, from signals available before any GPU work — reported memory,
 * logical-core count, and whether this is a phone.
 *
 * The budget is the GPU-memory safeguard and the frame-time safeguard: a
 * weaker device loads fewer points, so a large survey degrades gracefully
 * instead of crashing the GPU or dropping below an interactive frame rate.
 * The desktop rungs are sized from a measured per-point frame cost, below.
 *
 * Pure — no DOM, no three.js — so the tier logic is unit-tested in Node.
 */

/** A coarse device-capability bucket. */
export type DeviceTier = 'high' | 'medium' | 'low';

/** The capability signals a device exposes before rendering begins. */
export interface DeviceSignals {
  /** `navigator.deviceMemory` in GB — Chromium only; capped at 8. */
  deviceMemoryGB?: number;
  /** `navigator.hardwareConcurrency` — logical core count. */
  hardwareConcurrency?: number;
  /** True on phone-class devices. */
  isMobile: boolean;
}

/** What a device tier may safely do. */
export interface DeviceCaps {
  tier: DeviceTier;
  /** Maximum points to decode and upload to the GPU on this device. */
  renderBudget: number;
}

/**
 * The measurement the desktop ladder is derived from.
 *
 * Measured on an M3 Max with a 30-core GPU, headed Chromium on the WebGPU
 * backend, over a 4,898,193-point synthetic cloud spanning 159.6 x 202.4 x
 * 93.4 m: frame time is linear in point count at 5.6 ns per point per frame
 * (1.22 M = 6.6 ms, 2.45 M = 13.4 ms, 4.90 M = 27.7 ms, 6.00 M = 37.5 ms).
 * The former `high` of 6_000_000 measured 37.5 ms, about 27 fps, on the
 * fastest laptop GPU in the target class. A confirmation run at the 3 M rung,
 * 1600 x 1000 CSS pixels at device-pixel-ratio 2, measured 16.6 to 17.4 ms.
 *
 * Exported so `tests/deviceProfile.test.ts` pins the ladder's arithmetic
 * instead of the numbers being asserted in prose alone.
 */
export const RENDER_BUDGET_BASIS = {
  /** Frame cost of one rendered point on the reference GPU, in nanoseconds. */
  nsPerPointPerFrame: 5.6,
  /** The frame time every rung is sized to. 16.8 ms is 59.5 fps. */
  frameMs: 16.8,
} as const;

/**
 * Per-point slowdown each desktop tier is sized for, against the reference
 * GPU. A `high` machine is the reference; `medium` and `low` are graded from
 * the same memory and core signals `deviceTier` reads, so the factors stand in
 * for the GPU those signals imply.
 */
export const TIER_SLOWDOWN: Record<DeviceTier, number> = {
  high: 1,
  medium: 1.5,
  low: 2.5,
};

/**
 * Per-tier point budgets, desktop. Each rung is the point count that holds
 * `RENDER_BUDGET_BASIS.frameMs` on a device of that class, so on the reference
 * GPU they cost 16.8 ms, 11.2 ms and 6.7 ms. `GPU_HARD_POINT_CEILING` in
 * Viewer.ts sits above every rung and stays the out-of-memory backstop.
 */
const DESKTOP_BUDGET: Record<DeviceTier, number> = {
  high: 3_000_000,
  medium: 2_000_000,
  low: 1_200_000,
};

/**
 * Per-tier point budgets, mobile, tighter throughout. These are not derived
 * from the desktop measurement: no phone-class per-point frame cost has been
 * measured, so they stay at the values field use settled on.
 */
const MOBILE_BUDGET: Record<DeviceTier, number> = {
  high: 1_500_000,
  medium: 1_500_000,
  low: 800_000,
};

/**
 * Classify a device into a capability tier.
 *
 * A phone is `low` unless it reports ample memory and cores; it is never
 * `high`. A desktop is graded by reported memory, falling back to core count
 * when memory is unreported (Safari and Firefox do not expose `deviceMemory`);
 * an unknowable desktop is assumed `medium` so capable machines are never
 * needlessly degraded.
 */
export function deviceTier(signals: DeviceSignals): DeviceTier {
  const mem = signals.deviceMemoryGB;
  const cores = signals.hardwareConcurrency;

  if (signals.isMobile) {
    if (mem !== undefined && mem >= 6 && cores !== undefined && cores >= 6) {
      return 'medium';
    }
    return 'low';
  }

  if (mem !== undefined) {
    if (mem <= 2) return 'low';
    if (mem >= 8) return cores === undefined || cores >= 8 ? 'high' : 'medium';
    return 'medium';
  }

  // Memory unreported — grade on cores alone, conservatively.
  if (cores !== undefined && cores <= 2) return 'low';
  return 'medium';
}

/** The capability caps for a device — its tier and safe render budget. */
export function deviceCaps(signals: DeviceSignals): DeviceCaps {
  const tier = deviceTier(signals);
  const table = signals.isMobile ? MOBILE_BUDGET : DESKTOP_BUDGET;
  return { tier, renderBudget: table[tier] };
}
