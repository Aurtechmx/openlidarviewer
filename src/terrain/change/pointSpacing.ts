/**
 * pointSpacing.ts
 *
 * Mean horizontal point spacing, the length scale both halves of a two-epoch
 * comparison are sized from: the alignment's pairing distance and the shared
 * change grid's cell. Pure: no DOM, no three.js.
 */

import type { Vec3 } from './icpRegister';

/**
 * Mean horizontal spacing of a point set: the square root of its occupied
 * footprint area per point. The footprint is counted on square bins two
 * spacings wide, starting from the bounding-box estimate and refined twice, so
 * a cloud that fills only part of its bounding box is not read as sparse.
 *
 * `representedCount` is the number of points `points` stands for when it is a
 * sample of a larger cloud: the footprint is measured on the sample and
 * divided among the represented points. NaN when the points have no
 * horizontal extent.
 */
export function meanPointSpacing(points: readonly Vec3[], representedCount = points.length): number {
  const n = points.length;
  const total = Math.max(n, representedCount);
  if (n < 2) return Number.NaN;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const ex = maxX - minX;
  const ey = maxY - minY;
  if (!(ex > 0) && !(ey > 0)) return Number.NaN;
  // A line of points: its length per point.
  if (!(ex > 0) || !(ey > 0)) return Math.max(ex, ey) / (total - 1);
  let sampleSpacing = Math.sqrt((ex * ey) / n);
  let area = ex * ey;
  for (let pass = 0; pass < 2; pass++) {
    const bin = 2 * sampleSpacing;
    const nx = Math.floor(ex / bin) + 1;
    const occupied = new Set<number>();
    for (const p of points) {
      occupied.add(Math.floor((p[1] - minY) / bin) * nx + Math.floor((p[0] - minX) / bin));
    }
    area = occupied.size * bin * bin;
    sampleSpacing = Math.sqrt(area / n);
  }
  return Math.sqrt(area / total);
}

/**
 * Mean horizontal spacing of an interleaved xyz buffer (local + origin), from
 * a stride sample of at most `maxSamples` finite points. NaN when it cannot be
 * estimated.
 */
export function positionsSpacing(
  positions: Float32Array,
  origin: readonly [number, number, number] = [0, 0, 0],
  maxSamples = 20000,
): number {
  const n = (positions.length / 3) | 0;
  let finite = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(positions[i * 3]) && Number.isFinite(positions[i * 3 + 1])) finite++;
  }
  if (finite < 2) return Number.NaN;
  const stride = Math.max(1, Math.floor(n / maxSamples));
  const sample: Vec3[] = [];
  for (let i = 0; i < n; i += stride) {
    const x = positions[i * 3], y = positions[i * 3 + 1];
    if (Number.isFinite(x) && Number.isFinite(y)) sample.push([x + origin[0], y + origin[1], 0]);
  }
  return meanPointSpacing(sample, finite);
}
