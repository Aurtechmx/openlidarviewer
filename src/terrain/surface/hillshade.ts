/**
 * hillshade.ts
 *
 * Slope (degrees) and hillshade (shaded relief) rasters from an elevation
 * surface, using the Horn slope/aspect already used elsewhere. Hillshade is
 * the standard ESRI illumination model; aspect from `hornSlopeAspect`
 * (atan2(dz/dy, −dz/dx)) is exactly the convention that model expects.
 *
 * Pure data — no DOM. Deterministic. Assumes Z is in the same linear unit as
 * X/Y (true for metric projected data); `zFactor` lets a caller correct it.
 */

import { hornSlopeAspect, hornSlope } from '../ground/terrainDerivatives';

const DEG = Math.PI / 180;

/** Slope in DEGREES per cell (0 on flat / non-finite cells). */
export function computeSlopeDegrees(
  z: Float32Array,
  cols: number,
  rows: number,
  cellSizeM: number,
): Float32Array {
  const slope = hornSlope(z, cols, rows, cellSizeM);
  const out = new Float32Array(slope.length);
  for (let i = 0; i < slope.length; i++) out[i] = (Math.atan(slope[i]) * 180) / Math.PI;
  return out;
}

export interface HillshadeParams {
  /** Sun azimuth in degrees clockwise from north. Default 315 (NW). */
  readonly azimuthDeg?: number;
  /** Sun altitude above the horizon, degrees. Default 45. */
  readonly altitudeDeg?: number;
  /** Vertical exaggeration. Default 1. */
  readonly zFactor?: number;
}

export interface HillshadeResult {
  /** 0..255 grey value per cell; 0 for empty cells. */
  readonly shade: Uint8Array;
  /** 1 where the cell carries data, 0 where empty — lets a renderer tell a
   *  no-data cell apart from a deeply-shadowed one (both read as shade 0). */
  readonly coverage: Uint8Array;
  readonly cols: number;
  readonly rows: number;
}

/** Convert a north-clockwise sun azimuth (degrees) into the math frame (rad). */
function azimuthToMathRad(azimuthDeg: number): number {
  let azMath = (360 - azimuthDeg + 90) % 360;
  if (azMath < 0) azMath += 360;
  return azMath * DEG;
}

/**
 * Shade a raster directly from cached slope (tangent, dz/dl) and aspect grids —
 * the cheap half of a hillshade (no Horn pass). Lets the UI re-light a surface
 * at any sun angle interactively without recomputing derivatives.
 */
export function shadeFromSlopeAspect(
  slope: ArrayLike<number>,
  aspect: ArrayLike<number>,
  coverage: Uint8Array | ReadonlyArray<number>,
  cols: number,
  rows: number,
  params: HillshadeParams = {},
): HillshadeResult {
  const altitudeDeg = params.altitudeDeg ?? 45;
  const zFactor = params.zFactor ?? 1;
  const zenith = (90 - altitudeDeg) * DEG;
  const azimuth = azimuthToMathRad(params.azimuthDeg ?? 315);
  const cosZen = Math.cos(zenith);
  const sinZen = Math.sin(zenith);

  const n = cols * rows;
  const shade = new Uint8Array(n);
  const cov = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (coverage[i] === 0) continue;
    const sl = slope[i];
    const asp = aspect[i];
    if (!Number.isFinite(sl) || !Number.isFinite(asp)) continue;
    cov[i] = 1;
    const slopeRad = Math.atan(zFactor * sl);
    const hs =
      cosZen * Math.cos(slopeRad) +
      sinZen * Math.sin(slopeRad) * Math.cos(azimuth - asp);
    shade[i] = Math.max(0, Math.min(255, Math.round(255 * hs)));
  }
  return { shade, coverage: cov, cols, rows };
}

/** Compute a hillshade raster (ESRI illumination model). */
export function computeHillshade(
  z: Float32Array,
  cols: number,
  rows: number,
  cellSizeM: number,
  coverage: Uint8Array | ReadonlyArray<number>,
  params: HillshadeParams = {},
): HillshadeResult {
  const { slope, aspect } = hornSlopeAspect(z, cols, rows, cellSizeM);
  return shadeFromSlopeAspect(slope, aspect, coverage, cols, rows, params);
}

/**
 * Default light directions for multi-directional relief — four obliques at 90°
 * spacing (Mark 1992 / GDAL family). Combining them softens single-light harsh
 * shadows while keeping detail, the look of a cartographic shaded-relief sheet.
 */
export const MULTI_AZIMUTHS: readonly number[] = [225, 270, 315, 360];

/**
 * Multi-directional hillshade from cached slope/aspect. Each light's
 * contribution is weighted by how much the cell faces it (0.5 + 0.5·max(0,
 * alignment)), so slopes keep their modelling instead of washing out to a flat
 * mean. Returns the same shape as a single-direction hillshade.
 */
export function computeMultiHillshade(
  slope: ArrayLike<number>,
  aspect: ArrayLike<number>,
  coverage: Uint8Array | ReadonlyArray<number>,
  cols: number,
  rows: number,
  params: HillshadeParams = {},
): HillshadeResult {
  const altitudeDeg = params.altitudeDeg ?? 45;
  const zFactor = params.zFactor ?? 1;
  const zenith = (90 - altitudeDeg) * DEG;
  const cosZen = Math.cos(zenith);
  const sinZen = Math.sin(zenith);
  const azRad = MULTI_AZIMUTHS.map(azimuthToMathRad);

  const n = cols * rows;
  const shade = new Uint8Array(n);
  const cov = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (coverage[i] === 0) continue;
    const sl = slope[i];
    const asp = aspect[i];
    if (!Number.isFinite(sl) || !Number.isFinite(asp)) continue;
    cov[i] = 1;
    const slopeRad = Math.atan(zFactor * sl);
    const cs = Math.cos(slopeRad);
    const ss = Math.sin(slopeRad);
    let wsum = 0;
    let hsum = 0;
    for (let k = 0; k < azRad.length; k++) {
      const align = Math.cos(azRad[k] - asp); // -1..1
      const w = 0.5 + 0.5 * Math.max(0, align); // favour the lit side
      const hs = cosZen * cs + sinZen * ss * align;
      hsum += w * Math.max(0, hs);
      wsum += w;
    }
    const hsAvg = wsum > 0 ? hsum / wsum : 0;
    shade[i] = Math.max(0, Math.min(255, Math.round(255 * hsAvg)));
  }
  return { shade, coverage: cov, cols, rows };
}

/** Slope-band thresholds (degrees): flat < 5, moderate < 20, else steep. */
export interface SlopeStats {
  readonly coveredCells: number;
  readonly meanDeg: number;
  readonly maxDeg: number;
  readonly p95Deg: number;
  readonly bands: { readonly flat: number; readonly moderate: number; readonly steep: number };
}

export function slopeStats(
  slopeDeg: Float32Array,
  coverage: Uint8Array | ReadonlyArray<number>,
): SlopeStats {
  const vals: number[] = [];
  let sum = 0;
  let max = 0;
  const bands = { flat: 0, moderate: 0, steep: 0 };
  for (let i = 0; i < slopeDeg.length; i++) {
    if (coverage[i] === 0) continue;
    const s = slopeDeg[i];
    if (!Number.isFinite(s)) continue;
    vals.push(s);
    sum += s;
    if (s > max) max = s;
    if (s < 5) bands.flat++;
    else if (s < 20) bands.moderate++;
    else bands.steep++;
  }
  vals.sort((a, b) => a - b);
  const p95 = vals.length
    ? vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(0.95 * vals.length) - 1))]
    : Number.NaN;
  return {
    coveredCells: vals.length,
    meanDeg: vals.length ? sum / vals.length : Number.NaN,
    maxDeg: vals.length ? max : Number.NaN,
    p95Deg: p95,
    bands,
  };
}
