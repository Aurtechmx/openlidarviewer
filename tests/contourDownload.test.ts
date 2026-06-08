/**
 * contourDownload.test.ts — serialisation half of the download helper.
 * The DOM trigger is environment-only and not unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import type { ContourFeature, ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { ExportProvenance } from '../src/terrain/export/exportProvenance';

const PROV: ExportProvenance = {
  software: 'OpenLiDARViewer', softwareVersion: '9.9.9', metricVersion: 'v0.4.1',
  generated: '2026-06-05T00:00:00.000Z', source: 'site',
  horizontalCrs: 'EPSG:32610', crsKnown: true, verticalDatum: 'EPSG:5703', datumKnown: true,
  coverageMode: 'full', contourIntervalM: 1, contourStyle: 'smooth', contourStyleLabel: 'Smooth',
  surfaceQuality: 'Good', exportReadiness: 'Ready', exportReason: '',
  accuracy: { rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, usgsQualityLevel: 'QL2' },
  pointDensityPerM2: 4.2, measuredCells: 90, totalCells: 100, classScope: null, warnings: [],
  notSurveyGrade: 'Fitness-for-use; not survey-grade unless validated against control.',
};

function model(): ContourFeatureModel {
  const features: ContourFeature[] = [
    { value: 10, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [1, 1]] },
  ];
  return {
    features,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
    intervalM: 1,
    contourStyle: 'smooth',
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    interpolatedFraction: 0,
    coverageMode: 'full',
    warnings: [],
  };
}

describe('serializeContours', () => {
  it('names and types a GeoJSON file and emits valid JSON', () => {
    const f = serializeContours(model(), 'geojson');
    expect(f.filename).toBe('contours.geojson');
    expect(f.mime).toBe('application/geo+json');
    expect(() => JSON.parse(f.content)).not.toThrow();
  });

  it('produces SVG and DXF with correct extensions and non-empty content', () => {
    const svg = serializeContours(model(), 'svg');
    expect(svg.filename.endsWith('.svg')).toBe(true);
    expect(svg.content).toMatch(/<svg/);

    const dxf = serializeContours(model(), 'dxf');
    expect(dxf.filename.endsWith('.dxf')).toBe(true);
    expect(dxf.content.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('honours a custom basename', () => {
    const f = serializeContours(model(), 'geojson', { basename: 'site-A-contours' });
    expect(f.filename).toBe('site-A-contours.geojson');
  });

  it('stamps the contour shape style into every serialized format', () => {
    const m: ContourFeatureModel = { ...model(), contourStyle: 'semi-geometric' };
    const geo = JSON.parse(serializeContours(m, 'geojson').content) as {
      metadata: { contourStyle: string; contourStyleLabel: string };
    };
    expect(geo.metadata.contourStyle).toBe('semi-geometric');
    expect(geo.metadata.contourStyleLabel).toBe('Semi-geometric');

    const svg = serializeContours(m, 'svg').content;
    expect(svg).toMatch(/contour style: Semi-geometric/i);

    const dxf = serializeContours(m, 'dxf').content;
    expect(dxf).toMatch(/contour style: Semi-geometric/i);
  });

  it('threads the unified provenance into every format identically', () => {
    const m = model();
    const geo = JSON.parse(serializeContours(m, 'geojson', { provenance: PROV }).content) as {
      metadata: { horizontalCrs: string; exportReadiness: string; softwareVersion: string };
    };
    expect(geo.metadata.horizontalCrs).toBe('EPSG:32610');
    expect(geo.metadata.exportReadiness).toBe('Ready');
    expect(geo.metadata.softwareVersion).toBe('9.9.9');

    const svg = serializeContours(m, 'svg', { provenance: PROV }).content;
    expect(svg).toMatch(/Horizontal CRS\s+EPSG:32610/);
    expect(svg).toMatch(/Export readiness\s+Ready/);

    const dxf = serializeContours(m, 'dxf', { provenance: PROV }).content;
    expect(dxf).toMatch(/999\nHorizontal CRS\s+EPSG:32610/);
    expect(dxf).toMatch(/999\nExport readiness\s+Ready/);
  });
});
