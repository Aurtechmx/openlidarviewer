/**
 * deviceProfile.ts
 *
 * Derives a coarse device-capability tier and the point budget that tier can
 * safely render, from signals available before any GPU work — reported memory,
 * logical-core count, and whether this is a phone.
 *
 * The budget is the GPU-memory safeguard: a weak device loads fewer
 * points, so a large survey degrades gracefully instead of crashing the GPU.
 * Capable devices are unaffected — the `high`/`medium` budgets match the
 * canonical desktop and mobile budgets.
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

/** Per-tier point budgets — desktop. `high` and `medium` use the canonical cap. */
const DESKTOP_BUDGET: Record<DeviceTier, number> = {
  high: 4_000_000,
  medium: 4_000_000,
  low: 2_000_000,
};

/** Per-tier point budgets — mobile, tighter throughout. */
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
