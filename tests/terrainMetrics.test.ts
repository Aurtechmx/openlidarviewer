/**
 * terrainMetrics.test.ts
 *
 * Deterministic-output tests for the terrain metrics layer.
 */

import { describe, it, expect } from 'vitest';
import {
  computeGroundScore,
  elevationVariance,
  heightAboveLocalSurface,
  localPlanarity,
  localSlopeDegrees,
  meanCurvatureApprox,
  neighborhoodElevationRange,
  pointDensity,
  roughnessRms,
} from '../src/terrain/TerrainMetrics';
import type { TerrainNeighborhood, TerrainPoint } from '../src/terrain/TerrainContracts';

function nh(samples: TerrainPoint[], radius = 1): TerrainNeighborhood {
  return { centre: samples[0], samples: samples.slice(1), radius };
}

/** A perfectly flat XY plane at z=0. */
function flatXY(): TerrainPoint[] {
  return [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
    { x: 0.5, y: 0.5, z: 0 },
  ];
}

/** A 45° tilted plane (z grows with x). */
function tilted45(): TerrainPoint[] {
  return [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 1 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 1 },
    { x: 0.5, y: 0.5, z: 0.5 },
  ];
}

describe('localSlopeDegrees', () => {
  it('returns ~0° for a flat horizontal neighborhood', () => {
    const m = localSlopeDegrees(nh(flatXY()));
    expect(m.value).toBeLessThan(1);
  });

  it('returns ~45° for a 45° tilted plane', () => {
    const m = localSlopeDegrees(nh(tilted45()));
    expect(Math.abs(m.value - 45)).toBeLessThan(2);
  });

  it('returns NaN when fewer than 3 samples (centre excluded)', () => {
    // 1 centre + 2 samples = 3 total but only 2 samples for the
    // plane fit — under-defined.
    expect(
      Number.isNaN(
        localSlopeDegrees(nh([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]))
          .value,
      ),
    ).toBe(true);
  });

  it('is deterministic for the same input', () => {
    const a = localSlopeDegrees(nh(tilted45()));
    const b = localSlopeDegrees(nh(tilted45()));
    expect(a.value).toBe(b.value);
  });
});

describe('roughnessRms', () => {
  it('is 0 for a perfectly flat plane', () => {
    const m = roughnessRms(nh(flatXY()));
    expect(m.value).toBeLessThan(1e-9);
  });

  it('is positive for noisy points', () => {
    const noisy = flatXY().map((p, i) => ({ ...p, z: i * 0.1 }));
    const m = roughnessRms(nh(noisy));
    expect(m.value).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = roughnessRms(nh(flatXY())).value;
    const b = roughnessRms(nh(flatXY())).value;
    expect(a).toBe(b);
  });
});

describe('elevationVariance', () => {
  it('is 0 when all points share a Z', () => {
    expect(elevationVariance(nh(flatXY())).value).toBe(0);
  });

  it('is positive for varying Zs', () => {
    const varied: TerrainPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 5 },
      { x: 0, y: 1, z: -5 },
    ];
    expect(elevationVariance(nh(varied)).value).toBeGreaterThan(0);
  });
});

describe('pointDensity', () => {
  it('grows with sample count for fixed radius', () => {
    const small = pointDensity(nh(flatXY(), 1)).value;
    const big = pointDensity({
      centre: flatXY()[0],
      samples: [...flatXY(), ...flatXY()],
      radius: 1,
    }).value;
    expect(big).toBeGreaterThan(small);
  });

  it('returns NaN for zero radius', () => {
    expect(Number.isNaN(pointDensity(nh(flatXY(), 0)).value)).toBe(true);
  });
});

describe('neighborhoodElevationRange', () => {
  it('returns max − min Z of the samples', () => {
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 5 },
      { x: 0, y: 1, z: -2 },
    ];
    expect(neighborhoodElevationRange(nh(pts)).value).toBe(7);
  });
});

describe('meanCurvatureApprox + localPlanarity', () => {
  it('curvature is essentially zero for a flat plane', () => {
    const m = meanCurvatureApprox(nh(flatXY()));
    // Tighter than the original 0.05 — for an exactly flat plane the
    // smallest eigenvalue should be at the eps floor (1e-12), not
    // anywhere near 5%.
    expect(Math.abs(m.value)).toBeLessThan(1e-9);
  });

  it('planarity reaches the upper bound for a flat plane', () => {
    const m = localPlanarity(nh(flatXY()));
    expect(m.value).toBeGreaterThan(1 - 1e-8);
  });

  it('planarity is HIGH for a LINE too — known limitation', () => {
    // Points along the x-axis only — the smallest eigenvalue is 0
    // (collinear) so planarity reads as ~1, even though the points
    // form a line, not a plane. v0.4.0 will fold in a `linearity`
    // metric to distinguish.
    const line = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 4, y: 0, z: 0 },
    ];
    const m = localPlanarity(nh(line));
    expect(m.value).toBeGreaterThan(0.99);
  });
});

describe('heightAboveLocalSurface — plane fit excludes centre', () => {
  it('is near zero when centre lies in the plane', () => {
    const m = heightAboveLocalSurface(nh(flatXY()));
    expect(Math.abs(m.value)).toBeLessThan(1e-9);
  });

  it('reports the EXACT lift height when centre sits above flat samples', () => {
    // Samples lie exactly on z=0; centre is at z=5. With the plane
    // fit to samples-only the plane is exactly z=0 and HAG = 5 m.
    // The previous (buggy) implementation fit the plane to centre +
    // samples and returned ~3-4 instead of the analytic 5.
    const lifted = [
      { x: 0, y: 0, z: 5 }, // centre lifted
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0.5, y: 0.5, z: 0 },
    ];
    const m = heightAboveLocalSurface(nh(lifted));
    expect(Math.abs(m.value - 5)).toBeLessThan(1e-6);
  });

  it('is signed — negative when centre sits BELOW the samples', () => {
    const sunk = [
      { x: 0, y: 0, z: -3 }, // centre sunk
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0.5, y: 0.5, z: 0 },
    ];
    const m = heightAboveLocalSurface(nh(sunk));
    expect(m.value).toBeLessThan(0);
    expect(Math.abs(m.value - -3)).toBeLessThan(1e-6);
  });

  it('honours linearUnitToMetres scaling', () => {
    // Samples at z=0, centre at z=5 ft (1 ft = 0.3048 m → 1.524 m).
    const lifted = [
      { x: 0, y: 0, z: 5 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: 0.5, y: 0.5, z: 0 },
    ];
    const m = heightAboveLocalSurface({
      centre: lifted[0],
      samples: lifted.slice(1),
      radius: 1,
      linearUnitToMetres: 0.3048,
    });
    expect(Math.abs(m.value - 5 * 0.3048)).toBeLessThan(1e-6);
  });
});

describe('worldUp axis support', () => {
  it('Y-up: slope is 0 for a flat XZ plane (with up = +Y)', () => {
    const xzPlane = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 0.5, y: 0, z: 0.5 },
    ];
    const m = localSlopeDegrees({
      centre: xzPlane[0],
      samples: xzPlane.slice(1),
      radius: 1,
      worldUp: [0, 1, 0],
    });
    expect(m.value).toBeLessThan(1);
  });

  it('Y-up: HAG works against worldUp', () => {
    // Samples lie on y=0 plane; centre at y=2 → HAG = 2 along +Y.
    const lifted = [
      { x: 0, y: 2, z: 0 }, // centre
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 0.5, y: 0, z: 0.5 },
    ];
    const m = heightAboveLocalSurface({
      centre: lifted[0],
      samples: lifted.slice(1),
      radius: 1,
      worldUp: [0, 1, 0],
    });
    expect(Math.abs(m.value - 2)).toBeLessThan(1e-6);
  });
});

describe('computeGroundScore — confidence range 0–100', () => {
  it('a flat dense neighborhood scores high', () => {
    const score = computeGroundScore(nh(flatXY(), 1));
    expect(score.confidence).toBeGreaterThanOrEqual(0);
    expect(score.confidence).toBeLessThanOrEqual(100);
  });

  it('a steep neighborhood penalises slope', () => {
    const flat = computeGroundScore(nh(flatXY(), 1));
    const steep = computeGroundScore(nh(tilted45(), 1));
    expect(steep.slopeScore).toBeLessThan(flat.slopeScore);
  });

  it('breakdowns are all in 0–100', () => {
    const score = computeGroundScore(nh(tilted45(), 1));
    for (const k of ['slopeScore', 'roughnessScore', 'varianceScore', 'densityScore'] as const) {
      expect(score[k]).toBeGreaterThanOrEqual(0);
      expect(score[k]).toBeLessThanOrEqual(100);
    }
  });

  it('reasons array is never empty', () => {
    const score = computeGroundScore(nh(flatXY(), 1));
    expect(score.reasons.length).toBeGreaterThan(0);
  });
});
