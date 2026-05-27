/**
 * streamingProfile.ts
 *
 * Device-driven streaming defaults.
 *
 * Maps a device-capability tier (`low | medium | high`, derived in
 * {@link ../deviceProfile.ts}) onto the full set of streaming-session
 * defaults the Viewer needs at attach time: quality preset (which drives the
 * resident-point budget, decode concurrency, and compressed-cache size via
 * {@link streamingBudgets}), whether Eye Dome Lighting is on by default, and
 * whether node fade-in is enabled. Runtime FPS-based tier adaptation
 * (see `tierAdaptation.ts`) layers on top.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

import type { DeviceTier } from '../deviceProfile';
import { streamingBudgets } from './streamingBudget';
import type { StreamingBudgets, StreamingQuality } from './streamingBudget';

/** The fully-resolved per-tier streaming-session defaults. */
export interface StreamingProfile {
  /** Device-capability tier this profile targets. */
  tier: DeviceTier;
  /** User-equivalent quality preset for this tier. */
  quality: StreamingQuality;
  /** Resident-point budget, decode concurrency, compressed-cache bytes. */
  budgets: StreamingBudgets;
  /** Whether EDL should be on by default on this tier. */
  edlDefault: boolean;
  /** Whether node fade-in is enabled on this tier. */
  fadeIn: boolean;
}

/**
 * Map a device tier to a quality preset. The mapping is intentionally
 * straightforward (low → low, medium → balanced, high → high); the per-
 * quality budget tables in {@link streamingBudgets} carry the actual point
 * counts and concurrency limits.
 */
export function qualityForTier(tier: DeviceTier): StreamingQuality {
  if (tier === 'low') return 'low';
  if (tier === 'high') return 'high';
  return 'balanced';
}

/**
 * Resolve a full {@link StreamingProfile} from a device tier and the mobile
 * flag. EDL is off on low-tier devices (the soft-shading pass is the most
 * expensive frame-time cost on a weak GPU); fade-in is off on low-tier and
 * on mobile, matching the fade-in guard in `attachStreamingCloud`.
 */
export function streamingProfileForTier(
  tier: DeviceTier,
  isMobile: boolean,
): StreamingProfile {
  const quality = qualityForTier(tier);
  return {
    tier,
    quality,
    budgets: streamingBudgets(quality, isMobile),
    edlDefault: tier !== 'low',
    fadeIn: tier !== 'low' && !isMobile,
  };
}
