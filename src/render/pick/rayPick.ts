/**
 * rayPick.ts — a uniform-grid spatial index for angular-miss ray picking.
 *
 * The shipping picker (`nearestPointAlongRay` in ../navMath) scans every point
 * in a cloud for each hover or click — O(N) per query, over a buffer that can
 * hold millions of points, on the pointer-move-driven probe path. This module
 * builds a uniform cell grid over the same interleaved Float32 position buffer
 * once, then answers a pick by visiting only the cells the ray's acceptance
 * cone can touch, so a repeated interactive query costs work proportional to
 * the cone rather than to the cloud.
 *
 * CONTRACT. For a given (origin, dir, tolerance, accept) the winning point is
 * the SAME point the linear scan accepts. "Accept" is the caller's angular gate
 * `offset / along < tolerance` (the 0.07 the Viewer and the streaming picker
 * use). The metric (perpendicular-offset-squared over along-squared, with the
 * perpendicular taken from the cross product |v x d|, not |v|^2 - along^2), the
 * strict-less update that makes the lowest point index win an exact tie, and
 * the `along > 0` in-front rule all match ../navMath exactly, so the winning
 * index is identical. tests/rayPick.test.ts fuzzes this against the real
 * `nearestPointAlongRay` across randomized clouds and rays.
 *
 * SAFETY. The grid is an optimisation, never a correctness authority: on a
 * degenerate grid, a ray that misses the cloud's box, or a cone that would
 * cover most of the grid, the query falls back to the exact linear scan. It can
 * therefore never return a point the linear scan would not, nor miss one it
 * would.
 *
 * FRAME. The index, the ray, and the accept predicate are all in the caller's
 * chosen frame (whatever frame the passed-in buffer is in). Build one index per
 * immutable position buffer, mirroring PointCloud's lazy bounds cache.
 */
import type { Vec3 } from '../navMath';

/** An opaque uniform-grid index over a cloud's interleaved xyz positions. */
export interface RayPickIndex {
  /** The indexed buffer, referenced (not copied). */
  readonly positions: Float32Array;
  /** Number of points (`positions.length / 3`). */
  readonly count: number;
  /** Edge length of one cubic cell, or Infinity for a degenerate grid. */
  readonly cellSize: number;
  /** Grid origin (min corner) in the buffer's frame. */
  readonly min: Vec3;
  /** Cell counts per axis (each >= 1). */
  readonly dims: Vec3;
  /** Packed cell key -> point indices in that cell. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
}

/** A picked point. `index` is the point index (buffer offset / 3). */
export interface RayPickHit {
  readonly index: number;
  readonly point: Vec3;
  /** Perpendicular distance from the ray line (world units). */
  readonly offset: number;
  /** Projection distance from origin to closest approach. */
  readonly along: number;
}

/**
 * Build a uniform-grid index over an interleaved xyz `Float32Array`.
 *
 * Cell size targets roughly one point per cell (`cbrt(volume / count)`), the
 * same heuristic the snap index uses. Non-finite points are left out of the
 * grid: the linear scan can never pick one either (their score is NaN and every
 * comparison against it is false), so omitting them keeps the two in agreement.
 */
export function buildRayPickIndex(positions: Float32Array): RayPickIndex {
  const count = Math.floor(positions.length / 3);
  if (count === 0) {
    return { positions, count: 0, cellSize: Infinity, min: [0, 0, 0], dims: [1, 1, 1], cells: new Map() };
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX)) {
    // No finite point: a degenerate index that always falls back to linear.
    return { positions, count, cellSize: Infinity, min: [0, 0, 0], dims: [1, 1, 1], cells: new Map() };
  }

  const spanX = Math.max(maxX - minX, 0);
  const spanY = Math.max(maxY - minY, 0);
  const spanZ = Math.max(maxZ - minZ, 0);
  const volume = spanX * spanY * spanZ;
  let cellSize: number;
  if (volume > 0) {
    cellSize = Math.cbrt(volume / count);
  } else {
    const largest = Math.max(spanX, spanY, spanZ);
    cellSize = largest > 0 ? largest : 1;
  }
  if (!Number.isFinite(cellSize) || cellSize <= 0) cellSize = 1;

  const dimX = Math.max(1, Math.floor(spanX / cellSize) + 1);
  const dimY = Math.max(1, Math.floor(spanY / cellSize) + 1);
  const dimZ = Math.max(1, Math.floor(spanZ / cellSize) + 1);

  const cells = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const ix = Math.min(dimX - 1, Math.floor((x - minX) / cellSize));
    const iy = Math.min(dimY - 1, Math.floor((y - minY) / cellSize));
    const iz = Math.min(dimZ - 1, Math.floor((z - minZ) / cellSize));
    const key = (ix * dimY + iy) * dimZ + iz;
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, [i]); else bucket.push(i);
  }

  return { positions, count, cellSize, min: [minX, minY, minZ], dims: [dimX, dimY, dimZ], cells };
}

/**
 * Pick the point of smallest angular miss along `dir` from `origin` whose miss
 * is under `tolerance`, or null when none qualifies.
 *
 * Identical in result to accepting `nearestPointAlongRay(...)` under
 * `offset / along < tolerance`. `dir` need not be unit length. `accept`, when
 * given, receives the point index and gates candidacy exactly as the linear
 * scan's predicate does.
 */
export function pickAlongRay(
  index: RayPickIndex,
  origin: Vec3,
  dir: Vec3,
  tolerance: number,
  accept?: (i: number) => boolean,
): RayPickHit | null {
  const { positions, count, cellSize, min, dims } = index;
  if (count === 0) return null;

  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  const dx = dir[0] / len, dy = dir[1] / len, dz = dir[2] / len;
  const ox = origin[0], oy = origin[1], oz = origin[2];
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return null;
  if (!(tolerance > 0) || !Number.isFinite(tolerance)) return null;

  const tolSq = tolerance * tolerance;

  // Running winner. The tie-break (`i < bestIndex` on an exact score tie)
  // reproduces the linear scan's lowest-index-wins regardless of visit order.
  let bestScoreSq = Infinity;
  let bestIndex = -1;
  let bestPerpSq = 0;
  let bestAlong = 0;
  const consider = (i: number): void => {
    if (accept !== undefined && !accept(i)) return;
    const vx = positions[i * 3] - ox, vy = positions[i * 3 + 1] - oy, vz = positions[i * 3 + 2] - oz;
    const along = vx * dx + vy * dy + vz * dz;
    if (along <= 0) return;
    const cx = vy * dz - vz * dy, cy = vz * dx - vx * dz, cz = vx * dy - vy * dx;
    const perpSq = cx * cx + cy * cy + cz * cz;
    const scoreSq = perpSq / (along * along);
    if (scoreSq < bestScoreSq || (scoreSq === bestScoreSq && (bestIndex === -1 || i < bestIndex))) {
      bestScoreSq = scoreSq; bestIndex = i; bestPerpSq = perpSq; bestAlong = along;
    }
  };

  const finish = (): RayPickHit | null => {
    if (bestIndex === -1 || bestScoreSq >= tolSq) return null;
    return {
      index: bestIndex,
      point: [positions[bestIndex * 3], positions[bestIndex * 3 + 1], positions[bestIndex * 3 + 2]],
      offset: Math.sqrt(bestPerpSq),
      along: bestAlong,
    };
  };

  const scanLinear = (): RayPickHit | null => {
    for (let i = 0; i < count; i++) consider(i);
    return finish();
  };

  // Degenerate grid: nothing to walk, scan exactly.
  if (!Number.isFinite(cellSize) || cellSize <= 0 || index.cells.size === 0) {
    return scanLinear();
  }

  const dimX = dims[0], dimY = dims[1], dimZ = dims[2];
  const bMinX = min[0], bMinY = min[1], bMinZ = min[2];
  const bMaxX = bMinX + dimX * cellSize;
  const bMaxY = bMinY + dimY * cellSize;
  const bMaxZ = bMinZ + dimZ * cellSize;

  // Ray/box slab intersection, in the along parameter (dir is unit).
  let tEnter = 0;
  let tExit = Infinity;
  const slab = (o: number, d: number, lo: number, hi: number): boolean => {
    if (d === 0) return o >= lo && o <= hi; // parallel: inside the slab or never
    let t0 = (lo - o) / d, t1 = (hi - o) / d;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tEnter) tEnter = t0;
    if (t1 < tExit) tExit = t1;
    return tEnter <= tExit;
  };
  const hitsBox =
    slab(ox, dx, bMinX, bMaxX) &&
    slab(oy, dy, bMinY, bMaxY) &&
    slab(oz, dz, bMinZ, bMaxZ);

  if (!hitsBox || tExit <= 0) {
    // The forward ray line never enters the cloud's box. A point could still
    // fall inside the narrow acceptance cone near a corner, so this is not
    // automatically empty; the exact linear scan settles it. This is the
    // "hovering past the cloud" case, rare on the interactive hot path.
    return scanLinear();
  }
  if (tEnter < 0) tEnter = 0;

  // Walk the ray's span through the box, sampling at cell-length steps. Around
  // each sampled cell, scan a cube of cells wide enough to hold any point whose
  // angular miss is under tolerance at that distance: at along `a` such a point
  // lies within `tolerance * a` of the line. `+ 2` covers cell quantisation and
  // the up-to-one-cell gap between a point's true along and its nearest sample.
  const visited = new Set<number>();
  const cellOf = (a: number): [number, number, number] => {
    const px = ox + a * dx, py = oy + a * dy, pz = oz + a * dz;
    const cx = Math.min(dimX - 1, Math.max(0, Math.floor((px - bMinX) / cellSize)));
    const cy = Math.min(dimY - 1, Math.max(0, Math.floor((py - bMinY) / cellSize)));
    const cz = Math.min(dimZ - 1, Math.max(0, Math.floor((pz - bMinZ) / cellSize)));
    return [cx, cy, cz];
  };

  // If the cone would sweep most of the grid, the walk saves nothing; scan.
  const coneRadiusCellsAt = (a: number): number => Math.floor((tolerance * a) / cellSize) + 2;
  if (coneRadiusCellsAt(tExit) * 2 + 1 >= Math.max(dimX, dimY, dimZ)) {
    return scanLinear();
  }

  const scanCell = (cx: number, cy: number, cz: number): void => {
    if (cx < 0 || cy < 0 || cz < 0 || cx >= dimX || cy >= dimY || cz >= dimZ) return;
    const key = (cx * dimY + cy) * dimZ + cz;
    if (visited.has(key)) return;
    visited.add(key);
    const bucket = index.cells.get(key);
    if (bucket === undefined) return;
    for (let k = 0; k < bucket.length; k++) consider(bucket[k]);
  };

  const step = cellSize;
  for (let a = tEnter; a <= tExit + step; a += step) {
    const clamped = a > tExit ? tExit : a;
    const [cx, cy, cz] = cellOf(clamped);
    const r = coneRadiusCellsAt(clamped);
    for (let di = -r; di <= r; di++) {
      for (let dj = -r; dj <= r; dj++) {
        for (let dk = -r; dk <= r; dk++) {
          scanCell(cx + di, cy + dj, cz + dk);
        }
      }
    }
    if (clamped === tExit) break;
  }

  return finish();
}
