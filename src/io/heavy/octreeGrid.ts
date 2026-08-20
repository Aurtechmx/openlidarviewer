/**
 * octreeGrid.ts — the fixed-depth octree the out-of-core indexer buckets into.
 *
 * An out-of-core build cannot hold the points in memory, so it decides the node
 * structure up front from the bounds and the point count, then streams every
 * point into the leaf that already owns its cell. This module is that decision:
 * a cubic root cube that contains the data, a depth chosen so a leaf holds about
 * the target number of points, and a pure mapping between a point and the
 * octant-path key of its leaf.
 *
 * A key is a string of octant digits `0`-`7`, one per level, so its length is
 * the depth and it doubles as an OPFS-safe file name (`''` is the root). The two
 * invariants the indexer relies on: a point always falls inside the cube of the
 * key it is given, and two points in the same cell get the same key. Fixed depth
 * keeps the geometry a closed form with no per-point tree mutation; adapting the
 * depth to local density is a later refinement the indexer can layer on top.
 *
 * Pure geometry — no I/O, unit-tested in Node.
 */

/** An axis-aligned cube: a per-axis minimum and a single edge length. */
export interface Cube {
  readonly min: readonly [number, number, number];
  readonly size: number;
}

export interface OctreeGrid {
  readonly root: Cube;
  /** Levels below the root; a leaf key is this many octant digits long. */
  readonly depth: number;
  /** Cells per axis at leaf depth: `2 ** depth`. */
  readonly cellsPerAxis: number;
  /** The octant-path key of the leaf containing `(x, y, z)`. */
  leafKeyFor(x: number, y: number, z: number): string;
  /** The cube of a node key; `''` is the root. */
  cubeFor(key: string): Cube;
}

/**
 * The deepest tree the grid will build regardless of point count. At depth 16 a
 * leaf edge is 1/65536 of the root, finer than any real scan needs, and it caps
 * `2 ** depth` well inside exact integer range.
 */
export const DEFAULT_MAX_DEPTH = 16;

/** `ceil(log8(ratio))`, i.e. the octree depth whose `8 ** depth` leaves cover `ratio`. */
function depthForRatio(ratio: number): number {
  if (ratio <= 1) return 0;
  return Math.ceil(Math.log2(ratio) / 3);
}

/**
 * Build a grid whose cubic root contains `[min, max]` and whose depth splits the
 * cloud into leaves of about `pointsPerLeaf` points each, never deeper than
 * `maxDepth`. A zero-extent or degenerate cloud collapses to a unit root at
 * depth 0 rather than dividing by zero.
 */
export function octreeGridFor(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  pointCount: number,
  pointsPerLeaf: number,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): OctreeGrid {
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const size = Number.isFinite(extent) && extent > 0 ? extent : 1;
  const ratio = pointsPerLeaf > 0 ? pointCount / pointsPerLeaf : 0;
  const depth = Math.max(0, Math.min(Math.floor(maxDepth), depthForRatio(ratio)));
  return octreeGridOf({ min: [min[0], min[1], min[2]], size }, depth);
}

/**
 * Build a grid from an explicit root cube and depth, no point count involved.
 * The reader uses this to rebuild the exact grid a manifest records, so a stored
 * store maps points to the same leaves the build did.
 */
export function octreeGridOf(root: Cube, depth: number): OctreeGrid {
  const rootMin: [number, number, number] = [root.min[0], root.min[1], root.min[2]];
  const size = root.size;
  const d = Math.max(0, Math.floor(depth));
  const cellsPerAxis = 2 ** d;

  function axisIndex(value: number, axis: number): number {
    const t = (value - rootMin[axis]) / size;
    const cell = Math.floor(t * cellsPerAxis);
    return Math.min(cellsPerAxis - 1, Math.max(0, cell));
  }

  function leafKeyFor(x: number, y: number, z: number): string {
    if (d === 0) return '';
    const ix = axisIndex(x, 0);
    const iy = axisIndex(y, 1);
    const iz = axisIndex(z, 2);
    let key = '';
    for (let level = d - 1; level >= 0; level--) {
      const digit = ((ix >> level) & 1) | (((iy >> level) & 1) << 1) | (((iz >> level) & 1) << 2);
      key += String(digit);
    }
    return key;
  }

  function cubeFor(key: string): Cube {
    let cx = rootMin[0];
    let cy = rootMin[1];
    let cz = rootMin[2];
    let s = size;
    for (const ch of key) {
      const digit = ch.charCodeAt(0) - 48; // '0'..'7'
      s /= 2;
      if (digit & 1) cx += s;
      if (digit & 2) cy += s;
      if (digit & 4) cz += s;
    }
    return { min: [cx, cy, cz], size: s };
  }

  return { root: { min: rootMin, size }, depth: d, cellsPerAxis, leafKeyFor, cubeFor };
}
