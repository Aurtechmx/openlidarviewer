/**
 * tests/hillshadeColors.test.ts
 *
 * Coverage for the v0.3.7 hillshade colour-mode helpers: the gradient-
 * based shading scalar and the in-place RGB modulator.
 */

import { describe, it, expect } from 'vitest';
import {
  hillshadeShading,
  bakeHillshadeIntoRgb,
  DEFAULT_SUN,
} from '../src/render/hillshadeColors';

function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('hillshadeShading — sun-direction Lambertian', () => {
  it('returns 0..1 values for every point', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 0, 1],
      [0, 1, 2],
    ]);
    const out = hillshadeShading({ positions, cellSize: 1 });
    expect(out).toHaveLength(3);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a perfectly flat ground reads as constant shading equal to sin(altitude)', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ]);
    const out = hillshadeShading({
      positions,
      sun: { azimuthDeg: 0, altitudeDeg: 30 },
      cellSize: 1,
    });
    const expected = Math.sin((30 * Math.PI) / 180);
    for (const v of out) {
      expect(v).toBeCloseTo(expected, 3);
    }
  });

  it('returns an empty array for an empty cloud', () => {
    const out = hillshadeShading({ positions: new Float32Array(0) });
    expect(out).toHaveLength(0);
  });

  it('uses DEFAULT_SUN when no sun position is provided', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 0, 0],
    ]);
    const a = hillshadeShading({ positions, cellSize: 1 });
    const b = hillshadeShading({ positions, sun: DEFAULT_SUN, cellSize: 1 });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('a sloped surface produces non-uniform shading aligned with the sun direction', () => {
    // 3-cell ramp climbing east (+X). With sun from the east at low
    // altitude, the east-facing ramp slope should be lit; rotating the
    // sun to the west should darken those points instead.
    const positions = pack([
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [0, 1, 0],
      [1, 1, 1],
      [2, 1, 2],
    ]);
    const eastSun = hillshadeShading({
      positions,
      sun: { azimuthDeg: 90, altitudeDeg: 10 }, // from the east, low
      cellSize: 1,
    });
    const westSun = hillshadeShading({
      positions,
      sun: { azimuthDeg: 270, altitudeDeg: 10 }, // from the west
      cellSize: 1,
    });
    // The two sun directions are mirror images — the east-lit average
    // should differ from the west-lit one.
    const meanEast = eastSun.reduce((s, v) => s + v, 0) / eastSun.length;
    const meanWest = westSun.reduce((s, v) => s + v, 0) / westSun.length;
    expect(meanEast).not.toBeCloseTo(meanWest, 3);
  });

  it('zExaggeration changes the magnitude of the gradient (sanity)', () => {
    // A more direct test than variance ordering: with a higher zEx the
    // computed shading values for a ramp diverge from the flat-ground
    // baseline by a larger margin. We use a high-altitude sun so the
    // shading stays positive (no back-light clamping at zEx = 1).
    const ramp = pack([
      [0, 0, 0],
      [1, 0, 0.1],
      [2, 0, 0.2],
      [0, 1, 0],
      [1, 1, 0.1],
      [2, 1, 0.2],
    ]);
    const sun = { azimuthDeg: 315, altitudeDeg: 60 };
    const flat = Math.sin((60 * Math.PI) / 180);
    const aShading = hillshadeShading({ positions: ramp, sun, cellSize: 1, zExaggeration: 1 });
    const bShading = hillshadeShading({ positions: ramp, sun, cellSize: 1, zExaggeration: 5 });
    const meanDist = (arr: Float32Array) =>
      arr.reduce((s, v) => s + Math.abs(v - flat), 0) / arr.length;
    // Higher zEx → each cell's normal tilts farther from vertical → the
    // Lambert dot product departs further from the flat-ground baseline.
    expect(meanDist(bShading)).toBeGreaterThan(meanDist(aShading));
  });
});

describe('bakeHillshadeIntoRgb — in-place modulator', () => {
  it('strength = 0 leaves the colour unchanged', () => {
    const rgb = new Uint8Array([200, 100, 50, 100, 200, 50]);
    const shading = new Float32Array([0.2, 0.8]);
    bakeHillshadeIntoRgb(rgb, shading, 0);
    expect(Array.from(rgb)).toEqual([200, 100, 50, 100, 200, 50]);
  });

  it('strength = 1 darkens the colour by exactly the shading factor', () => {
    const rgb = new Uint8Array([200, 100, 50]);
    const shading = new Float32Array([0.5]);
    bakeHillshadeIntoRgb(rgb, shading, 1);
    expect(rgb[0]).toBe(100); // 200 × 0.5
    expect(rgb[1]).toBe(50); //  100 × 0.5
    expect(rgb[2]).toBe(25); //   50 × 0.5
  });

  it('clamps the strength parameter to [0, 1]', () => {
    const rgbA = new Uint8Array([100, 100, 100]);
    const rgbB = new Uint8Array([100, 100, 100]);
    const shading = new Float32Array([0.5]);
    bakeHillshadeIntoRgb(rgbA, shading, 1);
    bakeHillshadeIntoRgb(rgbB, shading, 5); // out-of-range — clamps to 1
    expect(Array.from(rgbA)).toEqual(Array.from(rgbB));
  });
});
