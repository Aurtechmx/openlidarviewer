/**
 * hypsometric.ts
 *
 * hypsometric (elevation) colour ramp for an optional tint
 * underlay beneath the contours. Pure colour mapping: an elevation and
 * the surface's min/max map to an RGB colour by linear interpolation
 * across a palette of stops. Kept pure-data so it is testable and so the
 * render layer (and the PDF/SVG exporters) all read the same ramp.
 *
 * The default palette is a conventional low→high terrain ramp
 * (green lowlands → tan → brown → grey-white peaks). It is NOT a
 * perceptual scientific ramp — hypsometric tint is a cartographic
 * convention, used as a soft underlay, not as the quantitative colour
 * channel (that remains the elevation/Cividis modes elsewhere).
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** 0..255 RGB triple. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** A palette stop at normalised position `t` (0..1). */
export interface ColorStop {
  readonly t: number;
  readonly color: RgbColor;
}

/** Conventional terrain hypsometric ramp, low → high. */
export const DEFAULT_TERRAIN_PALETTE: ReadonlyArray<ColorStop> = [
  { t: 0.0, color: { r: 56, g: 122, b: 75 } }, // lowland green
  { t: 0.35, color: { r: 173, g: 188, b: 110 } }, // foothills
  { t: 0.6, color: { r: 201, g: 168, b: 110 } }, // tan
  { t: 0.8, color: { r: 153, g: 122, b: 96 } }, // brown
  { t: 1.0, color: { r: 240, g: 240, b: 240 } }, // grey-white peaks
];

/**
 * Canopy / above-ground-height ramp, low → high. A perceptual ColorBrewer
 * "Greens" sequence: near-ground height reads pale, tall canopy reads deep
 * green — the conventional cartographic reading for a canopy height model.
 */
export const DEFAULT_CANOPY_PALETTE: ReadonlyArray<ColorStop> = [
  { t: 0.0, color: { r: 237, g: 248, b: 233 } }, // ground / very low
  { t: 0.25, color: { r: 161, g: 217, b: 155 } }, // low growth
  { t: 0.5, color: { r: 65, g: 171, b: 93 } }, // shrub / mid canopy
  { t: 0.75, color: { r: 35, g: 132, b: 67 } }, // canopy
  { t: 1.0, color: { r: 0, g: 88, b: 50 } }, // tall canopy
];

function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Map an elevation to a hypsometric colour. When `maxZ <= minZ` (flat
 * surface) the first stop colour is returned. Out-of-range values clamp
 * to the palette ends. `palette` must be sorted by `t` ascending and
 * span 0..1; the default does.
 */
export function hypsometricColor(
  value: number,
  minZ: number,
  maxZ: number,
  palette: ReadonlyArray<ColorStop> = DEFAULT_TERRAIN_PALETTE,
): RgbColor {
  if (palette.length === 0) return { r: 0, g: 0, b: 0 };
  if (palette.length === 1 || !(maxZ > minZ)) return palette[0].color;

  const t = clamp01((value - minZ) / (maxZ - minZ));
  if (t <= palette[0].t) return palette[0].color;
  const last = palette[palette.length - 1];
  if (t >= last.t) return last.color;

  for (let i = 1; i < palette.length; i++) {
    const hi = palette[i];
    if (t <= hi.t) {
      const lo = palette[i - 1];
      const span = hi.t - lo.t;
      const localT = span > 0 ? (t - lo.t) / span : 0;
      return {
        r: lerpChannel(lo.color.r, hi.color.r, localT),
        g: lerpChannel(lo.color.g, hi.color.g, localT),
        b: lerpChannel(lo.color.b, hi.color.b, localT),
      };
    }
  }
  return last.color;
}
