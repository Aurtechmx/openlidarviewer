/**
 * blockedCvSurfaceParity.test.ts — the blocked hold-out scores the shipped
 * surface.
 *
 * dtmParity.test.ts proves an EXPLICITLY-configured DtmSurfaceModel rebuilds
 * the delivered DTM. This suite guards the other half: the options
 * `computeTerrainCore` hands its INTERNAL blocked-hold-out model must carry
 * the same `despike` and `verticalUnitToMetres` the shipped surface used —
 * dtmSurfaceModel.ts documents both as MUST-match, or every fold scores a
 * surface the viewer never delivered.
 *
 * The seam is pinned directly rather than through the blocked RMSE, because
 * the statistic confounds the two effects: geometry the despike would remove
 * is also geometry a held-out block cannot predict, so a despiking fold and an
 * extrapolating fold inflate the same number.
 */

import { describe, it, expect } from 'vitest';
import {
  computeTerrainCore,
  blockedHoldoutModelOptions,
  type TerrainCoreParams,
} from '../src/terrain/contour/analyseContours';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const CELL_SIZE_M = 2;

/** A smooth tilted plane of genuine class-2 ground, dense enough (900 points)
 *  to clear the blocked hold-out's 32-point floor. */
function class2Cloud(): { points: TerrainPoint[]; classification: number[] } {
  const points: TerrainPoint[] = [];
  for (let iy = 0; iy < 30; iy++) {
    for (let ix = 0; ix < 30; ix++) {
      const x = ix * CELL_SIZE_M + ((ix * 7 + iy * 3) % 5) * 0.13;
      const y = iy * CELL_SIZE_M + ((ix * 5 + iy * 11) % 5) * 0.17;
      points.push({ x, y, z: 100 + x * 0.05 - y * 0.03 });
    }
  }
  return { points, classification: points.map(() => 2) };
}

const GRID = { originH1: 0, originH2: 0, cols: 30, rows: 30, cellSizeM: CELL_SIZE_M };

describe('blockedHoldoutModelOptions', () => {
  it('carries the shipped despike decision through to the fold builds', () => {
    // Trusted path: despike OFF. A fold that despikes would flatten the steep
    // survey nodes the trusted path exists to keep.
    const trusted = blockedHoldoutModelOptions(GRID, 'median', false, {});
    expect(trusted.despike).toBe(false);
    // Untrusted path: despike ON, mirrored the same way.
    const untrusted = blockedHoldoutModelOptions(GRID, 'median', true, {});
    expect(untrusted.despike).toBe(true);
  });

  it('carries the vertical scale, so a foot scan is not validated in metres', () => {
    const opts = blockedHoldoutModelOptions(GRID, 'median', true, {
      verticalUnitToMetres: 0.3048,
    });
    expect(opts.verticalUnitToMetres).toBeCloseTo(0.3048, 10);
  });

  it('mirrors every remaining MUST-match field of the shipped build', () => {
    const opts = blockedHoldoutModelOptions(GRID, 'mean', false, {
      isGeographic: true,
      latitudeDeg: 47.5,
      horizontalUnitToMetres: 111320,
    });
    expect(opts.aggregation).toBe('mean');
    expect(opts.isGeographic).toBe(true);
    expect(opts.latitudeDeg).toBe(47.5);
    expect(opts.horizontalUnitToMetres).toBe(111320);
    expect(opts.grid).toEqual(GRID);
  });
});

describe('computeTerrainCore blocked hold-out', () => {
  it('produces a blocked estimate on the trusted path with the despike off', () => {
    const { points, classification } = class2Cloud();
    const core = computeTerrainCore(points, {
      cellSizeM: CELL_SIZE_M,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      trustGroundClassification: true,
      classification,
    } satisfies TerrainCoreParams & { classification: number[] });
    expect(core.despikeApplied).toBe(false);
    expect(core.blockedAccuracy).not.toBeNull();
    // On a plane both fold styles rebuild exactly, so the estimate is small;
    // this is a sanity floor, not the seam guard above.
    expect(core.blockedAccuracy!.rmse).toBeLessThan(0.25);
  });
});
