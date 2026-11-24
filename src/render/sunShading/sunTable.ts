/**
 * sunTable.ts: sun position and strength to a colour change per direction code.
 *
 * A level surface keeps its ramp colour whatever the sun, so the colourbar
 * stays true for flat ground and for every point with no measured surface. A
 * face turned to the sun lightens toward white, one turned away darkens; both
 * ends of a ramp therefore show relief, the dark end included. Pure.
 */

import { unpackComponent } from './surfaceNormals';

/** A sun position over the scene, in cartographic convention. */
export interface SunPosition {
  /** Degrees clockwise from the layer's north axis. */
  readonly azimuthDeg: number;
  /** Degrees above the horizon. */
  readonly altitudeDeg: number;
}

export interface SunSettings extends SunPosition {
  /** 0 (off) to 1. */
  readonly strength: number;
}

/** Off, with the usual map light: north-west, 45 degrees up. */
export const DEFAULT_SUN: SunSettings = { strength: 0, azimuthDeg: 315, altitudeDeg: 45 };
export const SUN_ALTITUDE = { min: 5, max: 85 } as const;

/** Gentle ground is what the light is for: slopes are lit as if this much steeper. */
export const RELIEF_FACTOR = 2;
/** The darkest a face gets, so it keeps some of its hue. */
const DARK_FLOOR = 0.1;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Settings inside their ranges; a non-finite value takes its default. */
export function cleanSun(s: SunSettings): SunSettings {
  const num = (v: number, d: number): number => (Number.isFinite(v) ? v : d);
  return {
    strength: clamp(num(s.strength, 0), 0, 1),
    azimuthDeg: ((num(s.azimuthDeg, DEFAULT_SUN.azimuthDeg) % 360) + 360) % 360,
    altitudeDeg: clamp(num(s.altitudeDeg, DEFAULT_SUN.altitudeDeg), SUN_ALTITUDE.min, SUN_ALTITUDE.max),
  };
}

/**
 * The change for every 16-bit direction code: negative darkens by that share,
 * positive lightens toward white by that share, zero leaves the colour alone.
 */
export function buildSunTable(sun: SunSettings): Float32Array {
  const { strength, azimuthDeg, altitudeDeg } = cleanSun(sun);
  const az = (azimuthDeg * Math.PI) / 180;
  const al = (altitudeDeg * Math.PI) / 180;
  const sx = Math.sin(az) * Math.cos(al);
  const sy = Math.cos(az) * Math.cos(al);
  const sz = Math.sin(al);
  const gain = 1 / Math.max(sz, 0.4);
  const out = new Float32Array(65536);
  const comp = Float64Array.from({ length: 256 }, (_, b) => unpackComponent(b));
  for (let code = 0; code < 65536; code++) {
    const x = comp[code >> 8];
    const y = comp[code & 255];
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    const ex = x * RELIEF_FACTOR;
    const ey = y * RELIEF_FACTOR;
    const len = Math.hypot(ex, ey, z) || 1;
    const lambert = Math.max(0, (ex * sx + ey * sy + z * sz) / len);
    out[code] = clamp((lambert - sz) * gain, DARK_FLOOR - 1, 1) * strength;
  }
  return out;
}

/** Shade interleaved RGB bytes in place. `codes` may be shorter than the buffer. */
export function shadeRgb(rgb: Uint8Array, codes: Uint16Array, table: Float32Array): void {
  const n = Math.min(codes.length, Math.floor(rgb.length / 3));
  for (let i = 0; i < n; i++) {
    const k = table[codes[i]];
    if (k === 0) continue;
    const j = i * 3;
    if (k < 0) {
      rgb[j] = rgb[j] * (1 + k) + 0.5;
      rgb[j + 1] = rgb[j + 1] * (1 + k) + 0.5;
      rgb[j + 2] = rgb[j + 2] * (1 + k) + 0.5;
    } else {
      rgb[j] += (255 - rgb[j]) * k + 0.5;
      rgb[j + 1] += (255 - rgb[j + 1]) * k + 0.5;
      rgb[j + 2] += (255 - rgb[j + 2]) * k + 0.5;
    }
  }
}
