/**
 * measureDerivations.ts — two pure measure helpers lifted from main.ts.
 *
 * `deriveVolumeRecord` turns a raw integration result into the record the UI
 * stores, and `horizontalSpanXY` measures a point set's larger horizontal
 * extent. Both were inline in main.ts with no test; both are pure.
 */

import type { VolumeResult } from './volume';
import type { VolumeRecord } from './types';

/** Points inside the footprint at or above which the volume is high confidence. */
const HIGH_CONFIDENCE_POINTS = 1000;
/** ...and medium; below this is low. */
const MEDIUM_CONFIDENCE_POINTS = 100;

/**
 * Shape a `VolumeResult` into the stored `VolumeRecord`.
 *
 * Confidence is a coarse tier on the point count inside the footprint — a
 * sparse selection can still integrate, but the result deserves less trust.
 * A non-finite skip count is carried only when there was one, so a clean
 * result does not advertise an exclusion it did not make.
 */
export function deriveVolumeRecord(result: VolumeResult, referenceZ: number): VolumeRecord {
  const inPoly = result.pointsInPolygon;
  const confidence: 'high' | 'medium' | 'low' =
    inPoly >= HIGH_CONFIDENCE_POINTS ? 'high'
    : inPoly >= MEDIUM_CONFIDENCE_POINTS ? 'medium'
    : 'low';
  const record: VolumeRecord = {
    fill: result.fill,
    cut: result.cut,
    net: result.net,
    referenceZ,
    footprintArea: result.footprintArea,
    pointsInPolygon: result.pointsInPolygon,
    densityNative: result.densityNative,
    confidence,
  };
  const skippedNonFinite = result.skippedNonFinite ?? 0;
  if (skippedNonFinite > 0) record.skippedNonFinite = skippedNonFinite;
  return record;
}

/** How many points to sample when estimating a span — enough for a stable extent. */
const SPAN_SAMPLE_TARGET = 2000;

/**
 * The larger of a point set's X and Y extents, in world coordinates.
 *
 * Strided to at most ~2000 samples, because a footprint extent does not need
 * every point and a full pass over millions is wasteful. `origin` shifts the
 * local coordinates back to world space; it cancels in the extent, so it is
 * only kept for callers that pass it and to match the source-local convention.
 * Non-finite points are skipped rather than allowed to blow the bounds out to
 * infinity, and an all-non-finite (or empty) set returns 0.
 *
 * This reads `.positions` combined with an origin, so it is one of the
 * world-coordinate boundary sites the Float64 transform migration targets.
 */
export function horizontalSpanXY(
  positions: Float32Array,
  origin?: readonly [number, number, number],
): number {
  const n = (positions.length / 3) | 0;
  if (n === 0) return 0;
  const ox = origin?.[0] ?? 0;
  const oy = origin?.[1] ?? 0;
  const stride = Math.max(1, Math.floor(n / SPAN_SAMPLE_TARGET));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const x = positions[i * 3] + ox;
    const y = positions[i * 3 + 1] + oy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX ? Math.max(maxX - minX, maxY - minY) : 0;
}
