/**
 * relief.ts: shaded relief for the export sheets. Pure and DOM-free.
 *
 * `shadeLight` is the single-light Lambertian hillshade that
 * simulation/flowPulse/flowHillshade.ts draws for the Flow Pulse map, written
 * for any elevation grid. `multiLightHillshade` blends four lights, weighted
 * towards a north-west key, so slopes facing away from the key light still
 * show form. `reliefRgba` turns a shade grid and an elevation grid into the
 * RGBA raster a sheet embeds, using a style's tokens.
 *
 * Grids are row-major with row 0 the southern row, as the terrain grids are.
 */
import type { SheetTokens } from './tokens';
import { tintAt } from './tokens';

export interface ReliefGrid {
  readonly cols: number;
  readonly rows: number;
  /** Elevation per cell. */
  readonly z: ArrayLike<number>;
  /** Non-zero (or true) where `z` holds ground. Omitted means every finite `z` is ground. */
  readonly valid?: ArrayLike<number | boolean>;
  /** Cell size along columns and rows, in the same unit as `z`. */
  readonly cellX: number;
  readonly cellY: number;
}

export interface ReliefLight {
  /** Compass azimuth of the light, degrees clockwise from grid north. */
  readonly azimuthDeg: number;
  /** Altitude above the horizon, degrees. */
  readonly altitudeDeg: number;
  readonly weight: number;
}

/** North-west key light with three fill lights, as in the approved sheet design. */
export const MULTI_LIGHT: readonly ReliefLight[] = [
  { azimuthDeg: 315, altitudeDeg: 45, weight: 0.45 },
  { azimuthDeg: 270, altitudeDeg: 50, weight: 0.2 },
  { azimuthDeg: 360, altitudeDeg: 50, weight: 0.2 },
  { azimuthDeg: 225, altitudeDeg: 60, weight: 0.15 },
];

function isValid(g: ReliefGrid, i: number): boolean {
  const z = g.z[i]!;
  if (!Number.isFinite(z)) return false;
  return g.valid ? Boolean(g.valid[i]) : true;
}

/**
 * Slope and aspect per valid cell (Horn's central differences, the same
 * stencil flowHillshade uses). A neighbour outside the grid or without ground
 * falls back to the centre cell's elevation. `exaggeration` scales the
 * vertical before the slope is taken.
 */
function slopeAspect(g: ReliefGrid, exaggeration: number): { slope: Float64Array; aspect: Float64Array; ok: Uint8Array } {
  const { cols, rows } = g;
  const n = cols * rows;
  const slope = new Float64Array(n);
  const aspect = new Float64Array(n);
  const ok = new Uint8Array(n);
  const at = (c: number, r: number, fallback: number): number => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return fallback;
    const i = r * cols + c;
    return isValid(g, i) ? g.z[i]! : fallback;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!isValid(g, i)) continue;
      ok[i] = 1;
      const z0 = g.z[i]!;
      const dzdx = (exaggeration * (at(c + 1, r, z0) - at(c - 1, r, z0))) / (2 * g.cellX);
      // Horn's dz/dy runs north to south; rows here run south to north.
      const dzdy = (exaggeration * (at(c, r - 1, z0) - at(c, r + 1, z0))) / (2 * g.cellY);
      slope[i] = Math.atan(Math.hypot(dzdx, dzdy));
      aspect[i] = Math.atan2(dzdy, -dzdx);
    }
  }
  return { slope, aspect, ok };
}

function shadeFrom(sa: { slope: Float64Array; aspect: Float64Array; ok: Uint8Array }, light: ReliefLight, out: Float64Array, weight: number): void {
  const zen = ((90 - light.altitudeDeg) * Math.PI) / 180;
  // Compass azimuth to the math convention the aspect formula uses (360 - az + 90).
  const az = (((360 - light.azimuthDeg + 90) % 360) * Math.PI) / 180;
  const cz = Math.cos(zen), sz = Math.sin(zen);
  for (let i = 0; i < out.length; i++) {
    if (!sa.ok[i]) continue;
    const s = sa.slope[i]!;
    const v = cz * Math.cos(s) + sz * Math.sin(s) * Math.cos(az - sa.aspect[i]!);
    out[i]! += weight * Math.min(1, Math.max(0, v));
  }
}

function finish(sum: Float64Array, ok: Uint8Array, total: number): Float32Array {
  const out = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) out[i] = ok[i] ? sum[i]! / total : Number.NaN;
  return out;
}

/** Single-light hillshade in [0, 1]; NaN where the grid has no ground. */
export function shadeLight(g: ReliefGrid, light: Omit<ReliefLight, 'weight'>, exaggeration = 1): Float32Array {
  const sa = slopeAspect(g, exaggeration);
  const sum = new Float64Array(g.cols * g.rows);
  shadeFrom(sa, { ...light, weight: 1 }, sum, 1);
  return finish(sum, sa.ok, 1);
}

/**
 * Weighted blend of several lights in [0, 1]; NaN where the grid has no
 * ground. Weights are normalised, so they need not sum to 1.
 */
export function multiLightHillshade(g: ReliefGrid, lights: readonly ReliefLight[] = MULTI_LIGHT, exaggeration = 1): Float32Array {
  const total = lights.reduce((a, l) => a + Math.max(0, l.weight), 0);
  if (!(total > 0)) throw new Error('multiLightHillshade needs at least one light with a positive weight.');
  const sa = slopeAspect(g, exaggeration);
  const sum = new Float64Array(g.cols * g.rows);
  for (const l of lights) if (l.weight > 0) shadeFrom(sa, l, sum, l.weight);
  return finish(sum, sa.ok, total);
}

/**
 * The vertical exaggeration that makes relief readable at sheet scale: flat
 * sites need more. Chosen from the elevation range against the grid's
 * horizontal extent, clamped to [1, 8].
 */
export function reliefExaggeration(g: ReliefGrid): number {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < g.cols * g.rows; i++) {
    if (!isValid(g, i)) continue;
    const z = g.z[i]!;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  const extent = Math.max(g.cols * g.cellX, g.rows * g.cellY);
  if (!(hi > lo) || !(extent > 0)) return 1;
  // A relief of 10 % of the extent or more needs no help; 0.5 % gets the cap.
  const ratio = (hi - lo) / extent;
  return Math.min(8, Math.max(1, 0.1 / ratio));
}

export interface ReliefRaster {
  readonly width: number;
  readonly height: number;
  /** RGBA, row 0 at the TOP (north), ready for a PNG encoder. Cells without ground are transparent. */
  readonly rgba: Uint8Array;
}

/**
 * RGBA relief for a sheet: grey shade mapped into the style's
 * [shadeLo, shadeHi], then the elevation tint laid over it at the style's
 * tint alpha. `zRange` fixes the tint's elevation span; it defaults to the
 * grid's own range.
 */
export function reliefRgba(
  g: ReliefGrid,
  shade: ArrayLike<number>,
  tokens: SheetTokens,
  zRange?: readonly [number, number],
): ReliefRaster {
  const { cols, rows } = g;
  let lo = zRange?.[0] ?? Infinity, hi = zRange?.[1] ?? -Infinity;
  if (!zRange) {
    for (let i = 0; i < cols * rows; i++) {
      if (!isValid(g, i)) continue;
      const z = g.z[i]!;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  const span = hi > lo ? hi - lo : 1;
  const rgba = new Uint8Array(cols * rows * 4);
  const a = tokens.tintAlpha;
  const k = tokens.shadeHi - tokens.shadeLo;
  for (let r = 0; r < rows; r++) {
    const outRow = rows - 1 - r;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const s = shade[i]!;
      if (!isValid(g, i) || !Number.isFinite(s)) continue;
      const grey = tokens.shadeLo + k * Math.min(1, Math.max(0, s));
      const tint = a > 0 ? tintAt(tokens, (g.z[i]! - lo) / span) : null;
      const o = (outRow * cols + c) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = tint ? grey * (1 - a) + tint[ch]! * a : grey;
        rgba[o + ch] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      }
      rgba[o + 3] = 255;
    }
  }
  return { width: cols, height: rows, rgba };
}

/**
 * Block-average a grid down so its longer side is at most `maxSide` cells.
 * Cells without ground do not contribute; a block with no ground stays
 * without ground. Returns the input unchanged when it already fits.
 */
export function downsampleGrid(g: ReliefGrid, maxSide: number): ReliefGrid {
  const f = Math.ceil(Math.max(g.cols, g.rows) / Math.max(1, Math.floor(maxSide)));
  if (f <= 1) return g;
  const cols = Math.ceil(g.cols / f), rows = Math.ceil(g.rows / f);
  const z = new Float64Array(cols * rows);
  const valid = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      for (let rr = r * f; rr < Math.min(g.rows, (r + 1) * f); rr++) {
        for (let cc = c * f; cc < Math.min(g.cols, (c + 1) * f); cc++) {
          const i = rr * g.cols + cc;
          if (!isValid(g, i)) continue;
          sum += g.z[i]!;
          n++;
        }
      }
      const o = r * cols + c;
      if (n > 0) { z[o] = sum / n; valid[o] = 1; } else z[o] = Number.NaN;
    }
  }
  return { cols, rows, z, valid, cellX: g.cellX * f, cellY: g.cellY * f };
}
