/**
 * contourGeometryProduct.test.ts
 *
 * The analytical/cartographic split (spec §15.4): analytical geometry is exact
 * and immutable under cartographic settings, cartographic references the
 * analytical hash and is never labelled exact, separate features (gaps) are not
 * bridged, and the generalization record carries honest displacement stats.
 */

import { describe, it, expect } from 'vitest';
import {
  analyticalProduct,
  cartographicProduct,
  isExactGeometry,
} from '../src/terrain/contourStudio/contourGeometryProduct';
import type { ContourFeature } from '../src/terrain/contour/contourFeatureModel';
import { knownUnit, unknownUnit } from '../src/units/units';

function feature(coords: Array<[number, number]>, over: Partial<ContourFeature> = {}): ContourFeature {
  return {
    value: 10,
    isIndex: false,
    grade: 'solid',
    meanConfidence: 90,
    closed: false,
    coordinates: coords,
    ...over,
  } as ContourFeature;
}

// A jagged line whose interior vertices deviate ~1 unit from the straight chord.
const jagged = feature([
  [0, 0], [1, 1], [2, 0], [3, 1], [4, 0], [5, 1], [6, 0],
]);

describe('analyticalProduct', () => {
  it('is exact, unsmoothed, with no generalization and no source hash', () => {
    const a = analyticalProduct([jagged]);
    expect(a.role).toBe('analytical-isoline');
    expect(isExactGeometry(a)).toBe(true);
    expect(a.generalization).toBeNull();
    expect(a.sourceAnalyticalHash).toBeNull();
    expect(a.features[0].coordinates).toEqual(jagged.coordinates);
  });

  it('hash is stable for equal geometry and differs when geometry changes', () => {
    expect(analyticalProduct([jagged]).contentHash).toBe(analyticalProduct([jagged]).contentHash);
    const moved = feature([[0, 0], [1, 5], [2, 0]]);
    expect(analyticalProduct([moved]).contentHash).not.toBe(analyticalProduct([jagged]).contentHash);
  });
});

describe('cartographicProduct', () => {
  const analytical = analyticalProduct([jagged]);

  it('is a generalization, references the analytical hash, and is not exact', () => {
    const carto = cartographicProduct(analytical, { toleranceSource: 2, horizontalUnit: knownUnit(1) });
    expect(carto.role).toBe('cartographic-generalization');
    expect(isExactGeometry(carto)).toBe(false);
    expect(carto.sourceAnalyticalHash).toBe(analytical.contentHash);
    expect(carto.generalization).not.toBeNull();
  });

  it('does NOT mutate the analytical product', () => {
    const before = analytical.features[0].coordinates.map((p) => [...p]);
    cartographicProduct(analytical, { toleranceSource: 5, horizontalUnit: knownUnit(1) });
    expect(analytical.features[0].coordinates).toEqual(before);
    expect(analytical.role).toBe('analytical-isoline');
  });

  it('actually simplifies at a large tolerance (fewer vertices)', () => {
    const carto = cartographicProduct(analytical, { toleranceSource: 5, horizontalUnit: knownUnit(1) });
    expect(carto.features[0].coordinates.length).toBeLessThan(jagged.coordinates.length);
  });

  it('records displacement within the tolerance and a metre-equivalent when known', () => {
    const carto = cartographicProduct(analytical, { toleranceSource: 2, horizontalUnit: knownUnit(0.3048) });
    const g = carto.generalization!;
    expect(g.maxDisplacementSource).toBeGreaterThanOrEqual(0);
    expect(g.p95DisplacementSource).toBeGreaterThanOrEqual(0);
    expect(g.meanDisplacementSource).toBeLessThanOrEqual(g.maxDisplacementSource);
    expect(g.toleranceMetres).toBeCloseTo(2 * 0.3048, 9);
  });

  it('reports null metre tolerance when the horizontal unit is unknown', () => {
    const carto = cartographicProduct(analytical, { toleranceSource: 2, horizontalUnit: unknownUnit() });
    expect(carto.generalization!.toleranceMetres).toBeNull();
  });

  it('does not bridge gaps: two separate features stay two features', () => {
    const a = feature([[0, 0], [1, 0], [2, 0]]);
    const b = feature([[10, 0], [11, 0], [12, 0]]); // a gap away from `a`
    const analyticalTwo = analyticalProduct([a, b]);
    const carto = cartographicProduct(analyticalTwo, { toleranceSource: 5, horizontalUnit: knownUnit(1) });
    expect(carto.features).toHaveLength(2);
  });

  it('flags topology change when a closed ring collapses below a triangle', () => {
    const tinyRing = feature([[0, 0], [0.1, 0.1], [0.2, 0], [0.1, -0.1], [0, 0]], { closed: true });
    const carto = cartographicProduct(analyticalProduct([tinyRing]), {
      toleranceSource: 100, // absurd tolerance collapses the ring
      horizontalUnit: knownUnit(1),
    });
    expect(carto.generalization!.topologyPreserved).toBe(false);
  });

  it('rejects a non-positive or non-finite tolerance', () => {
    expect(() => cartographicProduct(analytical, { toleranceSource: 0, horizontalUnit: knownUnit(1) })).toThrow(/positive/i);
    expect(() => cartographicProduct(analytical, { toleranceSource: Number.NaN, horizontalUnit: knownUnit(1) })).toThrow();
  });
});
