/**
 * contourAdaptiveGeneralize.test.ts
 *
 * Terrain-aware generalization (spec §16.1/§16.2): the per-feature tolerance
 * factor smooths supported/long lines more and interpolated/low-confidence/small
 * rings less, within a bounded band — and it delegates to the shared generalizer
 * so the analytical product stays immutable.
 */

import { describe, it, expect } from 'vitest';
import {
  adaptiveToleranceFactor,
  terrainAwareCartographicProduct,
} from '../src/terrain/contourStudio/contourAdaptiveGeneralize';
import { analyticalProduct } from '../src/terrain/contourStudio/contourGeometryProduct';
import type { ContourFeature } from '../src/terrain/contour/contourFeatureModel';
import { knownUnit } from '../src/units/units';

function feature(coords: Array<[number, number]>, over: Partial<ContourFeature> = {}): ContourFeature {
  return {
    value: 10, isIndex: false, grade: 'solid', meanConfidence: 90, closed: false, coordinates: coords, ...over,
  } as ContourFeature;
}

const band = { longFeatureLen: 100, smallRingLen: 5 };

describe('adaptiveToleranceFactor', () => {
  it('is 1 for an average measured, medium-length line', () => {
    const f = feature([[0, 0], [10, 0], [20, 0]]); // length 20, solid, not long
    expect(adaptiveToleranceFactor(f, band)).toBeCloseTo(1, 9);
  });

  it('smooths interpolated support less (< 1)', () => {
    const f = feature([[0, 0], [10, 0], [20, 0]], { grade: 'dashed' });
    expect(adaptiveToleranceFactor(f, band)).toBeLessThan(1);
  });

  it('smooths a small closed ring least (fidelity preserved)', () => {
    const ring = feature([[0, 0], [1, 1], [2, 0], [1, -1], [0, 0]], { closed: true }); // len ~5.66
    expect(adaptiveToleranceFactor(ring, { longFeatureLen: 100, smallRingLen: 10 })).toBeLessThan(0.5);
  });

  it('smooths a long strongly-measured line more (> 1)', () => {
    const longLine = feature([[0, 0], [200, 0]], { grade: 'solid' }); // length 200 >= longFeatureLen
    expect(adaptiveToleranceFactor(longLine, band)).toBeGreaterThan(1);
  });

  it('stays within the bounded band [0.25, 2]', () => {
    const worst = feature([[0, 0], [1, 1], [2, 0], [1, -1], [0, 0]], { closed: true, grade: 'gap', meanConfidence: 10 });
    const f = adaptiveToleranceFactor(worst, band);
    expect(f).toBeGreaterThanOrEqual(0.25);
    expect(f).toBeLessThanOrEqual(2);
  });
});

describe('terrainAwareCartographicProduct', () => {
  const jagged = feature([[0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1], [6, 0]], { grade: 'dashed' });
  const analytical = analyticalProduct([jagged]);

  it('produces a cartographic product referencing the analytical hash', () => {
    const carto = terrainAwareCartographicProduct(analytical, { baseToleranceSource: 2, horizontalUnit: knownUnit(1) });
    expect(carto.role).toBe('cartographic-generalization');
    expect(carto.sourceAnalyticalHash).toBe(analytical.contentHash);
    expect(carto.generalization?.methodId).toContain('terrain-adaptive');
  });

  it('does not mutate the analytical product', () => {
    const before = analytical.features[0].coordinates.map((p) => [...p]);
    terrainAwareCartographicProduct(analytical, { baseToleranceSource: 5, horizontalUnit: knownUnit(1) });
    expect(analytical.features[0].coordinates).toEqual(before);
  });

  it('an interpolated line keeps more vertices than a measured line at the same base tolerance', () => {
    const base = 1.5;
    const measured = analyticalProduct([feature([[0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1], [6, 0]], { grade: 'solid' })]);
    const interp = analyticalProduct([feature([[0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1], [6, 0]], { grade: 'dashed' })]);
    const cM = terrainAwareCartographicProduct(measured, { baseToleranceSource: base, horizontalUnit: knownUnit(1), longFeatureLen: 1000, smallRingLen: 0 });
    const cI = terrainAwareCartographicProduct(interp, { baseToleranceSource: base, horizontalUnit: knownUnit(1), longFeatureLen: 1000, smallRingLen: 0 });
    // Interpolated → smaller tolerance → keeps at least as many vertices.
    expect(cI.features[0].coordinates.length).toBeGreaterThanOrEqual(cM.features[0].coordinates.length);
  });
});
