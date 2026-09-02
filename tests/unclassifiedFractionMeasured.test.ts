/**
 * unclassifiedFractionMeasured.test.ts
 *
 * The fitness panel's Classification dimension reports a MEASURED share of
 * ASPRS 0/1 returns. It previously received a hardcoded 0 whenever a
 * classification attribute existed, which scored `ready` and printed
 * "0% unclassified" on a raw airborne tile that was 95% code 1.
 */

import { describe, it, expect } from 'vitest';
import { computeTerrainCore, type TerrainCoreParams } from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const CELL = 2;

/** A tilted ground plane, `groundShare` of it classified 2 and the rest 1. */
function tile(groundShare: number): { points: TerrainPoint[]; classification: number[] } {
  const points: TerrainPoint[] = [];
  for (let iy = 0; iy < 30; iy++) {
    for (let ix = 0; ix < 30; ix++) {
      points.push({ x: ix * CELL, y: iy * CELL, z: 100 + ix * 0.05 - iy * 0.03 });
    }
  }
  const cut = Math.round(points.length * groundShare);
  const classification = points.map((_, i) => (i < cut ? 2 : 1));
  return { points, classification };
}

const BASE: TerrainCoreParams = {
  cellSizeM: CELL,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
  trustGroundClassification: true,
};

describe('unclassifiedFraction', () => {
  it('measures the ASPRS 0/1 share rather than reporting presence', () => {
    // The shape of a raw airborne tile: a thin ground return, the rest code 1.
    const { points, classification } = tile(0.05);
    const core = computeTerrainCore(points, { ...BASE, classification });
    expect(core.unclassifiedFraction).toBeCloseTo(0.95, 2);
  });

  it('reports a fully producer-classified scan as none unclassified', () => {
    const { points, classification } = tile(1);
    const core = computeTerrainCore(points, { ...BASE, classification });
    expect(core.unclassifiedFraction).toBe(0);
  });

  it('counts code 0 (created, never classified) as unclassified too', () => {
    const { points } = tile(1);
    const classification = points.map((_, i) => (i % 2 === 0 ? 0 : 2));
    const core = computeTerrainCore(points, { ...BASE, classification });
    expect(core.unclassifiedFraction).toBeCloseTo(0.5, 2);
  });

  it('is null when the scan carries no classification at all', () => {
    const { points } = tile(1);
    const core = computeTerrainCore(points, BASE);
    expect(core.unclassifiedFraction).toBeNull();
  });
});
