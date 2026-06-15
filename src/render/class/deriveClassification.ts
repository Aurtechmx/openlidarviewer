/**
 * deriveClassification.ts
 *
 * Unsupervised, geometry-only point classification for clouds that carry NO
 * classification channel (raw XYZ, photogrammetry, unclassified LAS). It
 * derives a coarse, ASPRS-aligned class per point so an unclassified scan can
 * still be coloured, filtered and reasoned about by ground / vegetation /
 * building.
 *
 * It is a HEURISTIC, not authoritative classification. The result is always
 * tagged `derived: true` and must be presented as such — it is not a
 * substitute for a producer's survey-grade classification, and the honest
 * expectation is ~85–95% overall agreement on moderate terrain, with known
 * failure modes (steep/discontinuous terrain, dense canopy with few ground
 * hits, low buildings/embankments, bridges, vegetation-vs-wall confusion).
 *
 * Method (pure, deterministic, single spatial grid — no kd-tree, no iteration
 * beyond the few morphological scales), grounded in the cited literature:
 *
 *   1. Grid-minimum surface over the XY footprint.
 *   2. Progressive morphological opening (SMRF / PMF, Zhang 2003; Chen 2017
 *      review §3.2) with a slope-scaled elevation threshold → bare-earth grid.
 *      Morphology is the best accuracy/efficiency trade-off for a browser
 *      (low memory, high throughput, robust on steep terrain — Chen 2017
 *      Table 1) versus CSF (iterative solve) or TIN densification (costly
 *      reconstruction).
 *   3. Bilinear interpolation of the bare-earth grid → DTM (Bartels 2006
 *      nDSM = DSM − DTM; bilinear is the cheap deterministic choice).
 *   4. Height-above-ground (HAG) per point = Z − DTM(x, y).
 *   5. Per-cell roughness (SD of above-ground HAG) separates smooth planar
 *      roofs/structures from volumetric vegetation (Amolins 2008: SD of
 *      elevation < ~1.5 m → smooth roof/ground; > ~6 m → high vegetation).
 *   6. Rule classification → ASPRS codes (2 ground; 3/4/5 veg bands; 6
 *      building; 1 unclassified).
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic — same input, same
 * output, so it runs identically in a Web Worker, in Node tests, and on the
 * main thread.
 */

/** ASPRS codes this heuristic can emit. */
export const DERIVED_GROUND = 2;
export const DERIVED_LOW_VEG = 3;
export const DERIVED_MED_VEG = 4;
export const DERIVED_HIGH_VEG = 5;
export const DERIVED_BUILDING = 6;
export const DERIVED_UNCLASSIFIED = 1;

/** Tunable parameters; every field has a literature-anchored default. */
export interface DeriveClassificationOptions {
  /**
   * Ground grid cell size, in the cloud's linear units. When omitted it is
   * derived from the point spacing (~2.5× spacing, clamped) so the grid stays
   * bounded. Papers grid at ~1 m (Casella 2001, Maguya 2014, Aljumaily 2023).
   */
  readonly cellSizeM?: number;
  /**
   * Largest building / object the ground filter should carve out, in linear
   * units. Sets the maximum morphological window. Casella 2001 found ~20 m
   * optimal for urban; raise for large structures.
   */
  readonly maxObjectSizeM?: number;
  /** Initial elevation threshold, dh0 (units). PMF default ~0.3 m. */
  readonly elevThresholdM?: number;
  /** Terrain slope tolerance (rise/run) scaling the window threshold. ~0.15. */
  readonly slope?: number;
  /** HAG below this is ground (units). ~0.5 m. */
  readonly groundBandM?: number;
  /** HAG below this (and above ground band) is low vegetation. ~2 m. */
  readonly lowVegBandM?: number;
  /** HAG below this is medium vegetation; above is high vegetation. ~5 m. */
  readonly medVegBandM?: number;
  /**
   * Per-cell roughness (SD of above-ground HAG) at/below which a tall cell is
   * treated as a smooth planar structure (building) rather than vegetation.
   * Amolins 2008: SD < ~1.5 m reads as a roof. Default 1.5.
   */
  readonly buildingRoughnessMaxM?: number;
  /**
   * Minimum HAG for a smooth cell to be called a building (units). ~2.5 m, so
   * smooth low mounds aren't promoted to structures.
   */
  readonly buildingMinHagM?: number;
  /** Hard cap on either grid dimension; cellSize grows to respect it. */
  readonly maxGridDim?: number;
}

/** Per-class counts plus the run's honest provenance. */
export interface DeriveClassificationResult {
  /** Derived ASPRS code per point (length === count). */
  readonly codes: Uint8Array;
  /** Count of points assigned to each emitted code. */
  readonly counts: Readonly<Record<number, number>>;
  /** Cell size actually used (after the maxGridDim clamp). */
  readonly cellSizeM: number;
  /** Grid dimensions used. */
  readonly gridWidth: number;
  readonly gridHeight: number;
  /** Always true — a flag callers must surface so it reads as derived. */
  readonly derived: true;
  /** One-line honest provenance string for the legend / report. */
  readonly provenance: string;
}

const DEFAULTS = {
  maxObjectSizeM: 20,
  elevThresholdM: 0.3,
  slope: 0.15,
  groundBandM: 0.5,
  lowVegBandM: 2,
  medVegBandM: 5,
  buildingRoughnessMaxM: 1.5,
  buildingMinHagM: 2.5,
  maxGridDim: 768,
} as const;

/** A finite-only min/max scan over the XY footprint and Z. */
interface Bounds {
  minX: number; minY: number; maxX: number; maxY: number;
  minZ: number; maxZ: number; finite: number;
}

function computeBounds(positions: Float32Array, count: number): Bounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity, finite = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    finite++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, minY, maxX, maxY, minZ, maxZ, finite };
}

/** Pick a cell size from point spacing, then clamp so the grid fits maxGridDim. */
function chooseCellSize(b: Bounds, count: number, opt: DeriveClassificationOptions): number {
  const w = Math.max(0, b.maxX - b.minX);
  const h = Math.max(0, b.maxY - b.minY);
  const area = w * h;
  const maxDim = opt.maxGridDim ?? DEFAULTS.maxGridDim;
  let cell = opt.cellSizeM;
  if (cell === undefined || !Number.isFinite(cell) || cell <= 0) {
    const spacing = area > 0 && count > 0 ? Math.sqrt(area / count) : 1;
    cell = Math.min(5, Math.max(0.5, spacing * 2.5));
  }
  // Grow the cell until both grid dimensions fit the cap.
  const fits = (c: number): boolean =>
    Math.ceil(w / c) + 1 <= maxDim && Math.ceil(h / c) + 1 <= maxDim;
  while (!fits(cell)) cell *= 1.5;
  return cell;
}

/** Separable square min filter (erosion) of `radius` cells, NaN-aware. */
function erode(src: Float32Array, W: number, H: number, radius: number): Float32Array {
  const tmp = new Float32Array(W * H);
  // Horizontal pass.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = Infinity;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const v = src[y * W + xx];
        if (Number.isFinite(v) && v < m) m = v;
      }
      tmp[y * W + x] = m;
    }
  }
  // Vertical pass.
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const v = tmp[yy * W + x];
        if (Number.isFinite(v) && v < m) m = v;
      }
      out[y * W + x] = m;
    }
  }
  return out;
}

/** Separable square max filter (dilation) of `radius` cells, NaN-aware. */
function dilate(src: Float32Array, W: number, H: number, radius: number): Float32Array {
  const tmp = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = -Infinity;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= W) continue;
        const v = src[y * W + xx];
        if (Number.isFinite(v) && v > m) m = v;
      }
      tmp[y * W + x] = m;
    }
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = -Infinity;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        const v = tmp[yy * W + x];
        if (Number.isFinite(v) && v > m) m = v;
      }
      out[y * W + x] = Number.isFinite(m) ? m : src[y * W + x];
    }
  }
  return out;
}

/** Fill NaN cells (empty footprint cells) with the nearest finite value by a
 *  cheap two-pass forward/backward sweep, so interpolation has no holes. */
function fillHoles(grid: Float32Array, W: number, H: number): void {
  // Forward sweep.
  let last = NaN;
  for (let i = 0; i < grid.length; i++) {
    if (Number.isFinite(grid[i])) last = grid[i];
    else if (Number.isFinite(last)) grid[i] = last;
  }
  // Backward sweep for the leading holes.
  last = NaN;
  for (let i = grid.length - 1; i >= 0; i--) {
    if (Number.isFinite(grid[i])) last = grid[i];
    else if (Number.isFinite(last)) grid[i] = last;
  }
  void W; void H;
}

/**
 * Derive a coarse ASPRS classification for an unclassified cloud. Returns the
 * per-point codes plus honest provenance. Deterministic.
 */
export function deriveClassification(
  positions: Float32Array,
  count: number,
  options: DeriveClassificationOptions = {},
): DeriveClassificationResult {
  const o = { ...DEFAULTS, ...options };
  const b = computeBounds(positions, count);

  const emptyResult = (reason: string): DeriveClassificationResult => ({
    codes: new Uint8Array(count).fill(DERIVED_UNCLASSIFIED),
    counts: { [DERIVED_UNCLASSIFIED]: count },
    cellSizeM: NaN,
    gridWidth: 0,
    gridHeight: 0,
    derived: true,
    provenance: `Derived classification not computed (${reason}).`,
  });

  if (count <= 0 || b.finite < 3 || !(b.maxX > b.minX) || !(b.maxY > b.minY)) {
    return emptyResult('insufficient or degenerate geometry');
  }

  const cell = chooseCellSize(b, count, options);
  const W = Math.max(1, Math.ceil((b.maxX - b.minX) / cell) + 1);
  const H = Math.max(1, Math.ceil((b.maxY - b.minY) / cell) + 1);

  const cellOf = (x: number, y: number): number => {
    let cx = Math.floor((x - b.minX) / cell);
    let cy = Math.floor((y - b.minY) / cell);
    if (cx < 0) cx = 0; else if (cx >= W) cx = W - 1;
    if (cy < 0) cy = 0; else if (cy >= H) cy = H - 1;
    return cy * W + cx;
  };

  // 1. Grid-minimum surface.
  const gridMin = new Float32Array(W * H).fill(NaN);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const c = cellOf(x, y);
    const cur = gridMin[c];
    if (!Number.isFinite(cur) || z < cur) gridMin[c] = z;
  }
  fillHoles(gridMin, W, H);

  // 2. Progressive morphological opening → bare-earth grid. Geometric window
  //    ladder 1,2,4,… up to maxObjectSize; the threshold grows with the window
  //    so larger structures need a larger drop to be carved out (slope-scaled).
  const maxRadiusCells = Math.max(1, Math.round(o.maxObjectSizeM / cell));
  const ground = gridMin.slice();
  for (let r = 1; r <= maxRadiusCells; r *= 2) {
    const opened = dilate(erode(ground, W, H, r), W, H, r);
    const dhT = o.elevThresholdM + o.slope * (r * cell);
    for (let i = 0; i < ground.length; i++) {
      // Carve down to the opened surface where the raw stands proud by > dhT
      // (a building/tree the window can now see past) — this is the PMF object
      // test, applied to the grid so the surface converges to bare earth.
      if (Number.isFinite(ground[i]) && Number.isFinite(opened[i]) &&
          ground[i] - opened[i] > dhT) {
        ground[i] = opened[i];
      }
    }
  }

  // 3 + 4. Bilinear DTM sample + per-point HAG.
  const dtmAt = (x: number, y: number): number => {
    const gx = (x - b.minX) / cell;
    const gy = (y - b.minY) / cell;
    let x0 = Math.floor(gx), y0 = Math.floor(gy);
    if (x0 < 0) x0 = 0; if (x0 > W - 2) x0 = Math.max(0, W - 2);
    if (y0 < 0) y0 = 0; if (y0 > H - 2) y0 = Math.max(0, H - 2);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = Math.min(1, Math.max(0, gx - x0));
    const fy = Math.min(1, Math.max(0, gy - y0));
    const v00 = ground[y0 * W + x0], v10 = ground[y0 * W + x1];
    const v01 = ground[y1 * W + x0], v11 = ground[y1 * W + x1];
    const a = v00 + (v10 - v00) * fx;
    const c2 = v01 + (v11 - v01) * fx;
    return a + (c2 - a) * fy;
  };

  const hag = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      hag[i] = NaN; continue;
    }
    const h = z - dtmAt(x, y);
    hag[i] = Number.isFinite(h) ? Math.max(0, h) : NaN;
  }

  // 5. Per-cell roughness of ABOVE-GROUND HAG (Welford mean/variance) — the
  //    cheap geometry cue that separates smooth roofs from rough canopy.
  const cnt = new Float32Array(W * H);
  const mean = new Float32Array(W * H);
  const m2 = new Float32Array(W * H);
  for (let i = 0; i < count; i++) {
    const h = hag[i];
    if (!Number.isFinite(h) || h <= o.groundBandM) continue;
    const x = positions[i * 3], y = positions[i * 3 + 1];
    const c = cellOf(x, y);
    const n = cnt[c] + 1; cnt[c] = n;
    const delta = h - mean[c];
    mean[c] += delta / n;
    m2[c] += delta * (h - mean[c]);
  }
  // Roughness is judged over the 3×3 cell NEIGHBOURHOOD, not a single cell:
  // at ~1 point per cell a lone roof cell can't be told from a stray return,
  // but a roof is locally smooth across several cells, so pooling the
  // neighbourhood's above-ground HAG gives a stable SD. The per-cell Welford
  // accumulators (cnt/mean/m2) are combined with Chan's parallel-variance
  // formula. A neighbourhood needs a minimum pooled count before it can be
  // called a planar structure.
  const MIN_PLANAR_POINTS = 6;
  const neighbourhoodIsPlanar = (cx: number, cy: number): boolean => {
    let accN = 0, accMean = 0, accM2 = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= W) continue;
        const c = yy * W + xx;
        const nB = cnt[c];
        if (nB === 0) continue;
        const delta = mean[c] - accMean;
        const nTot = accN + nB;
        accMean += (delta * nB) / nTot;
        accM2 += m2[c] + (delta * delta * accN * nB) / nTot;
        accN = nTot;
      }
    }
    if (accN < MIN_PLANAR_POINTS) return false;
    return Math.sqrt(accM2 / (accN - 1)) <= o.buildingRoughnessMaxM;
  };

  // 6. Rule classification.
  const codes = new Uint8Array(count);
  const counts: Record<number, number> = {};
  const bump = (code: number): void => { counts[code] = (counts[code] ?? 0) + 1; };
  for (let i = 0; i < count; i++) {
    const h = hag[i];
    let code: number;
    if (!Number.isFinite(h)) {
      code = DERIVED_UNCLASSIFIED;
    } else if (h <= o.groundBandM) {
      code = DERIVED_GROUND;
    } else {
      const x = positions[i * 3], y = positions[i * 3 + 1];
      let cx = Math.floor((x - b.minX) / cell); if (cx < 0) cx = 0; else if (cx >= W) cx = W - 1;
      let cy = Math.floor((y - b.minY) / cell); if (cy < 0) cy = 0; else if (cy >= H) cy = H - 1;
      const planar = neighbourhoodIsPlanar(cx, cy);
      if (planar && h >= o.buildingMinHagM) {
        code = DERIVED_BUILDING;
      } else if (h < o.lowVegBandM) {
        code = DERIVED_LOW_VEG;
      } else if (h < o.medVegBandM) {
        code = DERIVED_MED_VEG;
      } else {
        code = DERIVED_HIGH_VEG;
      }
    }
    codes[i] = code;
    bump(code);
  }

  return {
    codes,
    counts,
    cellSizeM: cell,
    gridWidth: W,
    gridHeight: H,
    derived: true,
    provenance:
      `Derived (heuristic) classification — progressive morphological ground ` +
      `filter + height-above-ground at ${cell.toFixed(2)} m grid. Not a ` +
      `survey-grade or producer classification; validate before relying on it.`,
  };
}
