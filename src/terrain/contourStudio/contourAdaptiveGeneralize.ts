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
 * The per-feature tolerance multiplier (§16.1/§16.2). Deterministic, and always
 * within a bounded band [0.25×, 2×] of the base so a single feature can never
 * be wildly over- or under-generalized.
 */
export function adaptiveToleranceFactor(
  f: ContourFeature,
  opts: { longFeatureLen: number; smallRingLen: number },
): number {
  let factor = 1;

  // Support: smooth interpolated less, unsupported least (fidelity over polish).
  if (f.grade === 'dashed') factor *= 0.6;
  else if (f.grade === 'gap') factor *= 0.4;

  // Low confidence → keep more of the original shape.
  if (Number.isFinite(f.meanConfidence) && f.meanConfidence < 50) factor *= 0.7;

  const len = featureLength(f);

  // Small closed summit/depression → preserve its (few) vertices.
  if (f.closed && len <= opts.smallRingLen) factor *= 0.4;

  // Long, strongly-measured contour → safe to generalize a little harder.
  if (f.grade === 'solid' && len >= opts.longFeatureLen) factor *= 1.5;

  // Bound the band.
  return Math.max(0.25, Math.min(2, factor));
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
    methodVersion: opts.methodVersion ?? '1',
    toleranceForFeature: (f, base) => base * adaptiveToleranceFactor(f, { longFeatureLen, smallRingLen }),
  });
}
