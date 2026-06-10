/**
 * terrainTruth.hillshade.test.ts — known-truth analytical hillshade.
 *
 * Pins the exact flat-plane Lambert value for a known sun altitude and the
 * brighter/darker ORDERING for slopes facing toward / away from the sun, and
 * for N/E/S/W-facing slopes under a fixed azimuth. The ESRI illumination model
 * and the north-clockwise -> math azimuth convention are exercised end to end.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { computeHillshade } from '../src/terrain/surface/hillshade';
import { flatPlane, uniformSlope, allGround, gridFor } from './fixtures/terrainScenes';

const EXTENT = { nx: 16, ny: 16, spacing: 1 } as const;
const grid = gridFor(EXTENT);
const fullCov = new Uint8Array(grid.cols * grid.rows).fill(1);

function shadeOf(pts: ReadonlyArray<{ x: number; y: number; z: number }>, params: {
  azimuthDeg: number;
  altitudeDeg: number;
}): Uint8Array {
  const r = rasterizeDtm(pts, allGround(pts), { grid });
  return computeHillshade(r.z, grid.cols, grid.rows, grid.cellSizeM, fullCov, params).shade;
}

const centre = 8 * grid.cols + 8; // interior cell

describe('Hillshade truth — flat plane is uniform Lambert shading', () => {
  it('flat plane at altitude 45 -> shade = round(255*cos(45)) = 180', () => {
    const shade = shadeOf(flatPlane(30, EXTENT), { azimuthDeg: 315, altitudeDeg: 45 });
    const expected = Math.round(255 * Math.cos((45 * Math.PI) / 180)); // 180
    for (let r = 1; r < grid.rows - 1; r++) {
      for (let c = 1; c < grid.cols - 1; c++) {
        expect(Math.abs(shade[r * grid.cols + c] - expected)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('flat plane at altitude 30 -> shade = round(255*cos(60)) = 128', () => {
    const shade = shadeOf(flatPlane(0, EXTENT), { azimuthDeg: 315, altitudeDeg: 30 });
    const expected = Math.round(255 * Math.cos((60 * Math.PI) / 180)); // 128
    expect(Math.abs(shade[centre] - expected)).toBeLessThanOrEqual(1);
  });
});

describe('Hillshade truth — a slope facing the sun is brighter than one facing away', () => {
  it('sun in the east (az 90): an east-facing downslope outshines a west-facing one', () => {
    // axis x, gradient +0.5 RISES east -> downhill faces WEST (away from an east sun).
    const facingAway = shadeOf(uniformSlope({ ...EXTENT, gradient: 0.5, axis: 'x' }), {
      azimuthDeg: 90,
      altitudeDeg: 45,
    });
    // gradient -0.5 falls east -> downhill faces EAST (toward the east sun).
    const facingSun = shadeOf(uniformSlope({ ...EXTENT, gradient: -0.5, axis: 'x' }), {
      azimuthDeg: 90,
      altitudeDeg: 45,
    });
    expect(facingSun[centre]).toBeGreaterThan(facingAway[centre]);
    // The lit slope is brighter than flat Lambert (180); the shadowed one dimmer.
    expect(facingSun[centre]).toBeGreaterThan(180);
    expect(facingAway[centre]).toBeLessThan(180);
  });
});

describe('Hillshade truth — N/E/S/W-facing slopes shade as the azimuth predicts', () => {
  // Build the four cardinal downslopes. Downhill direction = aspect.
  // Grids are NORTHING-UP (row+1 = north, +y = north), so a surface that
  // FALLS with y descends to the north (faces north):
  //   downhill E: z falls with x (gradient -0.5, axis x)
  //   downhill W: z rises with x (gradient +0.5, axis x)
  //   downhill N: z falls with y (gradient -0.5, axis y)
  //   downhill S: z rises with y (gradient +0.5, axis y)
  // (Pre-v0.4.4 these N/S fixtures were swapped, encoding the mirrored
  // +y = south convention the aspect bug compensated for.)
  const G = 0.5;
  const slopes = {
    E: uniformSlope({ ...EXTENT, gradient: -G, axis: 'x' }),
    W: uniformSlope({ ...EXTENT, gradient: +G, axis: 'x' }),
    N: uniformSlope({ ...EXTENT, gradient: -G, axis: 'y' }),
    S: uniformSlope({ ...EXTENT, gradient: +G, axis: 'y' }),
  };

  it('sun due east (az 90): E-facing brightest, W-facing darkest, N/S equal between', () => {
    const opts = { azimuthDeg: 90, altitudeDeg: 45 } as const;
    const e = shadeOf(slopes.E, opts)[centre];
    const w = shadeOf(slopes.W, opts)[centre];
    const n = shadeOf(slopes.N, opts)[centre];
    const s = shadeOf(slopes.S, opts)[centre];
    // E faces the sun -> brightest; W faces away -> darkest.
    expect(e).toBeGreaterThan(n);
    expect(e).toBeGreaterThan(s);
    expect(w).toBeLessThan(n);
    expect(w).toBeLessThan(s);
    // N and S are perpendicular to an east sun -> equal shading.
    expect(Math.abs(n - s)).toBeLessThanOrEqual(1);
    // Pin the analytic values verified against the ESRI model (tol 1).
    expect(Math.abs(e - 242)).toBeLessThanOrEqual(1);
    expect(Math.abs(w - 81)).toBeLessThanOrEqual(1);
    expect(Math.abs(n - 161)).toBeLessThanOrEqual(1);
  });

  it('sun in the NW (az 315, the default): W- and N-facing slopes outshine E/S', () => {
    const opts = { azimuthDeg: 315, altitudeDeg: 45 } as const;
    const e = shadeOf(slopes.E, opts)[centre];
    const w = shadeOf(slopes.W, opts)[centre];
    const n = shadeOf(slopes.N, opts)[centre];
    const s = shadeOf(slopes.S, opts)[centre];
    // Math azimuth of a NW (315) sun is 135 deg; W (aspect 180) and N (aspect
    // 90) are equidistant from it -> equally bright, and brighter than E/S.
    expect(w).toBeGreaterThan(e);
    expect(w).toBeGreaterThan(s);
    expect(n).toBeGreaterThan(e);
    expect(n).toBeGreaterThan(s);
    expect(Math.abs(w - n)).toBeLessThanOrEqual(1); // symmetric about 135 deg
    expect(Math.abs(e - s)).toBeLessThanOrEqual(1);
    // Pin verified values.
    expect(Math.abs(w - 218)).toBeLessThanOrEqual(1);
    expect(Math.abs(e - 104)).toBeLessThanOrEqual(1);
  });

  it('regression: a plane descending to the NORTH is lit by the default NW sun', () => {
    // The v0.4.3 aspect bug mirrored hillshade north-south: a north-facing
    // slope rendered as if it faced south, so the default 315 deg (NW) sun
    // shadowed it. With the northing-up convention fixed, the north-facing
    // plane (z falls as y/northing grows) must be brighter than the
    // south-facing one, and brighter than flat Lambert (180 at altitude 45).
    const opts = { azimuthDeg: 315, altitudeDeg: 45 } as const;
    const northFacing = shadeOf(slopes.N, opts)[centre];
    const southFacing = shadeOf(slopes.S, opts)[centre];
    expect(northFacing).toBeGreaterThan(southFacing);
    expect(northFacing).toBeGreaterThan(180);
    expect(southFacing).toBeLessThan(180);
  });
});
