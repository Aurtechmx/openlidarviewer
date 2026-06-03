/**
 * exportWriters.test.ts — GeoJSON / SVG / DXF serialisers.
 */

import { describe, it, expect } from 'vitest';
import { toGeoJSON, geojsonString } from '../src/terrain/contour/geojsonContours';
import { svgContours } from '../src/terrain/contour/svgContours';
import { dxfContours } from '../src/terrain/contour/dxfContours';
import type {
  ContourFeature,
  ContourFeatureModel,
} from '../src/terrain/contour/contourFeatureModel';

function feat(
  grade: ContourFeature['grade'],
  coordinates: Array<[number, number]>,
  value = 10,
  isIndex = false,
  closed = false,
): ContourFeature {
  return { value, isIndex, grade, meanConfidence: grade === 'solid' ? 90 : 40, closed, coordinates };
}

function model(features: ContourFeature[], crs: string | null = 'EPSG:32610'): ContourFeatureModel {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const f of features)
    for (const [x, y] of f.coordinates) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  return {
    features,
    crs,
    verticalDatum: 'EPSG:5703',
    intervalM: 1,
    bbox: features.length ? { minX, minY, maxX, maxY } : null,
    interpolatedFraction: 0.2,
    warnings: [],
  };
}

describe('toGeoJSON', () => {
  const m = model([
    feat('solid', [[0, 0], [1, 1]], 10, true),
    feat('dashed', [[1, 1], [2, 1]], 11),
  ]);

  it('produces a valid FeatureCollection with per-run properties', () => {
    const gj = toGeoJSON(m) as any;
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features.length).toBe(2);
    expect(gj.features[0].geometry.type).toBe('LineString');
    expect(gj.features[0].properties.elevation).toBe(10);
    expect(gj.features[0].properties.index).toBe(true);
    expect(gj.features[1].properties.grade).toBe('dashed');
  });

  it('emits the legacy CRS member as an OGC URN', () => {
    const gj = toGeoJSON(m) as any;
    expect(gj.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::32610');
  });

  it('omits the CRS member and the file stays valid JSON when CRS unknown', () => {
    const gj = toGeoJSON(model([feat('solid', [[0, 0], [1, 0]])], null)) as any;
    expect(gj.crs).toBeUndefined();
    expect(() => JSON.parse(geojsonString(model([feat('solid', [[0, 0], [1, 0]])], null)))).not.toThrow();
  });

  it('carries the not-survey-grade provenance', () => {
    const gj = toGeoJSON(m) as any;
    expect(String(gj.metadata.notSurveyGrade)).toMatch(/not survey-grade/i);
  });
});

describe('svgContours', () => {
  it('renders paths and dashes the uncertain runs', () => {
    const svg = svgContours(
      model([feat('solid', [[0, 0], [10, 0]], 10, true), feat('dashed', [[0, 5], [10, 5]], 11)]),
    );
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/viewBox=/);
    expect((svg.match(/<path/g) || []).length).toBe(2);
    expect(svg).toMatch(/stroke-dasharray/); // the dashed feature
    expect(svg).toMatch(/data-elevation="10"/);
  });

  it('returns a tiny placeholder SVG for an empty model', () => {
    const svg = svgContours(model([]));
    expect(svg).toMatch(/<svg/);
    expect(svg).not.toMatch(/<path/);
  });

  it('flips Y so larger world-Y maps nearer the top (smaller svg-Y)', () => {
    // Single horizontal line at world y=10 vs y=0; with padding the
    // y=10 line should render at a smaller svg y than the y=0 line.
    const svg = svgContours(
      model([feat('solid', [[0, 0], [10, 0]]), feat('solid', [[0, 10], [10, 10]])]),
      { padding: 0 },
    );
    // y=10 → svg 0; y=0 → svg 10
    expect(svg).toMatch(/M0\.000 0\.000/);
    expect(svg).toMatch(/M0\.000 10\.000/);
  });
});

describe('dxfContours', () => {
  const m = model([
    feat('solid', [[0, 0], [1, 0], [1, 1]], 10, true, false),
    feat('gap', [[0, 5], [5, 5]], 12),
    feat('solid', [[0, 0], [2, 0], [2, 2], [0, 2]], 5, false, true),
  ]);
  const dxf = dxfContours(m);

  it('is a well-formed minimal DXF', () => {
    expect(dxf).toMatch(/^0\nSECTION/);
    expect(dxf).toMatch(/\nENTITIES\n/);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('defines the honesty layers and routes features to them', () => {
    expect(dxf).toMatch(/CONTOUR_INDEX/);
    expect(dxf).toMatch(/CONTOUR_INTER/);
    expect(dxf).toMatch(/CONTOUR_UNCERTAIN/);
  });

  it('carries elevation as group code 38 and vertex count as 90', () => {
    expect(dxf).toMatch(/\n38\n10\n/); // elevation 10 on the index feature
    expect(dxf).toMatch(/\n90\n3\n/); // 3-vertex feature
  });

  it('marks the closed ring with the closed flag (70=1)', () => {
    // The 4-vertex closed ring at elevation 5.
    expect(dxf).toMatch(/LWPOLYLINE/);
    expect(dxf).toMatch(/\n90\n4\n70\n1\n38\n5\n/);
  });
});
