/**
 * terrainScenes.ts — synthetic known-truth terrain fixtures.
 *
 * Pure point-cloud generators with ANALYTICALLY KNOWN geometry, for
 * truth-testing the terrain pipeline (DTM rasterisation, Horn slope /
 * aspect, hillshade, DSM / CHM). No DOM, no I/O, deterministic.
 *
 * Conventions shared by every generator (so the truth maths is exact):
 *   - Points sit on a regular grid: x = i*spacing, y = j*spacing, for
 *     i in [0, nx), j in [0, ny). Origin is (0, 0).
 *   - One point per grid node by default, so each rasteriser cell of the
 *     same `spacing` receives exactly one ground return at its own node.
 *   - z is the vertical axis ('z' frame — the pipeline default).
 *   - `gradient` is rise/run (dimensionless); the analytic slope angle is
 *     `atan(gradient)` and the analytic Horn slope value is `gradient`.
 *
 * Grid <-> raster alignment (matches rasterizeDtm / buildDsm):
 *   col = floor((x - originH1) / cell), row = floor((y - originH2) / cell).
 *   A node at x = i*cell, y = j*cell with origin 0 lands in cell
 *   (col=i, row=j); the cell CENTRE is at ((i+0.5)*cell, (j+0.5)*cell),
 *   so a node-sampled value is the surface evaluated at the node, NOT the
 *   cell centre. Truth assertions account for this half-cell offset.
 */

import type { TerrainPoint } from '../../src/terrain/TerrainContracts';

/** Common knobs: a square-ish extent sampled on a regular grid. */
export interface SceneExtent {
  /** Nodes along x. Default 32. */
  readonly nx?: number;
  /** Nodes along y. Default 32. */
  readonly ny?: number;
  /** Node spacing in source linear units. Default 1. */
  readonly spacing?: number;
}

const DEF_NX = 32;
const DEF_NY = 32;
const DEF_SPACING = 1;

function dims(e: SceneExtent = {}): { nx: number; ny: number; spacing: number } {
  return {
    nx: e.nx ?? DEF_NX,
    ny: e.ny ?? DEF_NY,
    spacing: e.spacing ?? DEF_SPACING,
  };
}

/** All-ones ground mask the length of `points` (every return is ground). */
export function allGround(points: ReadonlyArray<TerrainPoint>): Uint8Array {
  return new Uint8Array(points.length).fill(1);
}

/**
 * Flat plane at constant elevation `z0`.
 *
 * KNOWN TRUTH:
 *   - Every node has z = z0, so every covered DTM cell ~ z0 exactly.
 *   - Horn slope = 0 everywhere -> slope angle 0 deg, aspect undefined (0).
 *   - Hillshade is uniform = 255*cos(zenith) for the chosen sun altitude.
 */
export function flatPlane(z0: number, extent: SceneExtent = {}): TerrainPoint[] {
  const { nx, ny, spacing } = dims(extent);
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pts.push({ x: i * spacing, y: j * spacing, z: z0 });
    }
  }
  return pts;
}

export interface UniformSlopeParams extends SceneExtent {
  /** Rise/run. The analytic slope angle is atan(gradient). Default 0.5. */
  readonly gradient?: number;
  /** Which horizontal axis the surface tilts along. Default 'x'. */
  readonly axis?: 'x' | 'y';
  /** Base elevation at the origin node. Default 0. */
  readonly z0?: number;
}

/**
 * Uniform tilted plane:  z = z0 + gradient * h, where h is x (axis 'x')
 * or y (axis 'y'). Surface RISES with increasing h.
 *
 * KNOWN TRUTH (Horn, cell = spacing):
 *   - Horn slope value = gradient exactly (interior cells).
 *   - Slope angle = atan(gradient) in degrees.
 *   - Aspect = atan2(-dz/dy, -dz/dx) points DOWNHILL in the math frame
 *     (grids are NORTHING-UP: row+1 = north, so +y is north):
 *       axis 'x' (rises east): dz/dx>0, dz/dy=0 -> aspect = pi (180 deg, west).
 *       axis 'y' (rises NORTH, larger row): dz/dy>0 -> aspect = -pi/2
 *       (270 deg, downhill south).
 *     (Aspect convention verified against terrainDerivatives.hornSlopeAspect.)
 *   - DTM cell elevations match the analytic plane evaluated at each node.
 */
export function uniformSlope(params: UniformSlopeParams = {}): TerrainPoint[] {
  const { nx, ny, spacing } = dims(params);
  const gradient = params.gradient ?? 0.5;
  const axis = params.axis ?? 'x';
  const z0 = params.z0 ?? 0;
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * spacing;
      const y = j * spacing;
      const h = axis === 'x' ? x : y;
      pts.push({ x, y, z: z0 + gradient * h });
    }
  }
  return pts;
}

export interface GaussianHillParams extends SceneExtent {
  /** Peak height above the base. Default 8. */
  readonly amplitude?: number;
  /** Gaussian sigma in source units. Default a quarter of the extent. */
  readonly sigma?: number;
  /** Base elevation. Default 0. */
  readonly base?: number;
}

/**
 * Gaussian hill: z = base + amplitude * exp(-r^2 / (2*sigma^2)), r measured
 * from the extent centre.
 *
 * KNOWN TRUTH:
 *   - Global MAX is at the centre node (~ base + amplitude).
 *   - Elevation is radially symmetric and monotonically decreasing with r.
 *   - Aspect points radially OUTWARD (downhill) on every flank.
 */
export function gaussianHill(params: GaussianHillParams = {}): TerrainPoint[] {
  const { nx, ny, spacing } = dims(params);
  const amplitude = params.amplitude ?? 8;
  const base = params.base ?? 0;
  const cx = ((nx - 1) * spacing) / 2;
  const cy = ((ny - 1) * spacing) / 2;
  const sigma = params.sigma ?? Math.max(nx, ny) * spacing * 0.25;
  const twoS2 = 2 * sigma * sigma;
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * spacing;
      const y = j * spacing;
      const dx = x - cx;
      const dy = y - cy;
      pts.push({ x, y, z: base + amplitude * Math.exp(-(dx * dx + dy * dy) / twoS2) });
    }
  }
  return pts;
}

/**
 * Pit: an inverted Gaussian hill. z = base - depth*exp(-r^2/(2*sigma^2)).
 *
 * KNOWN TRUTH:
 *   - Global MIN is at the centre node (~ base - depth).
 *   - Aspect points radially INWARD (downhill toward the pit centre).
 */
export function pit(
  params: GaussianHillParams & { readonly depth?: number } = {},
): TerrainPoint[] {
  const depth = params.depth ?? params.amplitude ?? 8;
  return gaussianHill({ ...params, amplitude: -depth });
}

export interface RidgeValleyParams extends SceneExtent {
  /** Half-height of the crest / depth of the trough. Default 6. */
  readonly amplitude?: number;
  /** Sharpness: larger = narrower feature. Default 0.15 (per unit). */
  readonly sharpness?: number;
  /** Crest/trough runs along this axis. Default 'y' (a N-S line at mid-x). */
  readonly axis?: 'x' | 'y';
  /** Base elevation. Default 0. */
  readonly base?: number;
}

/**
 * Ridge: a 1-D MAX along a centre line. With axis 'y' the crest is the
 * column at mid-x; elevation falls off with |distance to that line|:
 *   z = base + amplitude * exp(-(sharpness*d)^2),  d = perpendicular dist.
 *
 * KNOWN TRUTH:
 *   - Max elevation lies ON the crest line (mid column for axis 'y').
 *   - Aspect FLIPS across the crest: cells west of the crest face west
 *     (downhill ~ aspect 180 deg), cells east face east (aspect ~ 0/360).
 */
export function ridge(params: RidgeValleyParams = {}): TerrainPoint[] {
  return ridgeOrValley(params, +1);
}

/**
 * Valley: a 1-D MIN along a centre line (inverted ridge).
 *
 * KNOWN TRUTH:
 *   - Min elevation lies ON the trough line.
 *   - Aspect flips across the trough (both flanks drain toward the centre).
 */
export function valley(params: RidgeValleyParams = {}): TerrainPoint[] {
  return ridgeOrValley(params, -1);
}

function ridgeOrValley(params: RidgeValleyParams, sign: 1 | -1): TerrainPoint[] {
  const { nx, ny, spacing } = dims(params);
  const amplitude = params.amplitude ?? 6;
  const sharpness = params.sharpness ?? 0.15;
  const axis = params.axis ?? 'y';
  const base = params.base ?? 0;
  // Centre line position (the value of the cross-axis at the crest/trough).
  const mid = axis === 'y' ? ((nx - 1) * spacing) / 2 : ((ny - 1) * spacing) / 2;
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i * spacing;
      const y = j * spacing;
      const d = axis === 'y' ? x - mid : y - mid;
      const profile = amplitude * Math.exp(-(sharpness * d) * (sharpness * d));
      pts.push({ x, y, z: base + sign * profile });
    }
  }
  return pts;
}

export interface TerraceParams extends SceneExtent {
  /** Vertical rise per step. Default 5. */
  readonly stepHeight?: number;
  /** Number of horizontal nodes per tread. Default 8. */
  readonly stepWidthNodes?: number;
  /** Axis the staircase climbs along. Default 'x'. */
  readonly axis?: 'x' | 'y';
  /** Base elevation of the lowest tread. Default 0. */
  readonly base?: number;
}

/**
 * Terrace: a discrete staircase. Treads are flat; each step jumps by
 * `stepHeight`. With axis 'x', step index = floor(col / stepWidthNodes).
 *
 * KNOWN TRUTH:
 *   - On a tread interior, slope ~ 0; the elevation equals
 *     base + step*stepHeight for that tread.
 *   - At a riser (tread boundary) slope spikes; max elevation is the top
 *     tread, min is the bottom tread.
 */
export function terrace(params: TerraceParams = {}): TerrainPoint[] {
  const { nx, ny, spacing } = dims(params);
  const stepHeight = params.stepHeight ?? 5;
  const stepWidthNodes = Math.max(1, Math.round(params.stepWidthNodes ?? 8));
  const axis = params.axis ?? 'x';
  const base = params.base ?? 0;
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = axis === 'x' ? i : j;
      const step = Math.floor(idx / stepWidthNodes);
      pts.push({ x: i * spacing, y: j * spacing, z: base + step * stepHeight });
    }
  }
  return pts;
}

/**
 * Sparse plane: a flat surface at `z0` sampled at only a fraction of the
 * nodes (deterministic decimation by `keepEvery`). Used to exercise
 * low-density cells and interpolation honesty.
 *
 * KNOWN TRUTH:
 *   - Sampled cells carry z ~ z0; unsampled cells must be interpolated or
 *     left as gaps — never fabricated to a different value.
 */
export function sparse(
  z0: number,
  keepEvery: number,
  extent: SceneExtent = {},
): TerrainPoint[] {
  const { nx, ny, spacing } = dims(extent);
  const step = Math.max(1, Math.round(keepEvery));
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i % step !== 0 || j % step !== 0) continue;
      pts.push({ x: i * spacing, y: j * spacing, z: z0 });
    }
  }
  return pts;
}

/**
 * Edge-clipped plane: a flat surface at `z0` with the right-hand fraction
 * of the extent (x >= keepFraction * width) carrying NO points — data is
 * missing on one side.
 *
 * KNOWN TRUTH:
 *   - The covered (left) region reads z ~ z0.
 *   - The clipped (right) region has no ground returns; it must stay
 *     no-data / low-confidence, not be extrapolated to a confident height.
 */
export function edgeClipped(
  z0: number,
  keepFraction = 0.5,
  extent: SceneExtent = {},
): TerrainPoint[] {
  const { nx, ny, spacing } = dims(extent);
  const keepCols = Math.max(1, Math.floor(nx * keepFraction));
  const pts: TerrainPoint[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < keepCols; i++) {
      pts.push({ x: i * spacing, y: j * spacing, z: z0 });
    }
  }
  return pts;
}

// -- DSM / CHM helpers -------------------------------------------------

/** ASPRS classification codes used by the DSM/CHM fixtures. */
export const ASPRS = {
  GROUND: 2,
  HIGH_VEGETATION: 5, // canopy
  BUILDING: 6,
} as const;

/** A point cloud plus an index-aligned ASPRS classification array. */
export interface ClassifiedScene {
  readonly points: TerrainPoint[];
  readonly classification: Uint8Array;
}

export interface OverlayParams extends SceneExtent {
  /** Bare-earth elevation of the ground plane. Default 100. */
  readonly groundZ?: number;
  /** Building block: node-index bounds [i0,i1)x[j0,j1) and roof height AGL. */
  readonly building?: {
    readonly i0: number;
    readonly i1: number;
    readonly j0: number;
    readonly j1: number;
    /** Height above ground of the flat roof. Default 10. */
    readonly heightM?: number;
  };
  /** Canopy patch: node-index bounds and tree-top height AGL. */
  readonly canopy?: {
    readonly i0: number;
    readonly i1: number;
    readonly j0: number;
    readonly j1: number;
    /** Height above ground of the canopy top. Default 6. */
    readonly heightM?: number;
  };
}

/**
 * Ground plane (class 2) with optional building (class 6) and canopy
 * (class 5) blocks placed ON TOP of it. Returns the merged point list and
 * an index-aligned classification array.
 *
 * Layout: every ground node first (so ground indices = j*nx + i), then
 * the non-ground returns appended. Non-ground points sit at the SAME x/y
 * as the ground nodes they cover, at elevation groundZ + heightM.
 *
 * KNOWN TRUTH (cell = spacing, grid = ground extent):
 *   - With classification excluding 5 & 6, the DTM ~ groundZ everywhere.
 *   - DSM (top surface, all points) ~ groundZ + heightM over the
 *     building / canopy footprints, ~ groundZ on bare ground.
 *   - CHM (= DSM - DTM) ~ heightM over the footprints, ~ 0 on bare ground.
 */
export function groundWithOverlay(params: OverlayParams = {}): ClassifiedScene {
  const { nx, ny, spacing } = dims(params);
  const groundZ = params.groundZ ?? 100;
  const points: TerrainPoint[] = [];
  const cls: number[] = [];

  // Ground plane — class 2, one return per node.
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      points.push({ x: i * spacing, y: j * spacing, z: groundZ });
      cls.push(ASPRS.GROUND);
    }
  }

  const addBlock = (
    b: NonNullable<OverlayParams['building']>,
    code: number,
    defaultH: number,
  ): void => {
    const h = b.heightM ?? defaultH;
    for (let j = b.j0; j < b.j1; j++) {
      for (let i = b.i0; i < b.i1; i++) {
        if (i < 0 || i >= nx || j < 0 || j >= ny) continue;
        points.push({ x: i * spacing, y: j * spacing, z: groundZ + h });
        cls.push(code);
      }
    }
  };

  if (params.building) addBlock(params.building, ASPRS.BUILDING, 10);
  if (params.canopy) addBlock(params.canopy, ASPRS.HIGH_VEGETATION, 6);

  return { points, classification: Uint8Array.from(cls) };
}

/** The grid spec that exactly tiles a node-sampled scene (cell = spacing). */
export function gridFor(extent: SceneExtent = {}): {
  originH1: number;
  originH2: number;
  cols: number;
  rows: number;
  cellSizeM: number;
} {
  const { nx, ny, spacing } = dims(extent);
  return { originH1: 0, originH2: 0, cols: nx, rows: ny, cellSizeM: spacing };
}
