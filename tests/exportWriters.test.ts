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
import type { ExportProvenance } from '../src/terrain/export/exportProvenance';

/** A complete provenance fixture, the shared object every export stamps. */
const PROV: ExportProvenance = {
  software: 'OpenLiDARViewer',
  softwareVersion: '9.9.9',
  metricVersion: 'v0.4.1',
  generated: '2026-06-05T00:00:00.000Z',
  source: 'site',
  horizontalCrs: 'EPSG:32610',
  crsKnown: true,
  verticalDatum: 'EPSG:5703',
  datumKnown: true,
  coverageMode: 'full',
  contourIntervalM: 1,
  contourStyle: 'smooth',
  contourStyleLabel: 'Smooth',
  surfaceQuality: 'Good',
  exportReadiness: 'Ready',
  exportReason: '',
  accuracy: { rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, usgsQualityLevel: 'QL2' },
  pointDensityPerM2: 4.2,
  measuredCells: 90,
  totalCells: 100,
  classScope: null,
  warnings: [],
  notSurveyGrade: 'Fitness-for-use; not survey-grade unless validated against control.',
};

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
    contourStyle: 'smooth',
    bbox: features.length ? { minX, minY, maxX, maxY } : null,
    interpolatedFraction: 0.2,
    coverageMode: 'full',
    warnings: ['CRS unknown — test'],
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
    // v0.4.0 evidence metadata
    expect(gj.features[0].properties.evidenceGrade).toBe('measuredBacked');
    expect(gj.features[1].properties.evidenceGrade).toBe('interpolatedBacked');
    expect(gj.features[0].properties.interval).toBe(1);
    expect(gj.features[0].properties.coverageMode).toBe('full');
    expect(gj.metadata.coverageMode).toBe('full');
    expect(Array.isArray(gj.metadata.warnings)).toBe(true);
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

  it('merges the unified provenance into metadata as a superset (no regression)', () => {
    const gj = toGeoJSON(m, PROV) as any;
    // Existing model-derived keys are preserved.
    expect(gj.metadata.contourStyle).toBe('smooth');
    expect(gj.metadata.coverageMode).toBe('full');
    expect(Array.isArray(gj.metadata.warnings)).toBe(true);
    // The unified provenance adds the fields the file used to lack.
    expect(gj.metadata.horizontalCrs).toBe('EPSG:32610');
    expect(gj.metadata.verticalDatum).toBe('EPSG:5703');
    expect(gj.metadata.softwareVersion).toBe('9.9.9');
    expect(gj.metadata.metricVersion).toBe('v0.4.1');
    expect(gj.metadata.exportReadiness).toBe('Ready');
    expect(gj.metadata.surfaceQuality).toBe('Good');
    expect(gj.metadata.accuracy.usgsQualityLevel).toBe('QL2');
    expect(gj.metadata.generated).toBe('2026-06-05T00:00:00.000Z');
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

  it('stamps the unified provenance in a <metadata> block when supplied', () => {
    const svg = svgContours(
      model([feat('solid', [[0, 0], [10, 0]], 10, true)]),
      { provenance: PROV },
    );
    expect(svg).toMatch(/<metadata>/);
    expect(svg).toMatch(/Horizontal CRS\s+EPSG:32610/);
    expect(svg).toMatch(/Export readiness\s+Ready/);
    expect(svg).toMatch(/Software\s+OpenLiDARViewer 9\.9\.9/);
    expect(svg).toMatch(/not survey-grade/i);
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

  it('is a well-formed minimal DXF (a 999 provenance comment then SECTION)', () => {
    // Leads with a group-code-999 comment (ignored by CAD readers) naming the
    // contour shape style, immediately followed by the first SECTION.
    expect(dxf).toMatch(/^999\n[^\n]*\n0\nSECTION/);
    expect(dxf).toMatch(/\nENTITIES\n/);
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('stamps the contour shape style in a 999 comment', () => {
    expect(dxf).toMatch(/999\nOpenLiDARViewer contour style: Smooth/);
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

  it('emits the unified provenance as leading 999 comments when supplied', () => {
    const withProv = dxfContours(m, PROV);
    // Same provenance lines every other export carries, as 999 comments.
    expect(withProv).toMatch(/999\nSoftware\s+OpenLiDARViewer 9\.9\.9/);
    expect(withProv).toMatch(/999\nHorizontal CRS\s+EPSG:32610/);
    expect(withProv).toMatch(/999\nExport readiness\s+Ready/);
    expect(withProv).toMatch(/999\nNote\s+.*not survey-grade/i);
    // Still a well-formed DXF: comments precede the first SECTION.
    expect(withProv).toMatch(/999\nNote[\s\S]*0\nSECTION/);
    expect(withProv.trimEnd().endsWith('EOF')).toBe(true);
  });
});
