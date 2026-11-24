/** Sun position and strength to a colour change. */
import { describe, it, expect } from 'vitest';
import { LEVEL_CODE, packNormal } from '../src/render/sunShading/surfaceNormals';
import { buildSunTable, cleanSun, DEFAULT_SUN, shadeRgb } from '../src/render/sunShading/sunTable';

const NW = { azimuthDeg: 315, altitudeDeg: 45 };
const toNW = packNormal(-0.2, 0.2);
const toSE = packNormal(0.2, -0.2);

describe('buildSunTable', () => {
  it('is off by default and all zero at strength 0', () => {
    expect(DEFAULT_SUN.strength).toBe(0);
    expect(buildSunTable(DEFAULT_SUN).every((v) => v === 0)).toBe(true);
  });

  it('leaves a level surface alone under every sun', () => {
    for (const azimuthDeg of [0, 90, 200, 355]) {
      for (const altitudeDeg of [5, 45, 85]) {
        expect(Math.abs(buildSunTable({ strength: 1, azimuthDeg, altitudeDeg })[LEVEL_CODE])).toBeLessThan(1e-6);
      }
    }
  });

  it('lightens a face turned to the sun and darkens one turned away, by strength', () => {
    const full = buildSunTable({ strength: 1, ...NW });
    expect(full[toNW]).toBeGreaterThan(0.2);
    expect(full[toSE]).toBeLessThan(-0.2);
    const half = buildSunTable({ strength: 0.5, ...NW });
    expect(half[toNW]).toBeCloseTo(full[toNW] / 2, 5);
    const other = buildSunTable({ strength: 1, azimuthDeg: 135, altitudeDeg: 45 });
    expect(other[toNW]).toBeLessThan(0);
    expect(other[toSE]).toBeGreaterThan(0);
  });

  it('reads azimuth clockwise from north', () => {
    const east = buildSunTable({ strength: 1, azimuthDeg: 90, altitudeDeg: 30 });
    expect(east[packNormal(0.3, 0)]).toBeGreaterThan(0);
    expect(east[packNormal(-0.3, 0)]).toBeLessThan(0);
    expect(Math.abs(east[packNormal(0, 0.05)])).toBeLessThan(0.02);
  });

  it('never goes past white or below a tenth', () => {
    for (const altitudeDeg of [5, 45, 85]) {
      const t = buildSunTable({ strength: 1, azimuthDeg: 10, altitudeDeg });
      expect(t.every((v) => v >= -0.9001 && v <= 1)).toBe(true);
    }
  });
});

describe('cleanSun', () => {
  it('clamps, wraps and defaults', () => {
    expect(cleanSun({ strength: 4, azimuthDeg: -45, altitudeDeg: 120 })).toEqual({ strength: 1, azimuthDeg: 315, altitudeDeg: 85 });
    expect(cleanSun({ strength: Number.NaN, azimuthDeg: Number.NaN, altitudeDeg: Number.NaN })).toEqual(DEFAULT_SUN);
  });
});

describe('shadeRgb', () => {
  it('moves dark and light ends alike and skips level points', () => {
    const t = buildSunTable({ strength: 1, ...NW });
    const rgb = new Uint8Array([68, 1, 84, 253, 231, 37, 68, 1, 84, 10, 20, 30]);
    shadeRgb(rgb, Uint16Array.of(toNW, toSE, LEVEL_CODE, toNW), t);
    expect(rgb[1]).toBeGreaterThan(1); // the dark end lightens
    expect(rgb[3]).toBeLessThan(253);
    expect(Array.from(rgb.slice(6, 9))).toEqual([68, 1, 84]);
  });

  it('does not wrap at white, and tolerates a short code array', () => {
    const t = new Float32Array(65536).fill(1);
    const rgb = new Uint8Array([255, 254, 0, 7, 7, 7]);
    shadeRgb(rgb, Uint16Array.of(5), t);
    expect(Array.from(rgb)).toEqual([255, 255, 255, 7, 7, 7]);
  });
});
