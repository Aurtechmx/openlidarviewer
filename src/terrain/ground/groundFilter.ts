/**
 * groundFilter.ts
 *
 * Pure-data ground classification — the first leaf of the
 * confidence-aware DTM spine. Given a set of
 * scan-local points and a small parameter bundle, it separates
 * bare-earth ("ground") returns from above-ground returns (vegetation,
 * buildings, noise) and emits the provisional ground surface grid that
 * `rasterizeDtm` / `cellConfidence` build on.
 *
 * WHY a Simple Morphological Filter (SMRF), not CSF.
 *   CSF (cloth simulation) is the desktop standard, but its only mature
 *   implementation is C++ with no maintained WebAssembly build — porting
 *   it is a multi-week sink for a solo dev. SMRF (Pingel, Clarke &
 *   McBride 2013) is grid-native, deterministic, and expressible as a
 *   few hundred lines of pure TypeScript with no dependencies. It also
 *   matches the way the rest of `src/terrain/` already thinks: in
 *   regular grids.
 *
 * WHAT THIS IMPLEMENTS (and, per the no-overclaim rule, what it does
 * NOT). This is a faithful implementation of the SMRF *core*:
 *   1. Minimum-elevation grid — rasterise points to a regular grid,
 *      take the lowest return per cell (the bare-earth candidate).
 *   2. Empty-cell inpaint — nearest-finite flood fill so the
 *      morphological passes operate on a continuous surface (SMRF uses
 *      a spring-metaphor inpaint; nearest-finite is a deterministic,
 *      dependency-free stand-in that is honest about being simpler).
 *   3. Progressive morphological opening — open the surface with a flat
 *      square structuring element of growing radius; at each radius a
 *      cell is cut to the opened height when the drop exceeds a
 *      slope-scaled threshold `dh = elevationThresholdM + slope · b ·
 *      cellSizeM`. This is the heart shared by SMRF and Zhang's PMF.
 *   4. Point classification — a return is ground when it sits within a
 *      slope-scaled tolerance of the final opened surface beneath it.
 *
 *   It does NOT (yet) implement SMRF's net-cutting refinement pass or
 *   its image-processing-grade inpaint. Those are accuracy refinements,
 *   not correctness gaps; they belong in a later cycle and would be
 *   documented when they land. Until then the docstring tells the truth.
 *
 *   LOW-OUTLIER DESPIKE. A gross below-ground blunder (multipath, water
 *   returns, sensor noise) can seed a false low surface, and grayscale
 *   opening removes peaks, not pits, so it does not self-correct. The
 *   `floorPercentile` option addresses this: instead of the strict
 *   per-cell minimum it takes the elevation at a low percentile of the
 *   cell's returns, so a lone blunder is ignored once a cell has enough
 *   returns. It defaults to 0 (strict minimum) at this leaf for
 *   backward-compatible behaviour; the pipeline orchestrator enables a
 *   small floor by default.
 *
 * HONESTY CONTRACT. Like every terrain leaf, the result carries
 * coverage provenance (`coverage`, `sourcePointCount`,
 * `analyzedPointCount`) plus the ordered `warnings` that explain any
 * quality reduction. Classification quality silently determines contour
 * quality downstream, so the result exposes enough for the caller to
 * surface "how trustworthy is this ground?" rather than hiding it.
 *
 * Pure data: no DOM, no three.js, no I/O. Node-testable. The worker
 * layer (the worker integration) adapts typed-array positions into the
 * `TerrainPoint[]` this module consumes; performance tiering lives
 * there, not here — this leaf optimises for correctness and clarity.
 */

import type { TerrainPoint, TerrainCoverageMode } from '../TerrainContracts';

/** Which axis is the vertical (elevation) axis in the source frame. */
export type VerticalAxis = 'z' | 'y';

/** Tunable parameters for {@link classifyGroundSmrf}. */
export interface GroundFilterParams {
  /** Grid cell size, in source linear units. Must be > 0. */
  readonly cellSizeM: number;
  /**
   * Maximum morphological window radius, in cells. The filter opens the
   * surface with radii `1..maxWindowCells`. Larger removes larger
   * above-ground structures (buildings) at the cost of work. Must be
   * >= 1.
   */
  readonly maxWindowCells: number;
  /**
   * Expected maximum terrain slope as rise/run (e.g. 0.15 = 15 %). Sets
   * how aggressively the slope-scaled threshold grows with window size.
   * Must be >= 0.
   */
  readonly slope: number;
  /**
   * Base elevation tolerance, in source linear units. A return within
   * this height of the opened surface is ground even on flat terrain.
   * Must be >= 0.
   */
  readonly elevationThresholdM: number;
  /**
   * Optional additional tolerance scaled by the local ground-surface
   * slope (steeper ground => looser tolerance, since real ground varies
   * more there). Defaults to 0 (flat tolerance). In source linear units.
   */
  readonly scalingFactorM?: number;
  /**
   * Despike floor: instead of the strict per-cell minimum, take the
   * elevation at this low percentile (0..50) of the cell's returns. This
   * rejects gross below-ground blunders (multipath, water, sensor noise)
   * that would otherwise seed a false low ground surface. `0` (default)
   * keeps the strict minimum. A small value like 5 is a good despike
   * floor; it only changes cells with enough returns to have an outlier.
   */
  readonly floorPercentile?: number;
  /** Vertical axis of the source frame. Defaults to `'z'`. */
  readonly verticalAxis?: VerticalAxis;
}

/** Result of {@link classifyGroundSmrf}. */
export interface GroundFilterResult {
  /**
   * Per-point ground flag, parallel to the input array. `1` = ground,
   * `0` = above-ground / not-ground. Length === input length.
   */
  readonly isGround: Uint8Array;
  /**
   * Provisional bare-earth surface, row-major (`row * cols + col`).
   * Heights are in source linear units. Never NaN after inpaint, but a
   * cell that received no source point is flagged in {@link hadData}.
   */
  readonly groundSurface: Float32Array;
  /** `1` where the cell held at least one source point, else `0`. */
  readonly hadData: Uint8Array;
  /** Grid width in cells. */
  readonly cols: number;
  /** Grid height in cells. */
  readonly rows: number;
  /** Cell size used (echoes the param). */
  readonly cellSizeM: number;
  /** Horizontal origin (minimum of the first horizontal axis). */
  readonly originH1: number;
  /** Horizontal origin (minimum of the second horizontal axis). */
  readonly originH2: number;
  // ── honesty contract ──────────────────────────────────────────────
  readonly coverage: TerrainCoverageMode;
  readonly sourcePointCount: number;
  readonly analyzedPointCount: number;
  /** How many returns were classified as ground. */
  readonly groundPointCount: number;
  /** Ordered, human-readable caveats. */
  readonly warnings: string[];
}

/** Extract the (horizontal-1, horizontal-2, vertical) triplet for a point. */
function axes(
  p: TerrainPoint,
  vertical: VerticalAxis,
): readonly [number, number, number] {
  // Z-up (default): horizontals are x,y; vertical is z.
  // Y-up: horizontals are x,z; vertical is y.
  return vertical === 'y' ? [p.x, p.z, p.y] : [p.x, p.y, p.z];
}

/**
 * Classify ground vs above-ground returns with a Simple Morphological
 * Filter. Deterministic: identical input + params always yields an
 * identical result.
 *
 * Degenerate inputs are handled honestly rather than thrown:
 *   - empty input → empty result with a warning;
 *   - all points coincident / zero horizontal extent → single-cell grid;
 *   - non-finite params → clamped with a warning.
 */
export function classifyGroundSmrf(
  points: ReadonlyArray<TerrainPoint>,
  params: GroundFilterParams,
): GroundFilterResult {
  const warnings: string[] = [];
  const vertical: VerticalAxis = params.verticalAxis ?? 'z';

  const cellSizeM = finitePositive(params.cellSizeM, 1, 'cellSizeM', warnings);
  const maxWindowCells = Math.max(
    1,
    Math.floor(finitePositive(params.maxWindowCells, 1, 'maxWindowCells', warnings)),
  );
  const slope = finiteNonNeg(params.slope, 0.15, 'slope', warnings);
  const elevationThresholdM = finiteNonNeg(
    params.elevationThresholdM,
    0.5,
    'elevationThresholdM',
    warnings,
  );
  const scalingFactorM = finiteNonNeg(params.scalingFactorM ?? 0, 0, 'scalingFactorM', warnings);
  let floorPercentile = params.floorPercentile ?? 0;
  if (!Number.isFinite(floorPercentile) || floorPercentile < 0) floorPercentile = 0;
  if (floorPercentile > 50) floorPercentile = 50;

  const sourcePointCount = points.length;
  if (sourcePointCount === 0) {
    warnings.push('no points — nothing to classify');
    return emptyResult(cellSizeM, warnings);
  }

  // ── 1. bounds (finite points only) ────────────────────────────────
  let minH1 = Infinity;
  let minH2 = Infinity;
  let maxH1 = -Infinity;
  let maxH2 = -Infinity;
  let analyzed = 0;
  for (const p of points) {
    const [h1, h2, v] = axes(p, vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    analyzed++;
    if (h1 < minH1) minH1 = h1;
    if (h2 < minH2) minH2 = h2;
    if (h1 > maxH1) maxH1 = h1;
    if (h2 > maxH2) maxH2 = h2;
  }
  if (analyzed === 0) {
    warnings.push('all points non-finite — nothing to classify');
    return emptyResult(cellSizeM, warnings);
  }
  if (analyzed < sourcePointCount) {
    warnings.push(`${sourcePointCount - analyzed} non-finite points skipped`);
  }

  const cols = Math.max(1, Math.floor((maxH1 - minH1) / cellSizeM) + 1);
  const rows = Math.max(1, Math.floor((maxH2 - minH2) / cellSizeM) + 1);
  const nCells = cols * rows;

  const cellOf = (h1: number, h2: number): number => {
    let col = Math.floor((h1 - minH1) / cellSizeM);
    let row = Math.floor((h2 - minH2) / cellSizeM);
    if (col < 0) col = 0;
    else if (col >= cols) col = cols - 1;
    if (row < 0) row = 0;
    else if (row >= rows) row = rows - 1;
    return row * cols + col;
  };

  // ── 2. minimum-elevation grid (optionally despiked) ───────────────
  const minGrid = new Float32Array(nCells).fill(NaN);
  const hadData = new Uint8Array(nCells);
  if (floorPercentile <= 0) {
    // Fast path: strict per-cell minimum.
    for (const p of points) {
      const [h1, h2, v] = axes(p, vertical);
      if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
      const c = cellOf(h1, h2);
      if (hadData[c] === 0 || v < minGrid[c]) minGrid[c] = v;
      hadData[c] = 1;
    }
  } else {
    // Despike path: take the low-percentile return per cell so a single
    // gross below-ground blunder cannot seed the surface.
    const buckets = new Map<number, number[]>();
    for (const p of points) {
      const [h1, h2, v] = axes(p, vertical);
      if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
      const c = cellOf(h1, h2);
      const arr = buckets.get(c);
      if (arr) arr.push(v);
      else buckets.set(c, [v]);
      hadData[c] = 1;
    }
    const q = floorPercentile / 100;
    for (const [c, arr] of buckets) {
      arr.sort((a, b) => a - b);
      const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(q * arr.length) - 1));
      minGrid[c] = arr[idx];
    }
  }

  // ── 3. inpaint empty cells (nearest-finite flood fill) ────────────
  const surface = inpaintNearest(minGrid, hadData, cols, rows);

  // ── 4. progressive morphological opening ──────────────────────────
  // Work surface is mutated each window radius; a cell is cut down to
  // the opened height when the drop exceeds the slope-scaled threshold.
  let work = surface.slice();
  for (let b = 1; b <= maxWindowCells; b++) {
    const opened = morphOpen(work, cols, rows, b);
    const dh = elevationThresholdM + slope * b * cellSizeM;
    for (let i = 0; i < nCells; i++) {
      if (work[i] - opened[i] > dh) work[i] = opened[i];
    }
  }
  const groundSurface = work;

  // ── 5. classify points against the opened surface ─────────────────
  const slopeGrid = surfaceSlope(groundSurface, cols, rows, cellSizeM);
  const isGround = new Uint8Array(sourcePointCount);
  let groundPointCount = 0;
  for (let pi = 0; pi < sourcePointCount; pi++) {
    const [h1, h2, v] = axes(points[pi], vertical);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    const c = cellOf(h1, h2);
    const tol = elevationThresholdM + scalingFactorM * slopeGrid[c];
    // Ground when the return is at or below the opened surface within
    // tolerance. Returns well ABOVE the surface (buildings, canopy) are
    // not ground; returns slightly below (the surface itself) are.
    if (v - groundSurface[c] <= tol) {
      isGround[pi] = 1;
      groundPointCount++;
    }
  }

  return {
    isGround,
    groundSurface,
    hadData,
    cols,
    rows,
    cellSizeM,
    originH1: minH1,
    originH2: minH2,
    coverage: 'full' as TerrainCoverageMode,
    sourcePointCount,
    analyzedPointCount: analyzed,
    groundPointCount,
    warnings,
  };
}

// ── morphology helpers (exported for unit testing) ──────────────────

/**
 * Nearest-finite flood fill. Empty cells (`hadData[i] === 0`) receive
 * the value of the nearest cell that had data, by multi-source BFS over
 * 8-connectivity. Deterministic: BFS frontier is processed in index
 * order so ties resolve identically every run. If NO cell has data the
 * input is returned with zeros (caller already guarded against this).
 */
export function inpaintNearest(
  grid: Float32Array,
  hadData: Uint8Array,
  cols: number,
  rows: number,
): Float32Array {
  const n = cols * rows;
  const out = grid.slice();
  let frontier: number[] = [];
  const filled = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (hadData[i] === 1) {
      filled[i] = 1;
      frontier.push(i);
    }
  }
  if (frontier.length === 0) return out.fill(0);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      const col = i % cols;
      const row = (i - col) / cols;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
          const j = r * cols + c;
          if (filled[j] === 1) continue;
          filled[j] = 1;
          out[j] = out[i];
          next.push(j);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Morphological opening (erosion then dilation) with a flat square
 * structuring element of radius `b` cells. The square SE is separable,
 * so each pass is two 1-D windowed extrema. NaN values are ignored
 * (treated as absent) so the helper is safe on un-inpainted grids too.
 */
export function morphOpen(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
): Float32Array {
  const eroded = windowExtreme(grid, cols, rows, b, 'min');
  return windowExtreme(eroded, cols, rows, b, 'max');
}

/** Separable 1-D windowed min/max over a flat square radius-`b` window. */
function windowExtreme(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  mode: 'min' | 'max',
): Float32Array {
  const pick = mode === 'min' ? Math.min : Math.max;
  const horizontal = new Float32Array(grid.length);
  // pass 1 — horizontal
  for (let row = 0; row < rows; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      let acc = NaN;
      const lo = Math.max(0, col - b);
      const hi = Math.min(cols - 1, col + b);
      for (let c = lo; c <= hi; c++) {
        const val = grid[base + c];
        if (!Number.isFinite(val)) continue;
        acc = Number.isNaN(acc) ? val : pick(acc, val);
      }
      horizontal[base + col] = acc;
    }
  }
  // pass 2 — vertical
  const out = new Float32Array(grid.length);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      let acc = NaN;
      const lo = Math.max(0, row - b);
      const hi = Math.min(rows - 1, row + b);
      for (let r = lo; r <= hi; r++) {
        const val = horizontal[r * cols + col];
        if (!Number.isFinite(val)) continue;
        acc = Number.isNaN(acc) ? val : pick(acc, val);
      }
      out[row * cols + col] = acc;
    }
  }
  return out;
}

/**
 * Per-cell ground-surface slope as rise/run, from the maximum absolute
 * height difference to the 4-connected neighbours divided by the cell
 * size. Used only to widen the point-classification tolerance on steep
 * ground — not a reported metric.
 */
export function surfaceSlope(
  surface: Float32Array,
  cols: number,
  rows: number,
  cellSizeM: number,
): Float32Array {
  const out = new Float32Array(surface.length);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      const z = surface[i];
      let maxDiff = 0;
      if (col > 0) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i - 1]));
      if (col < cols - 1) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i + 1]));
      if (row > 0) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i - cols]));
      if (row < rows - 1) maxDiff = Math.max(maxDiff, Math.abs(z - surface[i + cols]));
      out[i] = cellSizeM > 0 ? maxDiff / cellSizeM : 0;
    }
  }
  return out;
}

// ── small guards ────────────────────────────────────────────────────

function emptyResult(cellSizeM: number, warnings: string[]): GroundFilterResult {
  return {
    isGround: new Uint8Array(0),
    groundSurface: new Float32Array(0),
    hadData: new Uint8Array(0),
    cols: 0,
    rows: 0,
    cellSizeM,
    originH1: 0,
    originH2: 0,
    coverage: 'full',
    sourcePointCount: 0,
    analyzedPointCount: 0,
    groundPointCount: 0,
    warnings,
  };
}

function finitePositive(v: number, fallback: number, name: string, warnings: string[]): number {
  if (Number.isFinite(v) && v > 0) return v;
  warnings.push(`${name} invalid (${v}); using ${fallback}`);
  return fallback;
}

function finiteNonNeg(v: number, fallback: number, name: string, warnings: string[]): number {
  if (Number.isFinite(v) && v >= 0) return v;
  warnings.push(`${name} invalid (${v}); using ${fallback}`);
  return fallback;
}
