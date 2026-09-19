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
} {
  const n = positions.length / 3;
  const plane = dominantPlane(positions);
  if (n === 0 || plane === null) return { cellSize: 1, referenceDensity: 1, axes: [0, 1] };
  const area = plane.extentA * plane.extentB;
  const referenceDensity = Math.max(1e-9, n / area);
  // Mean inter-point spacing ≈ sqrt(area / n); a cell a few spacings wide holds
  // enough points that its density is a stable estimate, not per-point noise.
  const meanSpacing = Math.sqrt(area / n);
  const cellSize = Math.max(1e-3, meanSpacing * 8);
  return { cellSize, referenceDensity, axes: plane.axes };
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

  // Linear bucket pass.
  const cells = new Map<string, number>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = positions[i * 3 + axisA];
    const b = positions[i * 3 + axisB];
    const ix = Math.floor(a / cellSize);
    const iy = Math.floor(b / cellSize);
    const k = ix + '|' + iy;
    keys[i] = k;
    cells.set(k, (cells.get(k) ?? 0) + 1);
  }

  // Per-point scale = clamp(maxScale × (refDensity / cellDensity)^0.5,
  // minScale, maxScale). The 0.5 exponent is the empirical sweet spot —
  // sharper than linear (which over-amplifies sparse regions) but
  // gentler than 1/√ratio.
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const cellD = (cells.get(k) ?? 1) / cellArea;
    const ratio = refDensity / cellD;
    let scale = Math.sqrt(ratio);
    if (scale < minScale) scale = minScale;
    if (scale > maxScale) scale = maxScale;
    out[i] = scale;
  }
  return out;
}
