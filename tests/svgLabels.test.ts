/**
 * svgLabels.test.ts — SVG export draws elevation labels with a halo.
 */

import { describe, it, expect } from 'vitest';
import { svgContours } from '../src/terrain/contour/svgContours';
import type { ContourFeature, ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { ContourLabel } from '../src/terrain/contour/labelPlacement';

function model(): ContourFeatureModel {
  const features: ContourFeature[] = [
    { value: 10, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [10, 0]] },
  ];
  return {
    features,
    crs: 'EPSG:32610',
    verticalDatum: null,
    intervalM: 1,
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 0 },
    interpolatedFraction: 0,
    warnings: [],
  };
}

describe('svgContours labels', () => {
  it('renders a haloed elevation label when labels are supplied', () => {
    const labels: ContourLabel[] = [{ x: 5, y: 0, angleRad: 0, value: 10 }];
    const svg = svgContours(model(), { labels });
    expect(svg).toMatch(/<text/);
    expect(svg).toMatch(/paint-order:stroke/);
    expect(svg).toMatch(/>10<\/text>/); // the elevation value
  });

  it('omits labels when none are supplied', () => {
    const svg = svgContours(model());
    expect(svg).not.toMatch(/<text/);
  });

  it('keeps labels upright (no near-180° rotation)', () => {
    // A label whose contour runs right-to-left would otherwise be upside down.
    const labels: ContourLabel[] = [{ x: 5, y: 0, angleRad: Math.PI, value: 10 }];
    const svg = svgContours(model(), { labels });
    const m = svg.match(/rotate\(([-0-9.]+)/);
    expect(m).not.toBeNull();
    const deg = Math.abs(parseFloat(m![1]));
    expect(deg).toBeLessThanOrEqual(90.001);
  });
});
