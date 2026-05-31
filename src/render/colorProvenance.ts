/**
 * colorProvenance.ts
 *
 * Pure-data formatter for the "Color provenance" section of the Point
 * Inspector. Given a point's stored sRGB Uint8 colour, returns the
 * three numerical views an analyst needs to defend a map export:
 *
 *   - SCANNER  — the 8-bit channel values exactly as the scanner stored
 *                them in the LAS / LAZ / E57 / PLY file. These are the
 *                bytes the publisher of the dataset committed to disk.
 *   - LINEAR   — the same channels mapped through the piecewise sRGB
 *                EOTF (IEC 61966-2-1) into [0, 1] linear light. These
 *                are the values the renderer multiplies through the
 *                colour pipeline.
 *   - DISPLAY  — the linear values re-encoded back to sRGB Uint8 for
 *                display. Round-trips the stored bytes via the linear
 *                space the renderer uses, so the analyst can see by eye
 *                that the pipeline preserves the captured colour.
 *
 * Pure data — no DOM, no three.js — so the formatter ships through the
 * same module-graph seam every Stream A leaf uses. The Inspector card
 * (and the PDF report templates) read these strings without owning any
 * of the math.
 */

/** A formatted colour provenance row — every channel as a string. */
export interface ColorProvenance {
  /** Scanner-stored sRGB Uint8 — `[r, g, b]` in `[0, 255]`. */
  readonly scanner: readonly [number, number, number];
  /** Linear-light floats — `[r, g, b]` in `[0, 1]`. */
  readonly linear: readonly [number, number, number];
  /** Round-tripped sRGB Uint8 — `[r, g, b]` in `[0, 255]`. */
  readonly display: readonly [number, number, number];
  /** Display hex string, `#rrggbb`. */
  readonly hex: string;
}

function srgb8ToLinearFloat(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearFloatToSrgb8(v: number): number {
  const x = v < 0 ? 0 : v > 1 ? 1 : v;
  const s = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function clamp255(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 255) return 255;
  return Math.round(v);
}

function hex2(v: number): string {
  const s = clamp255(v).toString(16);
  return s.length < 2 ? '0' + s : s;
}

/**
 * Compute every provenance view for a single point.
 *
 * @param r Scanner R channel, [0, 255].
 * @param g Scanner G channel, [0, 255].
 * @param b Scanner B channel, [0, 255].
 */
export function colorProvenance(
  r: number,
  g: number,
  b: number,
): ColorProvenance {
  const rs = clamp255(r);
  const gs = clamp255(g);
  const bs = clamp255(b);
  const rL = srgb8ToLinearFloat(rs);
  const gL = srgb8ToLinearFloat(gs);
  const bL = srgb8ToLinearFloat(bs);
  const rD = linearFloatToSrgb8(rL);
  const gD = linearFloatToSrgb8(gL);
  const bD = linearFloatToSrgb8(bL);
  return {
    scanner: [rs, gs, bs],
    linear: [rL, gL, bL],
    display: [rD, gD, bD],
    hex: `#${hex2(rD)}${hex2(gD)}${hex2(bD)}`,
  };
}

/**
 * Format a `ColorProvenance` as the three rows the Inspector card and
 * the PDF report template render. Pure strings — no DOM — so the
 * formatter can ship in both surfaces without forking.
 *
 *   "Scanner:  R 184  G 102  B  46   #B8662E"
 *   "Linear:   R 0.481  G 0.131  G 0.025"
 *   "Display:  R 184  G 102  B  46   #B8662E"
 */
export function formatColorProvenance(cp: ColorProvenance): {
  scanner: string;
  linear: string;
  display: string;
} {
  const [rs, gs, bs] = cp.scanner;
  const [rL, gL, bL] = cp.linear;
  const [rD, gD, bD] = cp.display;
  return {
    scanner: `R ${rs}  G ${gs}  B ${bs}   ${cp.hex.toUpperCase()}`,
    linear: `R ${rL.toFixed(3)}  G ${gL.toFixed(3)}  B ${bL.toFixed(3)}`,
    display: `R ${rD}  G ${gD}  B ${bD}   ${cp.hex.toUpperCase()}`,
  };
}
