/**
 * compareEpochs.ts
 *
 * Produce two co-registered DTMs from two point clouds and compare them. The
 * pure terrain leaves (`classifyGroundSmrf` → `rasterizeDtm` → surface build)
 * are composed onto ONE shared grid — a common origin, cell size, and
 * dimensions spanning both clouds — so the difference is cell-for-cell
 * meaningful rather than a measurement of two different rasters. The honest
 * co-registration verdict (CRS / datum / origin) rides through `compareDtms`.
 *
 * Pure data: no DOM, no three.js, no I/O — so the whole two-epoch path is
 * unit-testable. The caller gathers each cloud's positions; the heatmap/wipe
 * visualisation of the result is a separate, browser-verified layer.
 *
 * Cost note: this boxes positions into points and runs two ground filters; it
 * is an on-demand action, not a per-frame path.
 */

import { classifyGroundSmrf } from '../ground/groundFilter';
import { rasterizeDtm } from '../ground/rasterizeDtm';
import { buildSurfaceFromRaster } from '../ground/surfaceFromRaster';
import type { DtmGrid } from '../ground/cellConfidence';
import type { TerrainPoint } from '../TerrainContracts';
import { compareDtms, type EpochComparison } from './compareDtms';

/** One epoch: its render-local xyz positions (z up) and declared CRS / datum. */
export interface EpochCloud {
  /** Interleaved x/y/z, length 3N, in render-local space (z is vertical). */
  readonly positions: Float32Array;
  readonly crs?: string | null;
  readonly verticalDatum?: string | null;
}

/** The shared grid spec both epochs are rasterised onto. */
interface SharedGrid {
  readonly originH1: number;
  readonly originH2: number;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
}

/** The two co-registered DTMs plus the grid they share. */
export interface EpochDtms {
  readonly before: DtmGrid;
  readonly after: DtmGrid;
  readonly cellSizeM: number;
  readonly cols: number;
  readonly rows: number;
}

/** Box an interleaved xyz buffer into the `TerrainPoint[]` the leaves consume. */
function boxPoints(positions: Float32Array): TerrainPoint[] {
  const n = (positions.length / 3) | 0;
  const points: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
  }
  return points;
}

/** Horizontal (x,y) bounds of an xyz buffer, or null when it has no finite points. */
function boundsXY(
  positions: Float32Array,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const n = (positions.length / 3) | 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

/** A shared grid spanning both clouds (~256 cells across the larger span). */
function sharedGrid(before: Float32Array, after: Float32Array): SharedGrid | null {
  const a = boundsXY(before);
  const b = boundsXY(after);
  if (!a || !b) return null;
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const cellSizeM = Math.max(0.25, extent / 256);
  return {
    originH1: minX,
    originH2: minY,
    cols: Math.max(1, Math.floor((maxX - minX) / cellSizeM) + 1),
    rows: Math.max(1, Math.floor((maxY - minY) / cellSizeM) + 1),
    cellSizeM,
  };
}

/** Build one cloud's DTM on the shared grid, matching the live analysis surface. */
function dtmOnGrid(cloud: EpochCloud, grid: SharedGrid): DtmGrid {
  const points = boxPoints(cloud.positions);
  const gf = classifyGroundSmrf(points, {
    cellSizeM: grid.cellSizeM,
    maxWindowCells: 8,
    slope: 0.2,
    elevationThresholdM: 0.5,
    floorPercentile: 5,
    verticalAxis: 'z',
  });
  const raster = rasterizeDtm(points, gf.isGround, {
    grid,
    aggregation: 'median',
    verticalAxis: 'z',
  });
  return buildSurfaceFromRaster(raster, {
    crs: cloud.crs ?? null,
    verticalDatum: cloud.verticalDatum ?? null,
  }).dtm;
}

/** Rasterise both epochs onto one shared grid, or null when either is empty. */
export function buildSharedEpochDtms(before: EpochCloud, after: EpochCloud): EpochDtms | null {
  const grid = sharedGrid(before.positions, after.positions);
  if (!grid) return null;
  return {
    before: dtmOnGrid(before, grid),
    after: dtmOnGrid(after, grid),
    cellSizeM: grid.cellSizeM,
    cols: grid.cols,
    rows: grid.rows,
  };
}

/**
 * Compare two epochs end-to-end: build co-registered DTMs on a shared grid,
 * then diff them. Returns null only when a cloud has no finite points.
 */
export function compareEpochClouds(before: EpochCloud, after: EpochCloud): EpochComparison | null {
  const dtms = buildSharedEpochDtms(before, after);
  if (!dtms) return null;
  return compareDtms(dtms.before, dtms.after);
}
