/**
 * contourDownload.test.ts — serialisation half of the download helper.
 * The DOM trigger is environment-only and not unit-tested.
 */

import { describe, it, expect } from 'vitest';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import type { ContourFeature, ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { ExportProvenance } from '../src/terrain/export/exportProvenance';

const PROV: ExportProvenance = {
  software: 'OpenLiDARViewer', softwareVersion: '9.9.9',
  build: '9.9.9 (testtest) · test · built 1970-01-01T00:00:00.000Z', metricVersion: 'v0.4.1',
  generated: '2026-06-05T00:00:00.000Z', source: 'site',
  horizontalCrs: 'EPSG:32610', crsKnown: true, verticalDatum: 'EPSG:5703', datumKnown: true,
  coverageMode: 'full', contourIntervalM: 1, contourStyle: 'smooth', contourStyleLabel: 'Smooth',
  contourMethod: null, contourGeneralizeToleranceCells: null, deliverablePurpose: null,
  surfaceQuality: 'Good', exportReadiness: 'Ready', exportReason: '',
  accuracy: { rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, usgsQualityLevel: 'QL2' },
  complexity: null,
  pointDensityPerM2: 4.2, measuredCells: 90, totalCells: 100, classScope: null, warnings: [],
  notSurveyGrade: 'Suitability: not survey-grade unless validated against ground-truth control.',
  exportPermit: null,
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
    const f = serializeContours(model(), 'geojson-native');
    expect(f.filename).toBe('contours-native.geojson');
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
    const f = serializeContours(model(), 'geojson-native', { basename: 'site-A-contours' });
    expect(f.filename).toBe('site-A-contours-native.geojson');
  });

  it('stamps the contour shape style into every serialized format', () => {
    const m: ContourFeatureModel = { ...model(), contourStyle: 'semi-geometric' };
    const geo = JSON.parse(serializeContours(m, 'geojson-native').content) as {
      metadata: { contourStyle: string; contourStyleLabel: string };
    };
    expect(geo.metadata.contourStyle).toBe('semi-geometric');
    expect(geo.metadata.contourStyleLabel).toBe('Semi-geometric');

    const svg = serializeContours(m, 'svg').content;
    expect(svg).toMatch(/contour style: Semi-geometric/i);

    const dxf = serializeContours(m, 'dxf').content;
    expect(dxf).toMatch(/contour style: Semi-geometric/i);
  });

  it('DXF carries a HEADER with $INSUNITS (metres by default, feet when resolved)', () => {
    const dxf = serializeContours(model(), 'dxf').content;
    // HEADER section precedes TABLES and declares metres (code 6).
    expect(dxf).toMatch(/0\nSECTION\n2\nHEADER\n9\n\$INSUNITS\n70\n6\n0\nENDSEC/);
    const ft = serializeContours(model(), 'dxf', { linearUnit: 'us-survey-foot' }).content;
    expect(ft).toMatch(/\$INSUNITS\n70\n21\n/); // 21 = US survey feet
    const unknown = serializeContours(model(), 'dxf', { linearUnit: 'unknown' }).content;
    expect(unknown).toMatch(/\$INSUNITS\n70\n0\n/); // honest "unitless"
  });

  it('DXF emits elevation labels as TEXT on the CONTOUR_TEXT layer', () => {
    const dxf = serializeContours(model(), 'dxf', {
      labels: [{ x: 0.5, y: 0.5, angleRad: 0, value: 10 }],
    }).content;
    // The layer exists in the LAYER table AND carries the TEXT entity.
    expect(dxf).toMatch(/0\nLAYER\n2\nCONTOUR_TEXT\n/);
    expect(dxf).toMatch(/0\nTEXT\n8\nCONTOUR_TEXT\n/);
    // Label value with interval-derived decimals (interval 1 → "10"), sat at
    // its contour's elevation (group 30) and at the placed position.
    expect(dxf).toMatch(/\n10\n0\.5\n20\n0\.5\n30\n10\n/);
    expect(dxf).toMatch(/\n1\n10\n/); // group 1 = the text "10"

    // Sub-metre interval → decimals derive from it (0.5 → 1 decimal).
    const sub = serializeContours({ ...model(), intervalM: 0.5 }, 'dxf', {
      labels: [{ x: 0.5, y: 0.5, angleRad: 0, value: 10.5 }],
    }).content;
    expect(sub).toMatch(/\n1\n10\.5\n/);

    // No labels supplied → no TEXT entity (back-compat output shape).
    const plain = serializeContours(model(), 'dxf').content;
    expect(plain).not.toMatch(/\n0\nTEXT\n/);
  });

  it('threads the unified provenance into every format identically', () => {
    const m = model();
    const geo = JSON.parse(serializeContours(m, 'geojson-native', { provenance: PROV }).content) as {
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

/**
 * The `.geojson` extension must mean what RFC 7946 says it means.
 *
 * The contour export wrote projected eastings/northings into a `.geojson`
 * and declared them with the pre-RFC top-level `crs` member. RFC 7946
 * requires WGS 84 longitude/latitude and REMOVED that member, so a
 * compliant reader drops the only thing identifying the frame and then
 * reads an easting of 517,047 as a longitude. It does not error — it puts
 * the data somewhere impossible. Observed on a UTM zone 29N vineyard scan.
 *
 * Two files now: the standard extension carries the standard thing, and the
 * native projected frame gets its own clearly-named sibling.
 */
function utmModel(): ContourFeatureModel {
  return {
    ...model(),
    crs: 'EPSG:32629',
    features: [
      { value: 65.5, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false,
        coordinates: [[517047.74, 4644881.40], [517000.0, 4644800.0]] },
    ],
    bbox: { minX: 517000, minY: 4644800, maxX: 517047.74, maxY: 4644881.4 },
  };
}

// A stand-in for the real UTM→lon/lat conversion the caller supplies.
/** The model's coordinates are already world, so the shift is a no-op. */
const WORLD = { x: 0, y: 0, z: 0 };
const toLonLat = (p: readonly [number, number, number]): [number, number, number] =>
  [-8.5 + (p[0] - 517000) / 100000, 41.9 + (p[1] - 4644800) / 100000, p[2]];

describe('serializeContours — RFC 7946 vs native frame', () => {
  it('writes degrees and NO crs member for the standard .geojson', () => {
    const f = serializeContours(utmModel(), 'geojson', { toLonLat, worldOrigin: WORLD });
    const gj = JSON.parse(f.content);
    expect(f.filename).toBe('contours.geojson');
    expect(gj.crs).toBeUndefined(); // RFC 7946 removed it
    const [lon, lat] = gj.features[0].geometry.coordinates[0];
    expect(lon).toBeGreaterThan(-180); expect(lon).toBeLessThan(180);
    expect(lat).toBeGreaterThan(-90); expect(lat).toBeLessThan(90);
  });

  it('records the frame it came from, since the crs member cannot', () => {
    const gj = JSON.parse(serializeContours(utmModel(), 'geojson', { toLonLat, worldOrigin: WORLD }).content);
    expect(JSON.stringify(gj.metadata)).toContain('32629');
  });

  it('REFUSES to write a standard .geojson it cannot convert', () => {
    // Without a conversion the only honest options are refusing or emitting
    // projected numbers as degrees. It must refuse.
    expect(() => serializeContours(utmModel(), 'geojson', { worldOrigin: WORLD })).toThrow(/convert|lon|lat|degrees/i);
  });

  it('keeps projected coordinates and the crs member in the native sibling', () => {
    const f = serializeContours(utmModel(), 'geojson-native', { worldOrigin: WORLD });
    const gj = JSON.parse(f.content);
    expect(f.filename).toContain('EPSG32629');
    expect(f.filename.endsWith('.geojson')).toBe(true);
    expect(gj.crs.properties.name).toBe('urn:ogc:def:crs:EPSG::32629');
    expect(gj.features[0].geometry.coordinates[0][0]).toBeCloseTo(517047.74, 2);
  });

  it('needs no conversion for the native sibling', () => {
    expect(() => serializeContours(utmModel(), 'geojson-native', { worldOrigin: WORLD })).not.toThrow();
  });
});
