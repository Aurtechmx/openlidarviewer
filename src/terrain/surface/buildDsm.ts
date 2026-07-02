/**
 * buildDsm.ts
 *
 * Digital Surface Model — the top surface (highest return per cell) from ALL
 * points, as opposed to the bare-earth DTM (ground returns, lowest surface).
 * Built on the SAME grid as the DTM so the two align cell-for-cell, which lets
 * us derive the normalised DSM (nDSM) = DSM − DTM: the height of whatever sits
 * on the ground (canopy, buildings) above bare earth.
 *
 * Pure data — no DOM, no three.js. Deterministic.
 */

import type { TerrainPoint } from '../TerrainContracts';
import type { VerticalAxis } from '../ground/groundFilter';
import { axisGetters } from '../ground/axisGetters';
import { quantileSorted } from '../quantile';

/** A plain elevation surface raster (no confidence — that's the DTM's job). */
export interface SurfaceGrid {
  /** Surface elevation per cell (max return), NaN where the cell is empty. */
  readonly z: Float32Array;
  /** 1 where the cell has at least one return, 0 otherwise. */
  readonly coverage: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
}

export interface DsmGridSpec {
  readonly originH1: number;
  readonly originH2: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
}

export interface BuildDsmParams {
  readonly grid: DsmGridSpec;
  /** Vertical axis of the source frame. Default `'z'`. */
  readonly verticalAxis?: VerticalAxis;
}

/** Rasterise the highest return per cell from every point. */
export function buildDsm(points: ReadonlyArray<TerrainPoint>, params: BuildDsmParams): SurfaceGrid {
  const { originH1, originH2, cols, rows, cellSizeM } = params.grid;
  const vertical = params.verticalAxis ?? 'z';
  const { getH1, getH2, getV } = axisGetters(vertical);

  const n = cols * rows;
  const z = new Float32Array(n).fill(-Infinity);
  const coverage = new Uint8Array(n);
  const cell = cellSizeM > 0 ? cellSizeM : 1;

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const h1 = getH1(p);
    const h2 = getH2(p);
    const v = getV(p);
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    const c = Math.floor((h1 - originH1) / cell);
    const r = Math.floor((h2 - originH2) / cell);
    if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
    const idx = r * cols + c;
    if (v > z[idx]) z[idx] = v;
    coverage[idx] = 1;
  }

  for (let i = 0; i < n; i++) if (coverage[i] === 0) z[i] = Number.NaN;
  return { z, coverage, cols, rows, cellSizeM, originH1, originH2 };
}

/**
 * An all-empty surface on the given grid — used to skip the full-points DSM
 * pass when the DTM has no covered cells (nothing to model), while still
 * returning a well-formed grid for the downstream stats.
 */
export function emptySurfaceGrid(spec: DsmGridSpec): SurfaceGrid {
  const n = spec.cols * spec.rows;
  return {
    z: new Float32Array(n).fill(Number.NaN),
    coverage: new Uint8Array(n),
    cols: spec.cols,
    rows: spec.rows,
    cellSizeM: spec.cellSizeM,
    originH1: spec.originH1,
    originH2: spec.originH2,
  };
}

/** Basic min/max/mean over a surface's covered cells. */
export interface SurfaceStats {
  readonly coveredCells: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly meanZ: number;
}

export function surfaceStats(g: SurfaceGrid): SurfaceStats {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < g.z.length; i++) {
    if (g.coverage[i] === 0 || !Number.isFinite(g.z[i])) continue;
    const v = g.z[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  return {
    coveredCells: count,
    minZ: count ? min : Number.NaN,
    maxZ: count ? max : Number.NaN,
    meanZ: count ? sum / count : Number.NaN,
  };
}

/**
 * Normalised DSM (height above ground) = DSM − DTM, per cell where BOTH have a
 * height. Negative residuals (DSM below the bare-earth DTM — noise) clamp to 0.
 * Returns the per-cell heights (NaN where unavailable) + summary stats.
 */
export interface CanopyHeight {
  readonly heightM: Float32Array; // NaN where either surface is missing
  readonly coveredCells: number;
  readonly maxHeightM: number;
  readonly meanHeightM: number;
  readonly p95HeightM: number;
}

export function heightAboveGround(
  dsm: SurfaceGrid,
  dtmZ: Float32Array | ReadonlyArray<number>,
  dtmCoverage: Uint8Array | ReadonlyArray<number>,
): CanopyHeight {
  const n = dsm.z.length;
  const heightM = new Float32Array(n).fill(Number.NaN);
  const heights: number[] = [];
  let sum = 0;
  let max = 0;
  for (let i = 0; i < n; i++) {
    if (dsm.coverage[i] === 0 || dtmCoverage[i] === 0) continue;
    const a = dsm.z[i];
    const b = dtmZ[i] as number;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const h = Math.max(0, a - b);
    heightM[i] = h;
    heights.push(h);
    sum += h;
    if (h > max) max = h;
  }
  heights.sort((x, y) => x - y);
  // Project-wide type-7 quantile (was nearest-rank; see src/terrain/quantile.ts).
  const p95 = heights.length ? quantileSorted(heights, 0.95) : Number.NaN;
  return {
    heightM,
    coveredCells: heights.length,
    maxHeightM: heights.length ? max : Number.NaN,
    meanHeightM: heights.length ? sum / heights.length : Number.NaN,
    p95HeightM: p95,
  };
}
