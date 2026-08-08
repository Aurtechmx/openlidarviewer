/**
 * spatialHash3d.ts — a uniform-grid spatial hash for radius neighbourhood
 * queries over a point cloud.
 *
 * Bins points into cubic cells of a chosen side length; a radius query then
 * visits only the 3×3×3 block of cells around the query point instead of the
 * whole cloud. Built once, queried many times — the neighbourhood primitive the
 * multi-scale geometry descriptors (and, later, registration) share. Pure and
 * deterministic: identical points in, identical bins out, no RNG. Worker-safe.
 */

export class SpatialHash3d {
  private readonly _inv: number;
  private readonly _bins = new Map<string, number[]>();
  private readonly _x: Float32Array | ReadonlyArray<number>;
  private readonly _y: Float32Array | ReadonlyArray<number>;
  private readonly _z: Float32Array | ReadonlyArray<number>;

  /**
   * @param positions Interleaved xyz (length 3N).
   * @param cellSize  Cube side length. Should be ≥ the largest query radius for
   *                  the 3×3×3 block to cover the full sphere; must be > 0.
   */
  constructor(positions: Float32Array | ReadonlyArray<number>, cellSize: number) {
    if (!(cellSize > 0)) throw new Error(`SpatialHash3d: cellSize must be > 0, got ${cellSize}`);
    this._inv = 1 / cellSize;
    // Store a positions view; index into it by point id.
    this._x = positions;
    this._y = positions;
    this._z = positions;
    const n = Math.floor(positions.length / 3);
    for (let i = 0; i < n; i++) {
      const key = this._key(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      const list = this._bins.get(key);
      if (list) list.push(i);
      else this._bins.set(key, [i]);
    }
  }

  private _key(x: number, y: number, z: number): string {
    return `${Math.floor(x * this._inv)}:${Math.floor(y * this._inv)}:${Math.floor(z * this._inv)}`;
  }

  /** Point ids within `radius` of (x,y,z), including any point exactly at it. */
  queryRadius(x: number, y: number, z: number, radius: number): number[] {
    const r2 = radius * radius;
    const cx = Math.floor(x * this._inv), cy = Math.floor(y * this._inv), cz = Math.floor(z * this._inv);
    // Cells the sphere can touch (ceil so a radius > cellSize still covers).
    const span = Math.max(1, Math.ceil(radius * this._inv));
    const out: number[] = [];
    for (let dx = -span; dx <= span; dx++) {
      for (let dy = -span; dy <= span; dy++) {
        for (let dz = -span; dz <= span; dz++) {
          const list = this._bins.get(`${cx + dx}:${cy + dy}:${cz + dz}`);
          if (!list) continue;
          for (const i of list) {
            const px = this._x[i * 3], py = this._y[i * 3 + 1], pz = this._z[i * 3 + 2];
            const ex = px - x, ey = py - y, ez = pz - z;
            if (ex * ex + ey * ey + ez * ez <= r2) out.push(i);
          }
        }
      }
    }
    return out;
  }

  /** Number of occupied cells — diagnostic. */
  get cellCount(): number {
    return this._bins.size;
  }
}
