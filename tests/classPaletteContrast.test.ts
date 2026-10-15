/**
 * The class palettes must read on the app's dark canvas and keep commonly
 * co-occurring ASPRS classes apart.
 *
 *   - Contrast: every mapped swatch reaches WCAG 3:1 against the default scene
 *     background, so no class sinks into the canvas.
 *   - Separation: CIEDE2000 ΔE ≥ 20 between every pair of the classes a typical
 *     aerial tile carries together (1 unclassified, 2 ground, 3/4/5 vegetation,
 *     6 building, 7 low noise, 9 water, 18 high noise, 20 ignored ground).
 *
 * Both the default and the colourblind-safe palette are held to the same rule.
 * `classColor` reads the active table, so the checks also cover what the legend
 * swatches show.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { classColor, setColorblindSafeClasses } from '../src/render/colorModes';
import { SCENE_BACKGROUND } from '../src/render/renderBootstrapPolicy';

type Rgb = readonly [number, number, number];

const BG: Rgb = [(SCENE_BACKGROUND >> 16) & 0xff, (SCENE_BACKGROUND >> 8) & 0xff, SCENE_BACKGROUND & 0xff];
const MAPPED = Array.from({ length: 23 }, (_, i) => i);
const CO_OCCURRING = [1, 2, 3, 4, 5, 6, 7, 9, 18, 20];

function lin(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: Rgb): number {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function lab([r8, g8, b8]: Rgb): [number, number, number] {
  const r = lin(r8), g = lin(g8), b = lin(b8);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
/** CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1. */
function deltaE2000(c1: Rgb, c2: Rgb): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (b: number, a: number) => (a === 0 && b === 0 ? 0 : (deg(Math.atan2(b, a)) + 360) % 360);
  const h1p = hp(b1, a1p), h2p = hp(b2, a2p);
  const dL = L2 - L1;
  const dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dh / 2));
  const Lb = (L1 + L2) / 2;
  const Cb = (C1p + C2p) / 2;
  let hb = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hb = (h1p + h2p) / 2;
    else hb = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos(rad(hb - 30)) + 0.24 * Math.cos(rad(2 * hb))
    + 0.32 * Math.cos(rad(3 * hb + 6)) - 0.2 * Math.cos(rad(4 * hb - 63));
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cb;
  const Sh = 1 + 0.015 * Cb * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

afterEach(() => setColorblindSafeClasses(false));

describe('CIEDE2000 implementation', () => {
  it('is zero for identical colours and 100 for black vs white', () => {
    expect(deltaE2000([255, 0, 0], [255, 0, 0])).toBe(0);
    // Black vs white is ΔE00 = 100 by construction (L* 0 → 100, no chroma).
    expect(deltaE2000([0, 0, 0], [255, 255, 255])).toBeCloseTo(100, 1);
  });
});

for (const cvd of [false, true]) {
  describe(`${cvd ? 'colourblind-safe' : 'default'} class palette`, () => {
    const color = (code: number): Rgb => {
      setColorblindSafeClasses(cvd);
      return classColor(code) as unknown as Rgb;
    };

    it('every mapped class reaches 3:1 contrast on the scene background', () => {
      for (const code of MAPPED) {
        expect(contrast(color(code), BG), `class ${code}`).toBeGreaterThanOrEqual(3);
      }
    });

    it('co-occurring classes are at least ΔE00 20 apart', () => {
      for (let i = 0; i < CO_OCCURRING.length; i++) {
        for (let j = i + 1; j < CO_OCCURRING.length; j++) {
          const a = CO_OCCURRING[i]!, b = CO_OCCURRING[j]!;
          expect(deltaE2000(color(a), color(b)), `classes ${a} vs ${b}`).toBeGreaterThanOrEqual(20);
        }
      }
    });

    it('separates ground from ignored ground and unclassified, and noise from buildings', () => {
      const pairs: [number, number][] = [[2, 20], [2, 1], [7, 18], [7, 6], [18, 6]];
      for (const [a, b] of pairs) {
        expect(deltaE2000(color(a), color(b)), `classes ${a} vs ${b}`).toBeGreaterThanOrEqual(20);
      }
    });
  });
}
