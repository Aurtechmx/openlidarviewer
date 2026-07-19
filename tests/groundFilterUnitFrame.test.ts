/**
 * groundFilterUnitFrame.test.ts
 *
 * Unit-frame invariance of the SMRF classifier: the same physical surface
 * must classify the same whether its horizontal coordinates arrive in
 * metres (projected) or in degrees (geographic, EPSG:4326) with metric z.
 * The slope-scaled threshold `dh = elevationThresholdM + slope · b ·
 * cellSize` multiplies a rise/run ratio by a horizontal run, so that run
 * must be denominated in z's unit — fed the raw degree-valued cell size it
 * is ~1/111,320 of the metric run, dh stays pinned at its base, and
 * legitimate slope ground is rejected. The pipeline explicitly supports
 * geographic frames (the cos φ machinery exists for them), so this is a
 * correctness contract, not an exotic edge case.
 */

import { describe, it, expect } from 'vitest';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import { resolveGroundFilterParams } from '../src/terrain/contour/analyseContours';
import { METRES_PER_DEGREE } from '../src/terrain/ground/horizontalScale';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/**
 * A bare planar 20 % slope, 100 × 100 m at 1 m spacing, z metric in both
 * frames. Points sit at half-metre offsets so cell assignment cannot
 * straddle a floating-point cell boundary differently per frame.
 */
function slopeScene(scale: number): TerrainPoint[] {
  const points: TerrainPoint[] = [];
  for (let i = 0; i < 100; i++) {
    for (let j = 0; j < 100; j++) {
      const xM = i + 0.5;
      const yM = j + 0.5;
      points.push({ x: xM * scale, y: yM * scale, z: 0.2 * xM });
    }
  }
  return points;
}

/** Fraction of returns the pipeline-default SMRF pass calls ground. */
function groundFraction(points: TerrainPoint[], cellSizeM: number, isGeographic: boolean): number {
  const params = resolveGroundFilterParams(
    {
      cellSizeM,
      isGeographic,
      latitudeDeg: isGeographic ? 0 : null,
      verticalUnitToMetres: 1,
      horizontalUnitToMetres: 1,
    },
    'z',
  );
  const gf = classifyGroundSmrf(points, params);
  return gf.sourcePointCount > 0 ? gf.groundPointCount / gf.sourcePointCount : Number.NaN;
}

describe('classifyGroundSmrf — geographic (degree) frame parity', () => {
  it('classifies a metric-z planar slope identically in metre and degree frames', () => {
    // Same surface twice: projected metres, and EPSG:4326-style degrees
    // (x,y ÷ metres-per-degree) with z still in metres. One grid cell per
    // ground metre in both frames.
    const metreFrac = groundFraction(slopeScene(1), 1, false);
    const degreeFrac = groundFraction(slopeScene(1 / METRES_PER_DEGREE), 1 / METRES_PER_DEGREE, true);

    // A bare planar slope is all ground; the metre frame must say so.
    expect(metreFrac).toBeGreaterThan(0.99);
    // The degree frame sees the identical surface, so it must agree.
    expect(Math.abs(metreFrac - degreeFrac)).toBeLessThan(0.02);
  });
});
