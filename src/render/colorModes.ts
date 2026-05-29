/**
 * colorModes.ts
 *
 * Pure functions that derive a flat Uint8Array of interleaved RGB colours
 * (3 bytes per point) from a PointCloud for a given colour mode.
 *
 * No three.js dependency — safe to import in Node/Vitest tests.
 */

import type { PointCloud } from '../model/PointCloud';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The ways a point cloud can be coloured in the viewer. */
export type ColorMode = 'rgb' | 'intensity' | 'elevation' | 'classification' | 'normal';

// ─────────────────────────────────────────────────────────────────────────────
// Elevation colour ramps — perceptual palettes
// ─────────────────────────────────────────────────────────────────────────────
//
// The rainbow palette that most LiDAR viewers ship (blue→green→red) is one of
// the most-criticised choices in scientific visualization: it creates false
// boundaries at the hue transitions, hides detail in low-luminance regions,
// and is unreadable to ~8 % of the population. The matplotlib-style perceptual
// palettes below are:
//
//   • monotonic in luminance (so the eye reads them as ordered)
//   • smooth in CIELAB ∆E (no false bands)
//   • mostly colour-blind safe (Cividis is the only one fully CVD-safe; the
//     other three are dramatic improvements over rainbow but not perfectly
//     CVD-safe)
//
// Defaults to **Cividis** so the out-of-the-box experience works for everyone.

/** Type of an elevation ramp identifier. */
export type ElevationPalette = 'cividis' | 'viridis' | 'inferno' | 'turbo' | 'classic';

/** The default palette — Cividis is the only fully CVD-safe option. */
export const DEFAULT_ELEVATION_PALETTE: ElevationPalette = 'cividis';

/** A set of control points for a linear colour ramp. [t, r, g, b], rgb 0-255. */
type RampControlPoints = ReadonlyArray<readonly [number, number, number, number]>;

/**
 * Cividis — colour-blind safe, monotonic luminance, deep blue → yellow.
 * The only ramp in this list that's fully readable to deuteranopes /
 * protanopes / tritanopes. Recommended default for any scientific viewer.
 * Control points from Nuñez, Anderton & Renslow (2018).
 */
const PALETTE_CIVIDIS: RampControlPoints = [
  [0.00,   0,  32,  76],
  [0.20,  44,  60, 100],
  [0.40,  88,  94, 113],
  [0.60, 135, 132, 119],
  [0.80, 192, 175, 110],
  [1.00, 253, 231,  37],
];

/**
 * Viridis — perceptually uniform, dark purple → blue → green → yellow.
 * Matplotlib default. Reads very well; partial CVD-safety.
 */
const PALETTE_VIRIDIS: RampControlPoints = [
  [0.00,  68,   1,  84],
  [0.20,  64,  76, 131],
  [0.40,  43, 117, 142],
  [0.60,  32, 159, 117],
  [0.80, 138, 200,  74],
  [1.00, 253, 231,  37],
];

/**
 * Inferno — black → purple → orange → yellow. Highest dynamic range of the
 * four; ideal for terrain elevation where the eye benefits from a black
 * "floor" anchor.
 */
const PALETTE_INFERNO: RampControlPoints = [
  [0.00,   0,   0,   4],
  [0.20,  50,  10,  94],
  [0.40, 120,  28, 109],
  [0.60, 190,  55,  82],
  [0.80, 245, 125,  21],
  [1.00, 252, 255, 164],
];

/**
 * Turbo — Google's perceptually-corrected rainbow (Mikhailov 2019).
 * Looks like the classic rainbow but with the dark-low-luminance bug fixed.
 * Use when you specifically want the "rainbow" feel for traditional
 * audiences without the perceptual problems.
 */
const PALETTE_TURBO: RampControlPoints = [
  [0.00,  48,  18,  59],
  [0.15,  64,  74, 218],
  [0.30,  29, 169, 218],
  [0.50,  37, 246, 130],
  [0.70, 197, 247,  35],
  [0.85, 248, 168,  44],
  [1.00, 122,  4,    2],
];

/**
 * Classic blue → green → red rainbow. Kept for backward compatibility with
 * v0.3.6 share-links and saved sessions that hard-coded the old behaviour.
 * NOT recommended for new use — see Cividis or Viridis.
 */
const PALETTE_CLASSIC: RampControlPoints = [
  [0.00,   0,   0, 255],
  [0.25,   0, 200, 200],
  [0.50,   0, 220,   0],
  [0.75, 255, 180,   0],
  [1.00, 255,   0,   0],
];

const PALETTES: Readonly<Record<ElevationPalette, RampControlPoints>> = {
  cividis: PALETTE_CIVIDIS,
  viridis: PALETTE_VIRIDIS,
  inferno: PALETTE_INFERNO,
  turbo:   PALETTE_TURBO,
  classic: PALETTE_CLASSIC,
};

/** Catalog of palettes — keys for UI dropdowns, ordered by recommendation. */
export const ELEVATION_PALETTES: ReadonlyArray<{
  readonly id: ElevationPalette;
  readonly label: string;
  readonly description: string;
}> = [
  { id: 'cividis', label: 'Cividis', description: 'Colour-blind safe, recommended default' },
  { id: 'viridis', label: 'Viridis', description: 'Perceptually uniform, matplotlib default' },
  { id: 'inferno', label: 'Inferno', description: 'Highest dynamic range, dark floor' },
  { id: 'turbo',   label: 'Turbo',   description: 'Perceptually-corrected rainbow' },
  { id: 'classic', label: 'Classic', description: 'Legacy blue → red (not recommended)' },
];

/**
 * Interpolate a named perceptual ramp at normalised value `t` ∈ [0, 1].
 * Returns [r, g, b] in 0-255.
 */
function sampleRamp(
  t: number,
  palette: ElevationPalette = DEFAULT_ELEVATION_PALETTE,
): [number, number, number] {
  // Clamp to [0,1] to handle the degenerate single-point cloud case.
  const tc = Math.max(0, Math.min(1, t));
  const ramp = PALETTES[palette];

  // Find the two bracketing control points.
  let lo = ramp[0];
  let hi = ramp[ramp.length - 1];

  for (let i = 0; i < ramp.length - 1; i++) {
    if (tc >= ramp[i][0] && tc <= ramp[i + 1][0]) {
      lo = ramp[i];
      hi = ramp[i + 1];
      break;
    }
  }

  const span = hi[0] - lo[0];
  const f = span === 0 ? 0 : (tc - lo[0]) / span;

  return [
    Math.round(lo[1] + f * (hi[1] - lo[1])),
    Math.round(lo[2] + f * (hi[2] - lo[2])),
    Math.round(lo[3] + f * (hi[3] - lo[3])),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification palette
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Categorical colour palette keyed by ASPRS class code.
 * Unmapped codes fall back to a deterministic hue derived from the code.
 * Values are [r, g, b] in 0-255.
 */
const CLASS_PALETTE: Readonly<Record<number, readonly [number, number, number]>> = {
  0:  [200, 200, 200],   // Created / never classified  — light grey
  1:  [150, 150, 150],   // Unclassified               — mid grey
  2:  [139,  90,  43],   // Ground                     — brown
  3:  [  0, 160,  80],   // Low vegetation             — light green
  4:  [  0, 120,  50],   // Medium vegetation          — mid green
  5:  [  0,  80,  20],   // High vegetation            — dark green
  6:  [220,  80,  80],   // Building                   — salmon red
  7:  [255, 140,   0],   // Low point / noise          — orange
  8:  [200, 200,   0],   // Reserved                   — yellow
  9:  [ 30, 100, 220],   // Water                      — blue
  10: [180, 220, 240],   // Rail                       — light blue
  11: [240, 240, 240],   // Road surface               — near-white
  12: [200, 180, 120],   // Reserved                   — tan
  13: [120,  50, 200],   // Wire guard / shield        — purple
  14: [ 80,  20, 160],   // Wire conductor / phase     — violet
  15: [ 50, 200, 230],   // Transmission tower         — cyan
  16: [230, 180, 255],   // Wire connector             — light violet
  17: [255, 255,   0],   // Bridge deck                — bright yellow
  18: [255,   0, 255],   // High noise                 — magenta
};

/**
 * Generate a deterministic colour for an unmapped classification code
 * by spreading codes around the hue wheel.
 */
function fallbackClassColour(code: number): [number, number, number] {
  const hue = (code * 47) % 360;
  return hsvToRgb(hue, 0.75, 0.85);
}

/** Convert HSV (h∈[0,360), s,v∈[0,1]) to RGB (each in 0-255). */
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const hi = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (hi) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Colour `count` points by Z over an explicit `[minZ, maxZ]` range. */
export function colorByElevation(
  positions: Float32Array,
  count: number,
  minZ: number,
  maxZ: number,
  palette: ElevationPalette = DEFAULT_ELEVATION_PALETTE,
): Uint8Array {
  const out = new Uint8Array(count * 3);
  const range = maxZ - minZ;
  for (let i = 0; i < count; i++) {
    const t = range === 0 ? 0 : (positions[i * 3 + 2] - minZ) / range;
    const [r, g, b] = sampleRamp(t, palette);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/** Colour `count` points by intensity over an explicit `[minI, maxI]` range. */
export function colorByIntensity(
  intensity: ArrayLike<number>,
  count: number,
  minI: number,
  maxI: number,
): Uint8Array {
  const out = new Uint8Array(count * 3);
  const range = maxI - minI;
  for (let i = 0; i < count; i++) {
    const grey = range === 0 ? 0 : Math.round(((intensity[i] - minI) / range) * 255);
    out[i * 3] = grey;
    out[i * 3 + 1] = grey;
    out[i * 3 + 2] = grey;
  }
  return out;
}

/** Colour `count` points by ASPRS classification code. */
export function colorByClassification(
  classification: ArrayLike<number>,
  count: number,
): Uint8Array {
  const out = new Uint8Array(count * 3);
  const cache = new Map<number, readonly [number, number, number]>();
  for (let i = 0; i < count; i++) {
    const code = classification[i];
    let colour = cache.get(code);
    if (!colour) {
      colour = CLASS_PALETTE[code] ?? fallbackClassColour(code);
      cache.set(code, colour);
    }
    out[i * 3] = colour[0];
    out[i * 3 + 1] = colour[1];
    out[i * 3 + 2] = colour[2];
  }
  return out;
}

/**
 * Compute a flat interleaved RGB colour array (3 bytes per point) for `cloud`
 * using the specified `mode`.
 *
 * Throws if the cloud lacks the attribute required by the requested mode
 * (e.g. `'rgb'` when `cloud.colors` is undefined).
 */
export function colorForMode(mode: ColorMode, cloud: PointCloud): Uint8Array {
  const n = cloud.pointCount;

  switch (mode) {
    // ── rgb ─────────────────────────────────────────────────────────────────
    case 'rgb': {
      if (!cloud.colors) {
        throw new Error(`colorForMode('rgb'): cloud "${cloud.name}" has no colors attribute`);
      }
      return cloud.colors;
    }

    // ── intensity ───────────────────────────────────────────────────────────
    case 'intensity': {
      if (!cloud.intensity) {
        throw new Error(`colorForMode('intensity'): cloud "${cloud.name}" has no intensity attribute`);
      }
      const src = cloud.intensity;
      let minI = src[0];
      let maxI = src[0];
      for (let i = 1; i < n; i++) {
        if (src[i] < minI) minI = src[i];
        if (src[i] > maxI) maxI = src[i];
      }
      return colorByIntensity(src, n, minI, maxI);
    }

    // ── elevation ───────────────────────────────────────────────────────────
    case 'elevation': {
      const pos = cloud.positions;
      let minZ = pos[2];
      let maxZ = pos[2];
      for (let i = 0; i < n; i++) {
        const z = pos[i * 3 + 2];
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      return colorByElevation(pos, n, minZ, maxZ);
    }

    // ── normal ──────────────────────────────────────────────────────────────
    case 'normal': {
      if (!cloud.normals) {
        throw new Error(`colorForMode('normal'): cloud "${cloud.name}" has no normals attribute`);
      }
      const src = cloud.normals;
      const out = new Uint8Array(n * 3);

      // Encode each unit normal direction as RGB: component −1…+1 → 0…255.
      // The vector is normalised first so un-normalised file normals still map
      // into range.
      for (let i = 0; i < n; i++) {
        let nx = src[i * 3];
        let ny = src[i * 3 + 1];
        let nz = src[i * 3 + 2];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 0) {
          nx /= len;
          ny /= len;
          nz /= len;
        }
        out[i * 3]     = Math.round((nx + 1) * 0.5 * 255);
        out[i * 3 + 1] = Math.round((ny + 1) * 0.5 * 255);
        out[i * 3 + 2] = Math.round((nz + 1) * 0.5 * 255);
      }
      return out;
    }

    // ── classification ──────────────────────────────────────────────────────
    case 'classification': {
      if (!cloud.classification) {
        throw new Error(
          `colorForMode('classification'): cloud "${cloud.name}" has no classification attribute`,
        );
      }
      return colorByClassification(cloud.classification, n);
    }
  }
}

/**
 * Return only the colour modes for which `cloud` has the required data.
 * `'elevation'` is always available (it uses position Z which is always present).
 */
export function availableModes(cloud: PointCloud): ColorMode[] {
  const modes: ColorMode[] = [];
  if (cloud.colors)         modes.push('rgb');
  if (cloud.intensity)      modes.push('intensity');
  modes.push('elevation');
  if (cloud.classification) modes.push('classification');
  if (cloud.normals)        modes.push('normal');
  return modes;
}

/**
 * Choose the best default colour mode for `cloud`.
 * Prefers `'rgb'` when the cloud carries colour data; falls back to `'elevation'`.
 */
export function defaultMode(cloud: PointCloud): ColorMode {
  return cloud.colors ? 'rgb' : 'elevation';
}
