/**
 * scanRoute.ts
 *
 * The MANUAL scan-type override and the tiny pure helper that resolves it.
 *
 * Auto-detection (`classifyScanShape`) occasionally misreads a scan — e.g. a
 * real 360 house showing the Object report instead of Interior. The override is
 * the safety net: the user can FORCE the type, and a non-auto choice WINS over
 * the detected verdict so any misdetection is one click to fix.
 *
 * This module is deliberately UI- and DOM-free so the routing decision can be
 * unit-tested in isolation and reused by `applyScanRoute` in `src/main.ts`.
 */

import type { SpaceKind } from './scanShape';

/**
 * The per-session manual override. `'auto'` defers to detection (today's
 * behaviour); the other three force the corresponding route, mapping 1:1 onto
 * {@link SpaceKind}.
 */
export type ScanTypeOverride = 'auto' | 'terrain' | 'object' | 'interior';

/**
 * Decide the EFFECTIVE route from the detected verdict and the manual override.
 *
 *   - `override === 'auto'` → the detected verdict wins (unchanged behaviour).
 *   - any other override    → it wins outright, regardless of what was detected.
 *
 * Pure and total: the non-auto override values are exactly the {@link SpaceKind}
 * members, so the forced value is returned directly.
 */
export function resolveScanRoute(
  detected: SpaceKind,
  override: ScanTypeOverride,
): SpaceKind {
  if (override === 'auto') return detected;
  return override;
}
