/**
 * terrainReadiness.test.ts — readiness indicators over real pipeline output.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { computeTerrainReadiness, type ReadinessRating } from '../src/terrain/contour/terrainReadiness';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const RATINGS: ReadinessRating[] = ['excellent', 'strong', 'good', 'moderate', 'weak', 'unavailable'];

/** Dense ground on a gentle tilted plane: z = 0.1*x over a 40x40 m patch. */
function densePlane(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 40; x += 1) {
    for (let y = 0; y <= 40; y += 1) {
      pts.push({ x, y, z: 0.1 * x });
    }
  }
  return pts;
}

describe('computeTerrainReadiness', () => {
  it('rates a dense, well-sampled plane as ready with valid indicators', () => {
    const result = analyseContours(densePlane(), { cellSizeM: 2, crs: 'EPSG:32610' });
    const r = computeTerrainReadiness(result);

    for (const ind of [r.groundConfidence, r.dtmQuality, r.contourReadiness]) {
      expect(RATINGS).toContain(ind.rating);
      expect(ind.value.length).toBeGreaterThan(0);
      expect(ind.detail.length).toBeGreaterThan(0);
    }
    // A fully-sampled patch should be dominated by MEASURED cells.
    expect(r.dtmQuality.value).toMatch(/measured/);
    expect(r.dtmQuality.rating).not.toBe('weak');
    // Ground confidence is a percentage.
    expect(r.groundConfidence.value).toMatch(/%|—/);
  });

  it('reports unavailable contour readiness when no points are given', () => {
    const result = analyseContours([], { cellSizeM: 2, crs: 'EPSG:32610' });
    const r = computeTerrainReadiness(result);
    expect(r.contoursRecommended).toBe(false);
    expect(r.contourReadiness.rating).toBe('unavailable');
    expect(r.contourReadiness.value).toBe('Not ready');
  });

  it('tempers ground confidence when the surface is mostly interpolated', () => {
    // A handful of scattered points → lots of interpolation/gap, so even
    // if measured cells look confident the overall ground rating should
    // not be "excellent".
    const sparse: TerrainPoint[] = [
      { x: 0, y: 0, z: 0 },
      { x: 30, y: 0, z: 3 },
      { x: 0, y: 30, z: 0 },
      { x: 30, y: 30, z: 3 },
    ];
    const result = analyseContours(sparse, { cellSizeM: 2, crs: 'EPSG:32610' });
    const r = computeTerrainReadiness(result);
    expect(r.groundConfidence.rating).not.toBe('excellent');
  });
});
