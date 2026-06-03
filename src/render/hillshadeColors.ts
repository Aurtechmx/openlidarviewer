/**
 * hillshadeColors.ts
 *
 * Sun-direction surface shading. The cartographer's idiom — light a
 * terrain as if from a low directional sun, so the eye reads relief
 * directly. Pure-data, no three.js — composes with the existing
 * `colorForMode('elevation')` ramp by multiplying the elevation colour
 * with a per-point shading scalar derived from the local surface
 * normal estimate.
 *
 * Algorithm (the standard "Lambertian + grid normal" trick used by every
 * GIS tool with a hillshade option):
 *
 *   1. For each point, estimate a local surface normal by sampling
 *      nearby points and fitting a plane. Cheap variant: hash points
 *      into a 2D voxel grid, compute the average height gradient
 *      per cell, derive a normal from the gradient.
 *   2. Compute Lambert shading = max(0, dot(normal, sun_direction)).
 *   3. Modulate each point's elevation colour by `shading × strength +
 *      (1 − strength)` so the analyst can dial the effect between
 *      "pure colour" (strength = 0) and "pure shading" (strength = 1).
 *
 * The sun direction is given as `(azimuth, altitude)` in degrees — the
 * convention every cartographer learns. Default `azimuth = 315°` (NW)
 * and `altitude = 45°` matches the QGIS / ArcMap default.
 */

/** A sun position over the scene, in cartographic convention. */
export interface SunPosition {
  /** Azimuth in degrees, 0 = north, clockwise (90 = east). */
  azimuthDeg: number;
  /** Altitude (elevation angle above horizon) in degrees, 0..90. */
  altitudeDeg: number;
}

/** Default sun — NW direction, 45° above horizon (the QGIS / ArcMap baseline). */
export const DEFAULT_SUN: SunPosition = {
  azimuthDeg: 315,
  altitudeDeg: 45,
};

/** Inputs to `hillshadeShading`. */
export interface HillshadeInput {
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
  /** Sun direction. Defaults to `DEFAULT_SUN`. */
  sun?: SunPosition;
  /**
   * Horizontal cell size (m) used for the gradient estimate. Smaller
   * cells produce sharper relief but more noise; larger smooth the
   * shading. Defaults to a tuned 1 m which works for most LiDAR.
   */
  cellSize?: number;
  /**
   * Vertical exaggeration applied to the gradient before normalising.
   * Useful for low-relief terrain where the default 1.0 produces too-
   * flat shading. Defaults to 1.0.
   */
  zExaggeration?: number;
}

/**
 * Compute a per-point Lambertian shading scalar in [0, 1]. Multiply
 * each point's elevation colour by this value to bake hillshade into
 * the rendered output (or pass it as a strength uniform to a shader
 * that does the modulation per fragment). Pure: returns a new
 * `Float32Array` of length N.
 *
 * The Z-up world convention is hard-coded (the LiDAR convention; if a
 * caller has a different up axis they reproject before calling).
 */
export function hillshadeShading(input: HillshadeInput): Float32Array {
  const positions = input.positions;
  const n = positions.length / 3;
  const out = new Float32Array(n);
  if (n === 0) return out;
  const cellSize = Math.max(1e-3, input.cellSize ?? 1);
  const zEx = Math.max(0, input.zExaggeration ?? 1);
  const sun = input.sun ?? DEFAULT_SUN;

  // Sun direction vector — convert from (azimuth, altitude) to a unit
  // Cartesian vector in the Z-up world frame.
  //   azimuth 0° = +Y (north), grows clockwise → 90° = +X (east).
  //   altitude is angle above the horizon.
  const az = (sun.azimuthDeg * Math.PI) / 180;
  const al = (sun.altitudeDeg * Math.PI) / 180;
  const sx = Math.sin(az) * Math.cos(al);
  const sy = Math.cos(az) * Math.cos(al);
  const sz = Math.sin(al);

  // Build a 2D voxel grid keyed on (ix, iy) → mean height + point
  // count. Single linear pass.
  const cells = new Map<string, { sumZ: number; count: number }>();
  const keys: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    const k = ix + '|' + iy;
    keys[i] = k;
    const cell = cells.get(k);
    if (cell) {
      cell.sumZ += z;
      cell.count++;
    } else {
      cells.set(k, { sumZ: z, count: 1 });
    }
  }
  // Mean Z per cell.
  const meanZ = new Map<string, number>();
  for (const [k, v] of cells) meanZ.set(k, v.sumZ / v.count);

  // Per-cell gradient via 4-neighbour centred differences. Cache so we
  // don't recompute per point in the same cell.
  const shadingCache = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const cached = shadingCache.get(k);
    if (cached !== undefined) {
      out[i] = cached;
      continue;
    }
    const [ixStr, iyStr] = k.split('|');
    const ix = Number(ixStr);
    const iy = Number(iyStr);
    const z = meanZ.get(k) ?? 0;
    const zE = meanZ.get(ix + 1 + '|' + iy) ?? z;
    const zW = meanZ.get(ix - 1 + '|' + iy) ?? z;
    const zN = meanZ.get(ix + '|' + (iy + 1)) ?? z;
    const zS = meanZ.get(ix + '|' + (iy - 1)) ?? z;
    // ∂z/∂x ≈ (zE - zW) / (2 · cellSize), with vertical exaggeration.
    const dzdx = ((zE - zW) * zEx) / (2 * cellSize);
    const dzdy = ((zN - zS) * zEx) / (2 * cellSize);
    // Surface normal from the gradient: (-dz/dx, -dz/dy, 1), normalised.
    const nx = -dzdx;
    const ny = -dzdy;
    const nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const unx = nx / len;
    const uny = ny / len;
    const unz = nz / len;
    // Lambert shading: max(0, dot(normal, sun)).
    const dot = unx * sx + uny * sy + unz * sz;
    const shade = dot > 0 ? dot : 0;
    shadingCache.set(k, shade);
    out[i] = shade;
  }
  return out;
}

/**
 * Bake hillshade into an existing RGB colour buffer (3 bytes / point).
 * Mutates the buffer in place — the caller passes a typed-array copy
 * if they want to keep the un-shaded original. `strength` is the
 * fraction of the colour that comes from shading; 0 = no effect, 1 =
 * pure shading (greyscale relief).
 */
export function bakeHillshadeIntoRgb(
  rgb: Uint8Array,
  shading: Float32Array,
  strength: number,
): void {
  const n = shading.length;
  const s = Math.min(1, Math.max(0, strength));
  for (let i = 0; i < n; i++) {
    const factor = (1 - s) + s * shading[i];
    rgb[i * 3] = Math.min(255, Math.max(0, Math.round(rgb[i * 3] * factor)));
    rgb[i * 3 + 1] = Math.min(255, Math.max(0, Math.round(rgb[i * 3 + 1] * factor)));
    rgb[i * 3 + 2] = Math.min(255, Math.max(0, Math.round(rgb[i * 3 + 2] * factor)));
  }
}
