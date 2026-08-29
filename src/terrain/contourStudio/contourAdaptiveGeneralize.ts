/**
 * contourAdaptiveGeneralize.ts
 *
 * Terrain-aware generalization (v0.5.9 spec §16.1/§16.2, PR8). Instead of one
 * uniform simplification tolerance, this scales the tolerance PER FEATURE from
 * what the feature is:
 *
 *  - smooth LESS (smaller tolerance) where fidelity matters — interpolated or
 *    low-confidence support, and small closed summits/depressions whose shape a
 *    coarse tolerance would erase;
 *  - smooth MORE (larger tolerance) where it is safe and helps legibility —
 *    strongly-measured, long contours.
 *
 * It is a thin, honest policy on top of the PR6 `cartographicProduct`: it only
 * decides the per-feature tolerance and delegates the geometry + displacement +
 * topology recording to the shared generalizer, so analytical geometry stays
 * immutable and the displacement stats stay real.
 */

import type { ContourFeature } from '../contour/contourFeatureModel';
import { terrainAwareToleranceFactor } from '../contour/terrainAwareTolerance';
import {
  cartographicProduct,
  type ContourGeometryProduct,
} from './contourGeometryProduct';
import type { LinearUnitScale } from '../../units/units';

export interface AdaptiveGeneralizeOptions {
  /** Nominal (base) tolerance in source units — the tolerance for an average,
   *  well-measured, medium-length contour. Must be > 0. */
  readonly baseToleranceSource: number;
  readonly horizontalUnit: LinearUnitScale;
  /** A contour at or above this length (source units) is treated as "long". */
  readonly longFeatureLen?: number;
  /** A closed ring at or below this length (source units) is a small
   *  summit/depression whose shape must be preserved. */
  readonly smallRingLen?: number;
  readonly methodId?: string;
  readonly methodVersion?: string;
}

function featureLength(f: ContourFeature): number {
  let len = 0;
  const c = f.coordinates;
  for (let i = 1; i < c.length; i++) len += Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]);
  return len;
}

/**
 * The per-feature tolerance multiplier for a {@link ContourFeature} (the staged
 * source-unit product path). Thin adapter over the shared
 * {@link terrainAwareToleranceFactor} policy (see `../contour/terrainAwareTolerance`).
 */
export function adaptiveToleranceFactor(
  f: ContourFeature,
  opts: { longFeatureLen: number; smallRingLen: number },
): number {
  return terrainAwareToleranceFactor(
    { grade: f.grade, meanConfidence: f.meanConfidence, closed: f.closed, length: featureLength(f) },
    opts,
  );
}

/**
 * Build a cartographic product with a terrain-aware per-feature tolerance.
 * Delegates all geometry to `cartographicProduct` (PR6), so the analytical input
 * is untouched and displacement/topology are recorded honestly.
 */
export function terrainAwareCartographicProduct(
  analytical: ContourGeometryProduct,
  opts: AdaptiveGeneralizeOptions,
): ContourGeometryProduct {
  const longFeatureLen = opts.longFeatureLen ?? opts.baseToleranceSource * 40;
  const smallRingLen = opts.smallRingLen ?? opts.baseToleranceSource * 8;
  return cartographicProduct(analytical, {
    toleranceSource: opts.baseToleranceSource,
    horizontalUnit: opts.horizontalUnit,
    methodId: opts.methodId ?? 'olv.contour.generalize.terrain-adaptive',
    // Let cartographicProduct derive the version from the registry unless a
    // caller explicitly overrides it — no hardcoded literal.
    methodVersion: opts.methodVersion,
    toleranceForFeature: (f, base) => base * adaptiveToleranceFactor(f, { longFeatureLen, smallRingLen }),
  });
}
