/**
 * snap.ts
 *
 * Pure "snap" core for the measurement toolkit — given a query point in a
 * cloud's LOCAL (render-space) coordinates, find the best thing to snap it to.
 * Two honestly-distinct categories of target:
 *
 *   1. A REAL measured return — the nearest ACTUAL point in the cloud
 *      (`kind: 'point'`, with `pointIndex` set). This is a datum the sensor
 *      recorded: snapping here means the measurement vertex sits on a point the
 *      instrument truly observed.
 *
 *   2. A CONSTRUCTED geometry feature — an endpoint, a segment midpoint, or the
 *      intersection of two segments of EXISTING measurements
 *      (`kind: 'endpoint' | 'midpoint' | 'intersection'`, no `pointIndex`).
 *      These are inferred from vertices the user already placed, not observed
 *      by the sensor.
 *
 * The `pointIndex` field is the honesty signal: it is set ONLY for a real
 * measured return, so the caller's UI can disclose "snapped to a measured
 * point" versus "snapped to constructed geometry" rather than blurring the two.
 *
 * Pure math + typed arrays only: no DOM, no three.js. Deterministic
 * (lowest-index tie-breaks), TypeScript strict, unit-tested in Node.
 */

/** A point/vertex tuple in LOCAL render-space — the same space the cloud lives in. */
export type Vec3 = readonly [number, number, number];

/** A single polyline: an ordered list of vertices. */
export type Polyline = ReadonlyArray<Vec3>;

/** The set of measurement polylines snap geometry is derived from. */
export type Segments = ReadonlyArray<Polyline>;

/**
 * The outcome of a snap. `position` is the snapped location in LOCAL
 * render-space; `distance` is the Euclidean distance from the query to it.
 *
 * `pointIndex` is set ONLY for `kind: 'point'` — it is the index of the real
 * measured return in the cloud's positions buffer (point i occupies
 * positions[3i], positions[3i+1], positions[3i+2]). Geometry kinds never carry
 * a `pointIndex`, by construction: they are not measured returns.
 */
export interface SnapResult {
  kind: 'point' | 'endpoint' | 'midpoint' | 'intersection';
  position: [number, number, number];
  distance: number;
  pointIndex?: number;
}

/**
 * An opaque uniform-grid spatial index over a cloud's LOCAL-space points.
 * Built once per cloud by {@link buildPointSnapIndex}; queried by
 * {@link snapToNearestPoint}. The fields are implementation detail — treat the
 * interface as opaque.
 */
export interface PointSnapIndex {
  /** The interleaved xyz positions this index was built over (not copied). */
  readonly positions: Float32Array;
  /** Number of points (positions.length / 3, floored). */
  readonly count: number;
  /** Uniform cell edge length in render units; > 0 (or Infinity for <=1 point). */
  readonly cellSize: number;
  /** Inclusive minimum corner of the bounding box (x, y, z). */
  readonly min: readonly [number, number, number];
  /** Grid cell counts per axis (>= 1 each). */
  readonly dims: readonly [number, number, number];
  /** Map from packed cell key -> list of point indices in that cell. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
}

// -- small helpers -----------------------------------------------------------

function dist2(ax: number, ay: number, az: number, b: Vec3): number {
  const dx = ax - b[0];
  const dy = ay - b[1];
  const dz = az - b[2];
  return dx * dx + dy * dy + dz * dz;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.sqrt(dist2(a[0], a[1], a[2], b));
}

/** Pack three non-negative cell coords into one number key. */
function cellKey(ix: number, iy: number, iz: number, dims: readonly [number, number, number]): number {
  return (ix * dims[1] + iy) * dims[2] + iz;
}

// -- index construction ------------------------------------------------------

/**
 * Build a uniform-grid spatial index over a cloud's interleaved xyz positions.
 * The cell size is derived from the bounding-box volume and point count so that
 * cells hold roughly one point on average — a good default for nearest-point
 * queries. Empty (or sub-triple) input yields a valid, empty index that every
 * query safely returns `null` from.
 */
export function buildPointSnapIndex(positions: Float32Array): PointSnapIndex {
  const count = Math.floor(positions.length / 3);

  if (count === 0) {
    return {
      positions,
      count: 0,
      cellSize: Infinity,
      min: [0, 0, 0],
      dims: [1, 1, 1],
      cells: new Map<number, readonly number[]>(),
    };
  }

  // Bounds.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  // Derive a cell size aiming at ~1 point/cell: cbrt(volume / count). Fall back
  // to the largest finite span (a flat/line cloud) and finally to a unit cell.
  const volume = Math.max(spanX, 0) * Math.max(spanY, 0) * Math.max(spanZ, 0);
  let cellSize = volume > 0 ? Math.cbrt(volume / count) : 0;
  if (!(cellSize > 0)) {
    const maxSpan = Math.max(spanX, spanY, spanZ);
    cellSize = maxSpan > 0 ? maxSpan : 1;
  }

  const dims: [number, number, number] = [
    Math.max(1, Math.floor(spanX / cellSize) + 1),
    Math.max(1, Math.floor(spanY / cellSize) + 1),
    Math.max(1, Math.floor(spanZ / cellSize) + 1),
  ];

  const cells = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const ix = Math.min(dims[0] - 1, Math.floor((positions[i * 3] - minX) / cellSize));
    const iy = Math.min(dims[1] - 1, Math.floor((positions[i * 3 + 1] - minY) / cellSize));
    const iz = Math.min(dims[2] - 1, Math.floor((positions[i * 3 + 2] - minZ) / cellSize));
    const key = cellKey(ix, iy, iz, dims);
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, [i]);
    else bucket.push(i);
  }

  return {
    positions,
    count,
    cellSize,
    min: [minX, minY, minZ],
    dims,
    cells,
  };
}

// -- nearest actual point ----------------------------------------------------

/**
 * Nearest ACTUAL cloud point within `maxDistance` (Euclidean) of `query`,
 * returned as a `kind: 'point'` result with `pointIndex` set. Deterministic:
 * an exact distance tie resolves to the lowest point index. Returns `null` when
 * the cloud is empty, `maxDistance` is non-positive, or no point is in range.
 *
 * Searches outward from the query's cell in expanding shells, stopping once the
 * shell's guaranteed-minimum distance exceeds both `maxDistance` and the best
 * hit so far — so it never has to scan the whole cloud.
 */
export function snapToNearestPoint(
  index: PointSnapIndex,
  query: Vec3,
  maxDistance: number,
): SnapResult | null {
  if (index.count === 0 || !(maxDistance > 0)) return null;

  const { positions, cellSize, min, dims, cells } = index;
  const maxD2 = maxDistance * maxDistance;

  let bestIndex = -1;
  let bestD2 = Infinity;

  const consider = (i: number): void => {
    const d2 = dist2(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], query);
    if (d2 > maxD2) return;
    if (d2 < bestD2 || (d2 === bestD2 && (bestIndex < 0 || i < bestIndex))) {
      bestD2 = d2;
      bestIndex = i;
    }
  };

  // If cellSize is non-finite (<=1 point, no extent) just scan linearly.
  if (!isFinite(cellSize)) {
    for (let i = 0; i < index.count; i++) consider(i);
    return bestIndex < 0
      ? null
      : {
          kind: 'point',
          position: [positions[bestIndex * 3], positions[bestIndex * 3 + 1], positions[bestIndex * 3 + 2]],
          distance: Math.sqrt(bestD2),
          pointIndex: bestIndex,
        };
  }

  const cx = Math.floor((query[0] - min[0]) / cellSize);
  const cy = Math.floor((query[1] - min[1]) / cellSize);
  const cz = Math.floor((query[2] - min[2]) / cellSize);

  // Shell radius must reach from the query's (possibly out-of-grid) cell to the
  // far edge of the grid on every axis — clamping cx/cy/cz would lose the offset
  // when the query lies outside the bounds, so account for it explicitly.
  const reach = (c: number, dim: number): number => Math.max(-c, c - (dim - 1), 0) + (dim - 1);
  const maxRadius = Math.max(reach(cx, dims[0]), reach(cy, dims[1]), reach(cz, dims[2]));

  const scanCell = (ix: number, iy: number, iz: number): void => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= dims[0] || iy >= dims[1] || iz >= dims[2]) return;
    const bucket = cells.get(cellKey(ix, iy, iz, dims));
    if (bucket === undefined) return;
    for (const i of bucket) consider(i);
  };

  for (let r = 0; r <= maxRadius; r++) {
    // A point found in shell r is at least (r-1)*cellSize away; once that floor
    // exceeds maxDistance and we already have any hit, no closer point remains.
    if (r > 0) {
      const shellFloor = (r - 1) * cellSize;
      if (shellFloor > maxDistance) break;
      if (bestIndex >= 0 && shellFloor * shellFloor > bestD2) break;
    }

    if (r === 0) {
      scanCell(cx, cy, cz);
      continue;
    }
    // Scan the surface of the cube shell at Chebyshev radius r.
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
          scanCell(cx + dx, cy + dy, cz + dz);
        }
      }
    }
  }

  return bestIndex < 0
    ? null
    : {
        kind: 'point',
        position: [
          positions[bestIndex * 3],
          positions[bestIndex * 3 + 1],
          positions[bestIndex * 3 + 2],
        ],
        distance: Math.sqrt(bestD2),
        pointIndex: bestIndex,
      };
}

/**
 * Count measured returns within `radius` of `query` — the local-support signal
 * for the per-measurement trust grade. Reuses the snap index's uniform grid:
 * scans only the cells the radius can reach, so it stays cheap even on millions
 * of points. (Called a few times per placed measurement, not in a hot loop.)
 */
export function countPointsWithinRadius(
  index: PointSnapIndex,
  query: Vec3,
  radius: number,
): number {
  if (index.count === 0 || !(radius > 0)) return 0;
  const { positions, cellSize, min, dims, cells } = index;
  const r2 = radius * radius;
  let count = 0;
  const consider = (i: number): void => {
    if (dist2(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], query) <= r2) count++;
  };

  if (!isFinite(cellSize)) {
    for (let i = 0; i < index.count; i++) consider(i);
    return count;
  }

  const cx = Math.floor((query[0] - min[0]) / cellSize);
  const cy = Math.floor((query[1] - min[1]) / cellSize);
  const cz = Math.floor((query[2] - min[2]) / cellSize);
  const span = Math.ceil(radius / cellSize) + 1;
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      for (let dz = -span; dz <= span; dz++) {
        const ix = cx + dx, iy = cy + dy, iz = cz + dz;
        if (ix < 0 || iy < 0 || iz < 0 || ix >= dims[0] || iy >= dims[1] || iz >= dims[2]) continue;
        const bucket = cells.get(cellKey(ix, iy, iz, dims));
        if (bucket !== undefined) for (const i of bucket) consider(i);
      }
    }
  }
  return count;
}

// -- measurement-geometry snaps ----------------------------------------------

/**
 * Nearest measurement VERTEX (endpoint) within `maxDistance` of `query`.
 * Returns a `kind: 'endpoint'` result (no `pointIndex` — a constructed
 * feature). Deterministic by first-encountered order on exact ties.
 */
export function snapToVertices(
  segments: Segments,
  query: Vec3,
  maxDistance: number,
): SnapResult | null {
  if (!(maxDistance > 0)) return null;
  let best: SnapResult | null = null;
  for (const line of segments) {
    for (const v of line) {
      const d = distance(v, query);
      if (d <= maxDistance && (best === null || d < best.distance)) {
        best = { kind: 'endpoint', position: [v[0], v[1], v[2]], distance: d };
      }
    }
  }
  return best;
}

/**
 * Nearest segment MIDPOINT within `maxDistance` of `query`. A midpoint exists
 * for each consecutive vertex pair in each polyline (a zero-length segment has
 * a well-defined midpoint = either endpoint). Returns `kind: 'midpoint'`
 * (no `pointIndex`).
 */
export function snapToMidpoints(
  segments: Segments,
  query: Vec3,
  maxDistance: number,
): SnapResult | null {
  if (!(maxDistance > 0)) return null;
  let best: SnapResult | null = null;
  for (const line of segments) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const mid: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const d = distance(mid, query);
      if (d <= maxDistance && (best === null || d < best.distance)) {
        best = { kind: 'midpoint', position: [mid[0], mid[1], mid[2]], distance: d };
      }
    }
  }
  return best;
}

/**
 * Robust 2D (XY-plane) intersection of two segments p1->p2 and p3->p4. Returns
 * the crossing with its parameters when the segments cross within both spans
 * (inclusive of endpoints), else null. Parallel/collinear pairs return null
 * (no single well-defined crossing).
 */
function segmentIntersectXY(
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  p4: Vec3,
): { x: number; y: number; t: number; u: number } | null {
  const r0 = p2[0] - p1[0];
  const r1 = p2[1] - p1[1];
  const s0 = p4[0] - p3[0];
  const s1 = p4[1] - p3[1];
  const denom = r0 * s1 - r1 * s0;
  if (Math.abs(denom) < 1e-12) return null; // parallel or degenerate
  const qpx = p3[0] - p1[0];
  const qpy = p3[1] - p1[1];
  const t = (qpx * s1 - qpy * s0) / denom;
  const u = (qpx * r1 - qpy * r0) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1[0] + t * r0, y: p1[1] + t * r1, t, u };
}

/**
 * Nearest INTERSECTION of two measurement segments, computed in the XY plane,
 * within `maxDistance` of `query`. The crossing's Z is the average of the two
 * segments' Z at the crossing parameters (an honest "constructed" elevation,
 * since two skew 3D lines rarely meet exactly). Returns `kind: 'intersection'`
 * (no `pointIndex`). Self-intersections within one polyline are included;
 * a segment is never intersected against itself.
 */
export function snapToIntersections(
  segments: Segments,
  query: Vec3,
  maxDistance: number,
): SnapResult | null {
  if (!(maxDistance > 0)) return null;

  // Flatten to a list of segments (with their endpoints) so any segment can be
  // tested against any other, across or within polylines.
  const segs: Array<readonly [Vec3, Vec3]> = [];
  for (const line of segments) {
    for (let i = 1; i < line.length; i++) {
      segs.push([line[i - 1], line[i]]);
    }
  }

  let best: SnapResult | null = null;
  for (let i = 0; i < segs.length; i++) {
    const a1 = segs[i][0];
    const a2 = segs[i][1];
    for (let j = i + 1; j < segs.length; j++) {
      const b1 = segs[j][0];
      const b2 = segs[j][1];
      const hit = segmentIntersectXY(a1, a2, b1, b2);
      if (hit === null) continue;
      const za = a1[2] + hit.t * (a2[2] - a1[2]);
      const zb = b1[2] + hit.u * (b2[2] - b1[2]);
      const z = (za + zb) / 2;
      const pos: Vec3 = [hit.x, hit.y, z];
      const d = distance(pos, query);
      if (d <= maxDistance && (best === null || d < best.distance)) {
        best = { kind: 'intersection', position: [pos[0], pos[1], pos[2]], distance: d };
      }
    }
  }
  return best;
}

// -- best-of -----------------------------------------------------------------

/**
 * On a near-tie, how much closer a geometry snap must be than a real point
 * snap to win. Within this margin we prefer the honest measured return.
 */
const POINT_PREFERENCE_MARGIN = 1e-6;

/**
 * Closest snap across all categories — real point, endpoint, midpoint, or
 * intersection — within `maxDistance`. On a near-tie (within
 * {@link POINT_PREFERENCE_MARGIN}), a real `'point'` snap is preferred, so the
 * caller lands on an actual measured return rather than a constructed feature
 * whenever they are effectively coincident. Returns `null` if nothing is in
 * range. Pure and deterministic.
 */
export function snapBest(
  index: PointSnapIndex,
  segments: Segments,
  query: Vec3,
  maxDistance: number,
): SnapResult | null {
  const candidates: Array<SnapResult | null> = [
    snapToNearestPoint(index, query, maxDistance),
    snapToVertices(segments, query, maxDistance),
    snapToMidpoints(segments, query, maxDistance),
    snapToIntersections(segments, query, maxDistance),
  ];

  let best: SnapResult | null = null;
  for (const c of candidates) {
    if (c === null) continue;
    if (best === null) {
      best = c;
      continue;
    }
    // Prefer a real point on a near-tie; otherwise strictly closer wins.
    if (c.distance < best.distance - POINT_PREFERENCE_MARGIN) {
      best = c;
    } else if (
      c.kind === 'point' &&
      best.kind !== 'point' &&
      c.distance <= best.distance + POINT_PREFERENCE_MARGIN
    ) {
      best = c;
    }
  }
  return best;
}
