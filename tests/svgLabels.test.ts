/**
 * svgLabels.test.ts — the SVG export renders a topographic SHEET: haloed
 * elevation labels, plus the cartographic furniture a field deliverable
 * carries (neat-line, graphic scale bar, north arrow, line-grade legend, and a
 * title block whose interval line is always present).
 */

import { describe, it, expect } from 'vitest';
import { svgContours } from '../src/terrain/contour/svgContours';
import type { ContourFeature, ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { ContourLabel } from '../src/terrain/contour/labelPlacement';

function model(): ContourFeatureModel {
  const features: ContourFeature[] = [
    { value: 10, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [10, 8]] },
  ];
  return {
    features,
    crs: 'EPSG:32610',
    verticalDatum: null,
    intervalM: 1,
    contourStyle: 'smooth',
    bbox: { minX: 0, minY: 0, maxX: 10, maxY: 8 },
    interpolatedFraction: 0,
    coverageMode: 'full',
    warnings: [],
  };
}

describe('svgContours labels', () => {
  it('renders a haloed elevation label when labels are supplied', () => {
    const labels: ContourLabel[] = [{ x: 5, y: 4, angleRad: 0, value: 10 }];
    const svg = svgContours(model(), { labels });
    expect(svg).toMatch(/<text/);
    expect(svg).toMatch(/paint-order:stroke/);
    expect(svg).toMatch(/>10<\/text>/); // the elevation value
  });

  it('omits haloed elevation labels when none are supplied (the map furniture remains)', () => {
    const svg = svgContours(model());
    // No haloed elevation labels…
    expect(svg).not.toMatch(/paint-order:stroke/);
    // …but the title-block interval line is always present…
    expect(svg).toMatch(/Contour interval 1 m/);
    // …along with the cartographic furniture: north arrow, legend, scale bar.
    expect(svg).toMatch(/>N<\/text>/);
    expect(svg).toMatch(/Index contour/);
    expect(svg).toMatch(/\d+ m<\/text>/); // a graphic-scale-bar tick in ground units
  });

  it('derives label decimals from the contour interval (sub-metre levels stay distinct)', () => {
    // 0.25 m interval: whole-metre rounding collapsed 10.25 and 10.5 onto
    // "10" — they must print as 10.25 / 10.50.
    const m: ContourFeatureModel = { ...model(), intervalM: 0.25 };
    const labels: ContourLabel[] = [
      { x: 3, y: 2, angleRad: 0, value: 10.25 },
      { x: 7, y: 6, angleRad: 0, value: 10.5 },
    ];
    const svg = svgContours(m, { labels });
    expect(svg).toMatch(/>10\.25<\/text>/);
    expect(svg).toMatch(/>10\.50<\/text>/);
    // And the title block states the interval at the same precision.
    expect(svg).toMatch(/Contour interval 0\.25 m/);
  });

  it('stamps the caller-resolved unit into the scale bar', () => {
    const svg = svgContours(model(), { unitLabel: 'ft' });
    expect(svg).toMatch(/\d+(\.\d+)? ft<\/text>/);
  });

  it('keeps labels upright (no near-180° rotation)', () => {
    // A label whose contour runs right-to-left would otherwise be upside down.
    const labels: ContourLabel[] = [{ x: 5, y: 4, angleRad: Math.PI, value: 10 }];
    const svg = svgContours(model(), { labels });
    const m = svg.match(/rotate\(([-0-9.]+)/);
    expect(m).not.toBeNull();
    const deg = Math.abs(parseFloat(m![1]));
    expect(deg).toBeLessThanOrEqual(90.001);
  });
});
