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
// Tiny pure constant — the unit-aware cell floor must agree with the
// metres-per-degree scale the rest of the terrain pipeline uses.
import { METRES_PER_DEGREE } from '../ground/horizontalScale';
import type { DtmGrid } from '../ground/cellConfidence';
import type { TerrainPoint } from '../TerrainContracts';
import { compareDtms, type CompareDtmsOptions, type EpochComparison } from './compareDtms';

/** One epoch: its render-local xyz positions (z up) and declared CRS / datum. */
export interface EpochCloud {
  /** Interleaved x/y/z, length 3N, in render-local space (z is vertical). */
  readonly positions: Float32Array;
  /**
   * The cloud's world-space origin shift (positions are local = world − origin).
   * REQUIRED for a correct comparison: two clouds are recentered by their own
   * origins, so they are only comparable once both are returned to a common
   * world frame. Defaults to [0,0,0] for an already-world input.
   */
  readonly origin?: readonly [number, number, number];
  readonly crs?: string | null;
  readonly verticalDatum?: string | null;
  /**
   * True when the horizontal frame is geographic (degrees). The shared grid
   * lives in world SOURCE-CRS units, so the ~0.25 m cell floor must be
   * expressed in those units — a raw 0.25 on a degree grid is ≈ 28 km cells
   * (the same unit-blind floor the analysis runner had). Also threads into
   * the surface build so the confidence roughness slope reads degree cells
   * as metres-per-degree, not metres. Default false (projected).
   */
  readonly isGeographic?: boolean | null;
  /** Metres per source horizontal unit (~0.3048 for feet). Default 1. */
  readonly linearUnitToMetres?: number | null;
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

const ZERO: readonly [number, number, number] = [0, 0, 0];

/** Box an interleaved xyz buffer into WORLD-frame `TerrainPoint[]` (local + origin). */
function boxPoints(positions: Float32Array, origin: readonly [number, number, number]): TerrainPoint[] {
  const n = (positions.length / 3) | 0;
  const ox = origin[0];
  const oy = origin[1];
  const oz = origin[2];
  const points: TerrainPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    points[i] = { x: positions[i * 3] + ox, y: positions[i * 3 + 1] + oy, z: positions[i * 3 + 2] + oz };
  }
  return points;
}

/** World-frame (x,y) bounds of an xyz buffer (local + origin), or null when empty. */
function boundsXY(
  positions: Float32Array,
  origin: readonly [number, number, number],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const ox = origin[0];
  const oy = origin[1];
  const n = (positions.length / 3) | 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3] + ox;
    const y = positions[i * 3 + 1] + oy;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return minX <= maxX && minY <= maxY ? { minX, minY, maxX, maxY } : null;
}

/**
 * A shared grid spanning both clouds in a COMMON WORLD frame. Each cloud is
 * recentred by its own origin, so the two are returned to world coordinates
 * (local + origin) before the grid is computed — gridding raw local coordinates
 * would difference mismatched locations. ~256 cells across the larger span.
 */
function sharedGrid(before: EpochCloud, after: EpochCloud): SharedGrid | null {
  const a = boundsXY(before.positions, before.origin ?? ZERO);
  const b = boundsXY(after.positions, after.origin ?? ZERO);
  if (!a || !b) return null;
  const minX = Math.min(a.minX, b.minX);
  const minY = Math.min(a.minY, b.minY);
  const maxX = Math.max(a.maxX, b.maxX);
  const maxY = Math.max(a.maxY, b.maxY);
  // The ~0.25 m cell floor expressed in SOURCE units (the grid's units) —
  // the same unit-aware rule as the analysis runner's deriveCoreParams. The
  // BEFORE epoch's units are the reference, matching compareDtms (an
  // inter-epoch unit mismatch is flagged by the comparison itself).
  const metresPerUnit = before.isGeographic
    ? METRES_PER_DEGREE
    : before.linearUnitToMetres && before.linearUnitToMetres > 0
      ? before.linearUnitToMetres
      : 1;
  const extent = Math.max(maxX - minX, maxY - minY, 1 / metresPerUnit);
  const cellSizeM = Math.max(0.25 / metresPerUnit, extent / 256);
  return {
    originH1: minX,
    originH2: minY,
    cols: Math.max(1, Math.floor((maxX - minX) / cellSizeM) + 1),
    rows: Math.max(1, Math.floor((maxY - minY) / cellSizeM) + 1),
    cellSizeM,
  };
}

/** Build one cloud's DTM on the shared world grid, matching the live analysis surface. */
function dtmOnGrid(cloud: EpochCloud, grid: SharedGrid): DtmGrid {
  const points = boxPoints(cloud.positions, cloud.origin ?? ZERO);
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
    // Degree cells must read as metres-per-degree in the confidence
    // roughness slope. No explicit latitudeDeg: this grid lives in the
    // WORLD frame (points are local + origin), so cellConfidence's
    // grid-origin latitude fallback is genuinely the world latitude here.
    isGeographic: cloud.isGeographic ?? false,
    horizontalUnitToMetres:
      cloud.linearUnitToMetres && cloud.linearUnitToMetres > 0
        ? cloud.linearUnitToMetres
        : 1,
  }).dtm;
}

/** Rasterise both epochs onto one shared grid, or null when either is empty. */
export function buildSharedEpochDtms(before: EpochCloud, after: EpochCloud): EpochDtms | null {
  const grid = sharedGrid(before, after);
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
export function compareEpochClouds(
  before: EpochCloud,
  after: EpochCloud,
  options: CompareDtmsOptions = {},
): EpochComparison | null {
  const dtms = buildSharedEpochDtms(before, after);
  if (!dtms) return null;
  // The clouds know their frame; the DtmGrids can't carry it. Either epoch
  // declaring degrees makes the shared grid degree-denominated, so cut/fill
  // volumes must be refused (see CompareDtmsOptions.isGeographic). An
  // explicit caller option still wins.
  return compareDtms(dtms.before, dtms.after, {
    ...options,
    isGeographic:
      options.isGeographic ?? (before.isGeographic === true || after.isGeographic === true),
  });
}
