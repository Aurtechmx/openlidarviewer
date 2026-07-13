/**
 * colorModes.ts
 *
 * Pure functions that derive a flat Uint8Array of interleaved RGB colours
 * (3 bytes per point) from a PointCloud for a given colour mode.
 *
 * No three.js dependency — safe to import in Node/Vitest tests.
 */

import { clamp, clamp01 } from '../numeric';
import type { PointCloud } from '../model/PointCloud';
import { densityForChunk, defaultCellSizeForSpacing } from './densityColors';
import { computeElevationRange, computeScalarRange } from './elevationRange';
import {
  coverageColorForConfidence,
  COVERAGE_NONE,
  type CoverageRgb,
} from '../terrain/surface/coverageHeatmap';
import {
  confidenceColorForConfidence,
  CONFIDENCE_NONE,
} from '../terrain/surface/confidenceOverlay';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The ways a point cloud can be coloured in the viewer. */
export type ColorMode =
  | 'rgb'
  | 'intensity'
  | 'elevation'
  | 'classification'
  | 'normal'
  /**
   * GPS acquisition time — early → late on the CVD-safe Cividis ramp. A
   * genuinely CONTINUOUS per-point scalar (Float64 seconds), so a perceptual
   * ramp is an honest encoding. The absolute values are huge (~3e8 s GPS
   * adjusted standard time); the colour pass normalises against the
   * per-cloud min/max before ramping so sub-second deltas survive.
   */
  | 'gpsTime'
  /**
   * Return number — first → last return on the CVD-safe Cividis ramp. Return
   * ordinals are a small but genuinely ORDERED quantity (1st return ≺ 2nd ≺
   * 3rd …), so a sequential ramp reads honestly: brighter = later return,
   * i.e. deeper canopy penetration.
   *
   * HONESTY GATE — the categorical ids stay categorical: classification keeps
   * its qualitative ASPRS palette and pointSourceId gets NO ramp mode at all.
   * Painting unordered ids on a sequential ramp would invent an ordering the
   * data does not have (flight line 7 is not "more" than flight line 3).
   */
  | 'returnNumber'
  /**
   * Density heatmap — perceptual hot-cold colouring of points-per-m² in a
   * horizontal voxel grid. Surfaces coverage gaps an analyst would otherwise
   * miss in the single global density figure on the Scan Report. Always
   * available because it derives from positions alone.
   */
  | 'density'
  /**
   * Coverage heatmap — green/yellow/red trust read of the bare-earth DTM.
   * Each point is coloured by the confidence of the DTM cell it falls in
   * (strong/moderate/weak terrain support); points outside the analysed grid
   * (or in empty cells) read a neutral dim grey. Only MEANINGFUL after terrain
   * analysis has run — it needs the confidence grid — so the UI gates the
   * button on a grid existing. Shares the exact ramp + thresholds with the 2D
   * Coverage preview tile, so the two surfaces agree.
   */
  | 'coverage'
  /**
   * Confidence overlay — the COLOURBLIND-SAFE twin of `'coverage'`. The same
   * calibrated per-cell DTM confidence, the SAME strong/moderate/weak buckets
   * (gradeForConfidence — the thresholds the Analyse panel's minimap legend
   * uses), but coloured on exact Cividis stops (the only catalogue palette
   * tagged fully CVD-safe) instead of green/yellow/red. Analysis-gated like
   * coverage: the UI keeps the button disabled until a confidence grid exists.
   */
  | 'confidence';

/**
 * The minimal DTM-confidence grid the `'coverage'` colour mode samples. A
 * point at world `(x, y)` maps to cell `col = floor((x − originH1) / cellSizeM)`,
 * `row = floor((y − originH2) / cellSizeM)` — the SAME geometry the DTM raster
 * was built with (horizontal axes H1=x, H2=y for a z-up frame). A `DtmGrid`
 * fits this structurally.
 */
export interface CoverageColorGrid {
  /** 0..100 trust per cell, row-major. */
  readonly confidence: ArrayLike<number>;
  /** Per-cell provenance (0 = none/empty, >0 = has a height). Row-major. */
  readonly coverage: ArrayLike<number>;
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM: number;
  readonly originH1: number;
  readonly originH2: number;
}

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

/**
 * The default palette.
 *
 * v0.3.7 final-polish: switched from Cividis to Turbo. Cividis is
 * fully CVD-safe but its mid-tones are muted blue → grey → gold —
 * not perceptually dramatic enough on field-only scans where the
 * actual elevation variation is small. Turbo (Google's perceptually-
 * corrected spectral rainbow) keeps the red → orange → yellow →
 * green → blue gradient an analyst expects from a topographic ramp
 * and lights up small elevation differences much more clearly.
 *
 * Cividis is still in the catalogue (and remains the recommended pick
 * for colour-blind users) — every preset and the future per-cloud
 * picker can swap to it.
 */
export const DEFAULT_ELEVATION_PALETTE: ElevationPalette = 'turbo';

/**
 * The default palette for the generic scalar modes (gpsTime, returnNumber,
 * intensity-with-colormap). Cividis — the only ramp in the catalogue tagged
 * fully colourblind-safe (see `paletteCatalog.ts`). Elevation keeps its own
 * Turbo default (chosen for drama on low-relief fields, see above); the
 * scalar modes are new surfaces with no legacy expectation, so they start
 * from the ramp that is readable to everyone.
 */
export const DEFAULT_SCALAR_PALETTE: ElevationPalette = 'cividis';

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
 * Sample a named perceptual ramp at normalised value `t` ∈ [0, 1], returning
 * [r, g, b] in 0-255. Public wrapper over the internal {@link sampleRamp} so a
 * colorbar / legend renders the SAME ramp the points on screen use — a legend
 * swatch can never disagree with the colouring it labels.
 */
export function elevationRampColor(
  t: number,
  palette: ElevationPalette = DEFAULT_ELEVATION_PALETTE,
): [number, number, number] {
  return sampleRamp(t, palette);
}

/**
 * Interpolate a named perceptual ramp at normalised value `t` ∈ [0, 1].
 * Returns [r, g, b] in 0-255.
 */
function sampleRamp(
  t: number,
  palette: ElevationPalette = DEFAULT_ELEVATION_PALETTE,
): [number, number, number] {
  // Clamp to [0,1] to handle the degenerate single-point cloud case.
  const tc = clamp01(t);
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
  12: [200, 180, 120],   // Overlap                    — tan
  13: [120,  50, 200],   // Wire guard / shield        — purple
  14: [ 80,  20, 160],   // Wire conductor / phase     — violet
  15: [ 50, 200, 230],   // Transmission tower         — cyan
  16: [230, 180, 255],   // Wire connector             — light violet
  17: [255, 255,   0],   // Bridge deck                — bright yellow
  18: [255,   0, 255],   // High noise                 — magenta
  19: [120, 130, 150],   // Overhead structure         — slate
  20: [110,  80,  50],   // Ignored ground             — dim brown (muted ground)
  21: [235, 245, 255],   // Snow                       — near-white blue tint
  22: [150, 120, 170],   // Temporal exclusion         — muted purple
};

/**
 * Colourblind-safe categorical palette, keyed by the same ASPRS class codes.
 * Built on the Okabe-Ito qualitative palette (distinguishable under
 * deuteranopia, protanopia, and tritanopia). The default palette above puts
 * green vegetation next to red buildings and brown ground — the classic
 * red/green confusion. Here ground reads ORANGE, the three vegetation classes
 * are LIGHTNESS steps of bluish-green (separable even for monochromats),
 * buildings read VERMILLION, and water reads BLUE — separations that survive
 * every common CVD type. Greys for the unclassified codes are kept.
 */
const CLASS_PALETTE_CVD: Readonly<Record<number, readonly [number, number, number]>> = {
  0:  [200, 200, 200],   // Created / never classified
  1:  [150, 150, 150],   // Unclassified
  2:  [230, 159,   0],   // Ground            — Okabe-Ito orange
  3:  [120, 200, 170],   // Low vegetation    — bluish-green, light
  4:  [  0, 158, 115],   // Medium vegetation — bluish-green
  5:  [  0,  95,  70],   // High vegetation   — bluish-green, dark
  6:  [213,  94,   0],   // Building          — Okabe-Ito vermillion
  7:  [204, 121, 167],   // Low point / noise — reddish purple
  8:  [240, 228,  66],   // Reserved          — Okabe-Ito yellow
  9:  [  0, 114, 178],   // Water             — Okabe-Ito blue
  10: [ 86, 180, 233],   // Rail              — Okabe-Ito sky blue
  11: [225, 225, 225],   // Road surface      — near-white
  12: [190, 160,  90],   // Overlap           — muted tan
  13: [150,  80, 120],   // Wire guard        — dark reddish purple
  14: [110,  60, 140],   // Wire conductor    — violet
  15: [ 40, 120, 170],   // Transmission tower— dark sky blue
  16: [220, 160, 200],   // Wire connector    — light reddish purple
  17: [240, 228,  66],   // Bridge deck       — yellow
  18: [240, 140,  90],   // High noise        — light vermillion
  19: [100, 110, 130],   // Overhead structure— dark slate
  20: [140, 100,  60],   // Ignored ground    — dim brown
  21: [220, 235, 250],   // Snow              — pale blue-white
  22: [170, 140, 190],   // Temporal exclusion— light purple
};

/**
 * The active class palette. A module-level switch (rather than a parameter
 * threaded through every recolour call site) so `classColor` and
 * `colorByClassification` flip together when the user toggles colourblind-safe
 * mode; the host re-triggers the recolour + legend rebuild after the switch.
 */
let activeClassPalette: Readonly<Record<number, readonly [number, number, number]>> =
  CLASS_PALETTE;

/** Switch the categorical class palette between default and colourblind-safe. */
export function setColorblindSafeClasses(on: boolean): void {
  activeClassPalette = on ? CLASS_PALETTE_CVD : CLASS_PALETTE;
}

/** Whether the colourblind-safe class palette is currently active. */
export function colorblindSafeClasses(): boolean {
  return activeClassPalette === CLASS_PALETTE_CVD;
}

/**
 * Generate a deterministic colour for an unmapped classification code
 * by spreading codes around the hue wheel.
 */
function fallbackClassColour(code: number): [number, number, number] {
  const hue = (code * 47) % 360;
  return hsvToRgb(hue, 0.75, 0.85);
}

/**
 * The categorical [r, g, b] (0-255) colour the renderer uses for an ASPRS
 * class code in "colour by class" mode. Mapped codes return their palette
 * entry; unmapped codes fall back to the same deterministic hue the colour
 * pass uses, so a legend swatch always matches the points on screen. The
 * code is masked to a byte to match the rest of the class pipeline.
 */
export function classColor(code: number): [number, number, number] {
  const c = code & 0xff;
  const mapped = activeClassPalette[c];
  return mapped ? [mapped[0], mapped[1], mapped[2]] : fallbackClassColour(c);
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

/**
 * The ONE loop through `sampleRamp` — every ramp-coloured scalar mode
 * (elevation, gpsTime, returnNumber, intensity-with-colormap) funnels
 * through here so normalisation, clamping, and no-data semantics can never
 * drift between modes. `elemStride` / `elemOffset` let the elevation path
 * read one component out of interleaved xyz triplets (stride 3, offset =
 * up-axis) while flat per-point arrays read every value (stride 1, offset 0).
 *
 * Values read as plain JS numbers (doubles), so Float64 sources with huge
 * absolute values — GPS time at ~3e8 s — keep their sub-range deltas: the
 * `(v − min) / range` normalisation happens in double precision and only the
 * final 0..1 `t` meets the ramp.
 */
function rampScalars(
  values: ArrayLike<number>,
  count: number,
  min: number,
  max: number,
  palette: ElevationPalette,
  elemStride: number,
  elemOffset: number,
): Uint8Array {
  const out = new Uint8Array(count * 3);
  const range = max - min;
  for (let i = 0; i < count; i++) {
    const v = values[i * elemStride + elemOffset];
    // NaN skip — a NaN value keeps its (0, 0, 0) bytes as an honest "no
    // data" black instead of feeding NaN through the ramp maths. (±Infinity
    // still flows through and clamps to a ramp endpoint, matching what the
    // pre-refactor elevation loop did.)
    if (v !== v) continue;
    const t = range === 0 ? 0 : (v - min) / range;
    const [r, g, b] = sampleRamp(t, palette);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/**
 * Colour `count` points by an arbitrary per-point scalar over an explicit
 * `[min, max]` range. Values at/below `min` take the ramp's bottom colour,
 * at/above `max` the top colour; a degenerate `min === max` paints every
 * point the bottom colour. Defaults to the CVD-safe Cividis ramp.
 */
export function colorByScalar(
  values: ArrayLike<number>,
  count: number,
  min: number,
  max: number,
  palette: ElevationPalette = DEFAULT_SCALAR_PALETTE,
): Uint8Array {
  return rampScalars(values, count, min, max, palette, 1, 0);
}

/** Colour `count` points by Z over an explicit `[minZ, maxZ]` range. */
export function colorByElevation(
  positions: Float32Array,
  count: number,
  minZ: number,
  maxZ: number,
  palette: ElevationPalette = DEFAULT_ELEVATION_PALETTE,
  /**
   * Which interleaved component is "up": 2 = Z (LAS/LAZ/E57 surveys), 1 = Y
   * (phone-scan PLY/OBJ/GLB). Defaults to Z. Without this a Y-up scan would be
   * coloured along a horizontal axis instead of by height.
   */
  upAxis: 0 | 1 | 2 = 2,
): Uint8Array {
  return rampScalars(positions, count, minZ, maxZ, palette, 3, upAxis);
}

/**
 * Colour `count` points by intensity over an explicit `[minI, maxI]` range.
 * Greyscale by default — the reading every LiDAR analyst expects and the
 * behaviour every existing call site relies on. Pass a `palette` to ramp the
 * same normalised intensity through a perceptual colormap instead.
 */
export function colorByIntensity(
  intensity: ArrayLike<number>,
  count: number,
  minI: number,
  maxI: number,
  palette?: ElevationPalette,
): Uint8Array {
  if (palette) return rampScalars(intensity, count, minI, maxI, palette, 1, 0);
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
      colour = activeClassPalette[code] ?? fallbackClassColour(code);
      cache.set(code, colour);
    }
    out[i * 3] = colour[0];
    out[i * 3 + 1] = colour[1];
    out[i * 3 + 2] = colour[2];
  }
  return out;
}

/**
 * Colour `count` points by the confidence of the DTM cell each falls in, using
 * the shared green/yellow/red coverage ramp. Points outside the grid (or in an
 * empty / no-data cell) get a neutral dim grey. Pure — no renderer, testable.
 *
 * The sampling geometry mirrors the DTM raster: `col = floor((x − originH1) /
 * cellSizeM)`, `row = floor((y − originH2) / cellSizeM)`, index `row*cols+col`.
 */
export function colorByCoverage(
  positions: Float32Array,
  count: number,
  grid: CoverageColorGrid,
): Uint8Array {
  return colorByGridConfidence(positions, count, grid, coverageColorForConfidence, COVERAGE_NONE);
}

/**
 * Colour `count` points by the confidence of the DTM cell each falls in, on
 * the COLOURBLIND-SAFE Cividis confidence ramp — the same grid lookup, the
 * same trust buckets, the same neutral-grey fallback as `colorByCoverage`;
 * only the ramp differs. Pure — no renderer, testable.
 */
export function colorByConfidence(
  positions: Float32Array,
  count: number,
  grid: CoverageColorGrid,
): Uint8Array {
  return colorByGridConfidence(
    positions,
    count,
    grid,
    confidenceColorForConfidence,
    CONFIDENCE_NONE,
  );
}

/**
 * Shared grid-lookup core for the two trust overlays. One loop so the
 * coverage and confidence modes can never disagree about WHICH cell a point
 * samples — they may only disagree about the hue that cell paints.
 */
function colorByGridConfidence(
  positions: Float32Array,
  count: number,
  grid: CoverageColorGrid,
  colorFor: (confidence: number) => CoverageRgb,
  none: CoverageRgb,
): Uint8Array {
  const out = new Uint8Array(count * 3);
  const { cols, rows, cellSizeM, originH1, originH2, confidence, coverage } = grid;
  const inv = cellSizeM > 0 ? 1 / cellSizeM : 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    let col = -1;
    let row = -1;
    if (inv > 0 && Number.isFinite(x) && Number.isFinite(y)) {
      col = Math.floor((x - originH1) * inv);
      row = Math.floor((y - originH2) * inv);
    }
    let c = none;
    if (col >= 0 && col < cols && row >= 0 && row < rows) {
      const idx = row * cols + col;
      // An empty / no-data cell stays neutral grey — the point has no analysed
      // surface beneath it to trust or distrust.
      if (coverage[idx] !== 0) c = colorFor(confidence[idx]);
    }
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
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
/**
 * Optional knobs `colorForMode` understands per-mode. v0.3.7 final-polish
 * adds the height-percentile-trim slider that lets the Inspector tune
 * how aggressively outlier Z values clamp to the palette endpoints.
 */
export interface ColorForModeOptions {
  /**
   * Symmetric percentile trim for the elevation mode. `trim = 5` →
   * the 5th / 95th percentile band; `trim = 0` → the true min/max.
   * Clamped to [0, 25] inside `computeElevationRange`.
   */
  heightPercentileTrim?: number;
  /**
   * Which interleaved component is "up" for the `'elevation'` mode: 2 = Z
   * (LAS/LAZ/E57 surveys), 1 = Y (phone-scan PLY/OBJ/GLB). Defaults to Z. The
   * Viewer derives it from the cloud's source format so Y-up scans colour by
   * true height, not a horizontal axis.
   */
  upAxis?: 0 | 1 | 2;
  /**
   * The DTM-confidence grid the `'coverage'` and `'confidence'` modes sample.
   * Supplied by the Viewer after a terrain analysis runs. When absent in
   * either mode every point reads the neutral dim grey (no crash) — the UI
   * disables both buttons until a grid exists, so this is the defensive
   * fallback.
   */
  coverageGrid?: CoverageColorGrid;
}

/**
 * The `[min, max]` of a per-point scalar array, skipping non-finite values —
 * one NaN from a malformed loader must not poison a whole ramp. Returns
 * `{ 0, 0 }` when nothing finite exists so callers get the degenerate
 * "everything at the bottom colour" behaviour instead of a NaN range.
 *
 * Exported as the ONE raw finite min/max scan for ramp ranges: the streaming
 * pipeline's `scalarRangeOf` delegates here, so the static and streaming
 * seeding semantics for non-finite values can never drift apart.
 */
export function finiteMinMax(values: ArrayLike<number>, count: number): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { min, max } : { min: 0, max: 0 };
}

export function colorForMode(
  mode: ColorMode,
  cloud: PointCloud,
  opts?: ColorForModeOptions,
): Uint8Array {
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
      const { min, max } = finiteMinMax(src, n);
      return colorByIntensity(src, n, min, max);
    }

    // ── gpsTime (continuous scalar, Cividis ramp) ─────────────────────────────
    case 'gpsTime': {
      if (!cloud.gpsTime) {
        throw new Error(`colorForMode('gpsTime'): cloud "${cloud.name}" has no gpsTime attribute`);
      }
      // Percentile-clipped range through the same core elevation uses. GPS
      // times are Float64 seconds with ~3e8 absolute values, so only the
      // delta from the cloud's own acquisition window carries visual
      // information — and a raw min/max would let one garbage timestamp (an
      // epoch-zero record from a malformed writer) compress the whole flight
      // line into a single colour stop, the exact failure the elevation ramp
      // already guards against. The core also skips non-finite values, so a
      // NaN timestamp cannot poison the range.
      const src = cloud.gpsTime;
      const range = computeScalarRange(src, { count: n });
      return colorByScalar(src, n, range.min, range.max);
    }

    // ── returnNumber (ordered scalar, Cividis ramp) ───────────────────────────
    case 'returnNumber': {
      if (!cloud.returnNumber) {
        throw new Error(
          `colorForMode('returnNumber'): cloud "${cloud.name}" has no returnNumber attribute`,
        );
      }
      // Raw finite min/max, DELIBERATELY not percentile-clipped. Return
      // numbers are a handful of small ordinals (1..15 by the LAS format —
      // typically 1..5 in practice), so there is no unbounded-outlier
      // failure mode for a percentile band to guard against; clipping would
      // instead merge real ordinals (a legitimate 5th return) into an
      // endpoint colour and erase exactly the deep-canopy reading the mode
      // exists to show.
      const src = cloud.returnNumber;
      const { min, max } = finiteMinMax(src, n);
      return colorByScalar(src, n, min, max);
    }

    // ── elevation ───────────────────────────────────────────────────────────
    case 'elevation': {
      // v0.3.7 final-polish — percentile-clipped Z range. The previous
      // true min/max scan let a single tall outlier (a tree, a power
      // line, a flag-mast) compress the entire field of points into
      // one colour stop. The 2nd / 98th percentile band keeps the
      // ramp meaningful on outlier-heavy clouds and matches what
      // CloudCompare / Potree / Entwine viewers do.
      const trim = clamp(opts?.heightPercentileTrim ?? 5, 0, 25);
      const upAxis = opts?.upAxis ?? 2;
      const range = computeElevationRange({
        positions: cloud.positions,
        pointCount: n,
        lowerPercentile: trim,
        upperPercentile: 100 - trim,
        upAxis,
      });
      return colorByElevation(cloud.positions, n, range.minZ, range.maxZ, undefined, upAxis);
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

    // ── density (heatmap) ───────────────────────────────────────────────────
    case 'density': {
      // Cell size derived from the cloud's spacing when known; otherwise
      // default to a metre. `densityForChunk` clamps internally to safe
      // bounds, so a missing spacing value still produces a valid heatmap.
      const spacing = (cloud as { spacing?: number }).spacing ?? 0;
      const cellSize = defaultCellSizeForSpacing(spacing);
      return densityForChunk({
        positions: cloud.positions,
        cellSize,
      }).colors;
    }

    // ── coverage (DTM-confidence heatmap) ─────────────────────────────────────
    case 'coverage': {
      // No grid yet (analysis hasn't run) → every point is the neutral grey.
      // The UI gates the button on a grid existing, so this is the safe
      // fallback rather than an error: a missing grid is a UI state, not a
      // data defect like a missing attribute.
      if (!opts?.coverageGrid) {
        const out = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
          out[i * 3] = COVERAGE_NONE.r;
          out[i * 3 + 1] = COVERAGE_NONE.g;
          out[i * 3 + 2] = COVERAGE_NONE.b;
        }
        return out;
      }
      return colorByCoverage(cloud.positions, n, opts.coverageGrid);
    }

    // ── confidence (colourblind-safe trust overlay) ───────────────────────────
    case 'confidence': {
      // Same analysis-gated contract as 'coverage': a missing grid is a UI
      // state, not a data defect, so every point reads the neutral grey
      // (CONFIDENCE_NONE === COVERAGE_NONE) instead of throwing.
      if (!opts?.coverageGrid) {
        const out = new Uint8Array(n * 3);
        for (let i = 0; i < n; i++) {
          out[i * 3] = CONFIDENCE_NONE.r;
          out[i * 3 + 1] = CONFIDENCE_NONE.g;
          out[i * 3 + 2] = CONFIDENCE_NONE.b;
        }
        return out;
      }
      return colorByConfidence(cloud.positions, n, opts.coverageGrid);
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
  // Density is always available — it derives from positions alone, which
  // every cloud carries by definition.
  modes.push('density');
  // The continuous scalar modes, data-gated on their channel. Note the
  // honesty gate: `pointSourceId` is also decoded, but it is a categorical
  // flight-line id — ramping it would invent an ordering the data does not
  // have, so it deliberately gets NO colour mode here.
  if (cloud.gpsTime)      modes.push('gpsTime');
  if (cloud.returnNumber) modes.push('returnNumber');
  return modes;
}

/**
 * Choose the best default colour mode for `cloud`.
 * Prefers `'rgb'` when the cloud carries colour data; falls back to `'elevation'`.
 */
export function defaultMode(cloud: PointCloud): ColorMode {
  return cloud.colors ? 'rgb' : 'elevation';
}
