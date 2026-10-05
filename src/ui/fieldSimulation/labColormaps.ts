/**
 * labColormaps.ts — the perceptually uniform colour maps the Field Simulation
 * Lab grids paint with, plus the colour maths their tests use.
 *
 * viridis (flow accumulation) and cividis (traversal cost) come from the
 * viewer's own ramp table in render/colorModes.ts, so a Lab grid, its legend
 * and the 3D overlay share one set of stops. Both have a monotonic CIELAB
 * lightness ramp, so value order survives greyscale printing and the common
 * colour-vision deficiencies. Rainbow and jet are deliberately absent.
 */

import { elevationRampColor } from '../../render/colorModes';

export type Rgb = readonly [number, number, number];

const finite01 = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);

/** viridis at t in [0, 1], the same ramp the 3D overlays and elevation colouring use. */
export const viridis = (t: number): Rgb => elevationRampColor(finite01(t), 'viridis');
/** cividis at t in [0, 1], the same ramp the scalar colour modes use. */
export const cividis = (t: number): Rgb => elevationRampColor(finite01(t), 'cividis');

export function rgbCss(c: Rgb, alpha = 1): string {
  return alpha === 1 ? `rgb(${c[0]} ${c[1]} ${c[2]})` : `rgb(${c[0]} ${c[1]} ${c[2]} / ${alpha})`;
}

/** A CSS linear-gradient of a colour map, for a legend ramp drawn as real DOM. */
export function rampGradient(map: (t: number) => Rgb, steps = 9): string {
  const parts: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    parts.push(`${rgbCss(map(t))} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/* ---- colour maths used by the tests (and cheap enough to ship) ---- */

const toLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number): number => {
  const c = Math.min(1, Math.max(0, v));
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
};

/** sRGB to CIELAB (D65). */
export function rgbToLab(c: Rgb): Rgb {
  const r = toLinear(c[0]), g = toLinear(c[1]), b = toLinear(c[2]);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 colour difference. */
export function deltaE(a: Rgb, b: Rgb): number {
  const la = rgbToLab(a), lb = rgbToLab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

export type Deficiency = 'protan' | 'deutan' | 'tritan';

/** Machado, Oliveira and Fernandes (2009), severity 1.0, applied in linear RGB. */
const CVD_MATRIX: Record<Deficiency, readonly number[]> = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039],
};

export function simulateCvd(c: Rgb, kind: Deficiency): Rgb {
  const m = CVD_MATRIX[kind];
  const r = toLinear(c[0]), g = toLinear(c[1]), b = toLinear(c[2]);
  return [
    Math.round(toSrgb(m[0]! * r + m[1]! * g + m[2]! * b)),
    Math.round(toSrgb(m[3]! * r + m[4]! * g + m[5]! * b)),
    Math.round(toSrgb(m[6]! * r + m[7]! * g + m[8]! * b)),
  ];
}

/** True when the user asked the system for reduced motion. Safe without `matchMedia`. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
