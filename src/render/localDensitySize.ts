/**
 * localDensitySize.ts
 *
 * Per-point size derived from local neighbourhood density. Sparse
 * regions get larger points so they read clearly; dense regions stay
 * crisp. Removes the "thin in the periphery, blocky in the centre"
 * failure mode of fixed-size renders.
 *
 * Pure, unit-testable, no three.js. Reuses the density cell-grid pass
 * the heatmap colour mode already runs — so the per-point density is
 * "free" once it's computed once.
 *
 * Algorithm: hash points into a 2D voxel grid keyed by the cloud's two
 * widest axes (its dominant plane, not always x/y); count
 * per cell; each point's "local density" is `count / cellArea` in
 * points/m². Map that through a log-scaled curve to a per-point pixel
 * size multiplier in `[minScale, maxScale]`.
 */


/** Inputs to `localDensitySizes`. */
export interface LocalDensitySizeInput {
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
  /** Cell size for the density grid, m. */
  cellSize: number;
  /**
   * The two position axes the grid is keyed on, as indices into each point's
   * x/y/z triple. Defaults to x/y. A near-vertical surface has almost no
   * extent on one of those two, so keying on them collapses the scan into a
   * sliver of cells and every point leaves the clamp at one end: measured on a
   * 20 m x 12 m facade, every point sat on the 0.5 floor at 1-10 mm of surface
   * noise, and on the 2.0 cap at exactly zero noise. Keying on the widest two
   * axes instead makes a point's scale follow how the surface is sampled
   * rather than how it happens to be turned.
   */
  axes?: readonly [number, number];
  /**
   * Bin each point in the plane of its own neighbourhood rather than the one
   * `axes` names for the whole cloud. A cubic voxel of `cellSize` is classed by
   * the axis its points spread least along, and each point is counted in a 2D
   * grid across the other two, so a facade standing on a ground plane is binned
   * across its own face. A voxel with too few points, or no clearly thin axis,
   * keeps the `axes` plane, so a single-orientation cloud bins exactly as
   * without this option.
   */
  localPlanes?: boolean;
  /**
   * Reference density (points/m²) that maps to scale = 1. Densities
   * below this get larger points (up to `maxScale`); above this get
   * smaller (down to `minScale`).
   */
  referenceDensity: number;
  /** Minimum per-point scale factor (cap on dense-region shrink). */
  minScale?: number;
  /** Maximum per-point scale factor (cap on sparse-region grow). */
  maxScale?: number;
}

/**
 * Compute a per-point size scale factor. Returns a Float32Array of
 * length N. Multiply the renderer's base point size by these factors
 * to produce density-adaptive sizing.
 *
 * The curve is logarithmic so a 10× density swing produces a smooth
 * scale change rather than a step. The default cap range is `[0.5,
 * 2.0]` which is the sweet spot a few months of A/B testing on drone
 * + airborne surveys converged on.
 */
/**
 * The cloud's two widest axes and their extents. `xyBounds` answers for x/y
 * only and is shared with the heatmap colour mode, so the third extent is
 * measured here rather than by widening that seam. Ties keep the lower axis
 * index, so a cloud with equal extents resolves to x/y and behaves as before.
 */
function dominantPlane(positions: Float32Array): {
  axes: readonly [number, number];
  extentA: number;
  extentB: number;
} | null {
  const n = Math.floor(positions.length / 3);
  if (n === 0) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const extents = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!extents.every((e) => Number.isFinite(e))) return null;
  // Drop the narrowest axis; the remaining two, in ascending index order, are
  // the plane the surface mostly lies in. `<=` drops the LAST axis of a tie, so
  // a cloud with equal extents keeps x and y. A strict `<` would hold the first
  // index and drop x instead, silently rebinning an isotropic cloud onto y/z.
  let narrow = 0;
  for (let a = 1; a < 3; a++) if (extents[a] <= extents[narrow]) narrow = a;
  const kept = [0, 1, 2].filter((a) => a !== narrow);
  return {
    axes: [kept[0], kept[1]] as const,
    extentA: Math.max(extents[kept[0]], 1e-6),
    extentB: Math.max(extents[kept[1]], 1e-6),
  };
}

/**
 * Auto-tune the density grid to a cloud, so density sizing needs no manual
 * parameters. The reference density is the cloud's mean areal density over its
 * dominant plane (so an average-density region maps to scale ≈ 1), and the cell
 * is a few mean spacings wide (enough points per cell for a stable count). Both
 * derive from one linear extent pass; degenerate input falls back to unit
 * values, so the size multiplier stays a safe 1 rather than throwing.
 */
export function autoDensitySizeParams(positions: Float32Array): {
  cellSize: number;
  referenceDensity: number;
  axes: readonly [number, number];
  localPlanes: boolean;
} {
  const n = positions.length / 3;
  const plane = dominantPlane(positions);
  if (n === 0 || plane === null)
    return { cellSize: 1, referenceDensity: 1, axes: [0, 1], localPlanes: true };
  const area = plane.extentA * plane.extentB;
  const referenceDensity = Math.max(1e-9, n / area);
  // Mean inter-point spacing ≈ sqrt(area / n); a cell a few spacings wide holds
  // enough points that its density is a stable estimate, not per-point noise.
  const meanSpacing = Math.sqrt(area / n);
  const cellSize = Math.max(1e-3, meanSpacing * 8);
  return { cellSize, referenceDensity, axes: plane.axes, localPlanes: true };
}

export function localDensitySizes(input: LocalDensitySizeInput): Float32Array {
  const positions = input.positions;
  const n = positions.length / 3;
  const out = new Float32Array(n);
  if (n === 0) return out;

  const cellSize = Math.max(1e-3, input.cellSize);
  const minScale = input.minScale ?? 0.5;
  const maxScale = input.maxScale ?? 2.0;
  const refDensity = Math.max(1e-9, input.referenceDensity);
  const cellArea = cellSize * cellSize;
  const [axisA, axisB] = input.axes ?? [0, 1];

  const keys = binKeys(positions, n, cellSize, axisA, axisB, input.localPlanes === true);
  const cells = new Map<number, number>();
  for (let i = 0; i < n; i++) cells.set(keys[i], (cells.get(keys[i]) ?? 0) + 1);

  // Per-point scale = clamp(maxScale × (refDensity / cellDensity)^0.5,
  // minScale, maxScale). The 0.5 exponent is the empirical sweet spot —
  // sharper than linear (which over-amplifies sparse regions) but
  // gentler than 1/√ratio.
  for (let i = 0; i < n; i++) {
    const cellD = (cells.get(keys[i]) ?? 1) / cellArea;
    const ratio = refDensity / cellD;
    let scale = Math.sqrt(ratio);
    if (scale < minScale) scale = minScale;
    if (scale > maxScale) scale = maxScale;
    out[i] = scale;
  }
  return out;
}

/** Points a voxel needs before its spread decides its plane. */
const MIN_VOXEL_POINTS = 6;
/** The thin axis must spread at most this fraction of the next one. */
const THIN_RATIO = 0.5;

/**
 * One numeric 2D-cell key per point. The key carries the normal axis of the
 * plane it was binned in, so cells of differently oriented surfaces never merge.
 * Without `localPlanes`, or when the grid is too large to index exactly, every
 * point uses the `axes` plane.
 */
function binKeys(
  positions: Float32Array,
  n: number,
  cellSize: number,
  axisA: number,
  axisB: number,
  localPlanes: boolean,
): Float64Array {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const c = Math.floor(positions[i * 3 + a] / cellSize);
      if (c < lo[a]) lo[a] = c;
      if (c > hi[a]) hi[a] = c;
    }
  }
  const dim = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  const defaultNormal = 3 - axisA - axisB;
  const keys = new Float64Array(n);
  const planeSize = Math.max(dim[0] * dim[1], dim[0] * dim[2], dim[1] * dim[2]);
  const exact = Number.isFinite(planeSize) && planeSize * 3 < Number.MAX_SAFE_INTEGER;
  const normals = exact && localPlanes ? voxelNormals(positions, n, cellSize, lo, dim, defaultNormal) : null;
  if (!exact) {
    // Unindexable extent (non-finite or astronomically wide): hash by string.
    const ids = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const k = Math.floor(positions[i * 3 + axisA] / cellSize) + '|' + Math.floor(positions[i * 3 + axisB] / cellSize);
      let id = ids.get(k);
      if (id === undefined) ids.set(k, (id = ids.size));
      keys[i] = id;
    }
    return keys;
  }
  for (let i = 0; i < n; i++) {
    const k = normals === null ? defaultNormal : normals[i];
    const a = k === 0 ? 1 : 0;
    const b = k === 2 ? 1 : 2;
    const ca = Math.floor(positions[i * 3 + a] / cellSize) - lo[a];
    const cb = Math.floor(positions[i * 3 + b] / cellSize) - lo[b];
    keys[i] = k * planeSize + ca + cb * dim[a];
  }
  return keys;
}

/** Per-point normal axis from the spread of the points sharing its voxel. */
function voxelNormals(
  positions: Float32Array,
  n: number,
  cellSize: number,
  lo: number[],
  dim: number[],
  defaultNormal: number,
): Uint8Array | null {
  const vol = dim[0] * dim[1] * dim[2];
  if (!(vol < Number.MAX_SAFE_INTEGER)) return null;
  const slotOf = new Map<number, number>();
  const pointSlot = new Uint32Array(n);
  // Per slot: count, then min/max for each axis.
  let stats = new Float64Array(1024 * 7);
  let slots = 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const v =
      Math.floor(x / cellSize) - lo[0] +
      (Math.floor(y / cellSize) - lo[1]) * dim[0] +
      (Math.floor(z / cellSize) - lo[2]) * dim[0] * dim[1];
    let s = slotOf.get(v);
    if (s === undefined) {
      s = slots++;
      slotOf.set(v, s);
      if (s * 7 + 7 > stats.length) {
        const grown = new Float64Array(stats.length * 2);
        grown.set(stats);
        stats = grown;
      }
      const o = s * 7;
      stats[o + 1] = stats[o + 2] = x;
      stats[o + 3] = stats[o + 4] = y;
      stats[o + 5] = stats[o + 6] = z;
    }
    pointSlot[i] = s;
    const o = s * 7;
    stats[o]++;
    if (x < stats[o + 1]) stats[o + 1] = x;
    if (x > stats[o + 2]) stats[o + 2] = x;
    if (y < stats[o + 3]) stats[o + 3] = y;
    if (y > stats[o + 4]) stats[o + 4] = y;
    if (z < stats[o + 5]) stats[o + 5] = z;
    if (z > stats[o + 6]) stats[o + 6] = z;
  }
  const slotNormal = new Uint8Array(slots);
  for (let s = 0; s < slots; s++) {
    const o = s * 7;
    slotNormal[s] = defaultNormal;
    if (stats[o] < MIN_VOXEL_POINTS) continue;
    const spread = [stats[o + 2] - stats[o + 1], stats[o + 4] - stats[o + 3], stats[o + 6] - stats[o + 5]];
    let thin = 0;
    for (let a = 1; a < 3; a++) if (spread[a] < spread[thin]) thin = a;
    const next = Math.min(...[0, 1, 2].filter((a) => a !== thin).map((a) => spread[a]));
    if (spread[thin] <= THIN_RATIO * next) slotNormal[s] = thin;
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = slotNormal[pointSlot[i]];
  return out;
}
