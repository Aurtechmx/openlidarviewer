/**
 * measurementExport.test.ts
 *
 * Pins the GeoJSON + CSV measurement serializers: geometry types per kind,
 * closed polygon rings, CRS handling, unit conversion, and honest blanks.
 */

import { describe, it, expect } from 'vitest';
import {
  measurementsToGeoJSON,
  measurementsToCsv,
  measurementMetrics,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
/** Identity output frame, metric, projected with a CRS name. */
const CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]],
  up: UP,
  unitToMetres: 1,
  crsName: 'EPSG:32612',
};

function mk(kind: Measurement['kind'], points: Vec3[], extra: Partial<Measurement> = {}): Measurement {
  return { id: `m-${kind}`, kind, name: `${kind} 1`, points, ...extra };
}

const DISTANCE = mk('distance', [[0, 0, 0], [3, 4, 0]]);
const AREA = mk('area', [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], { closed: true });
const BOX = mk('box', [[0, 0, 0], [2, 3, 4]]);
const VOLUME = mk('volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
  volume: {
    fill: 120, cut: 30, net: 90, referenceZ: 0, footprintArea: 50,
    pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
  },
});

describe('measurementsToCsv — formula-injection neutralisation', () => {
  it('neutralises a name that begins with a spreadsheet formula trigger', () => {
    const evil = mk('distance', [[0, 0, 0], [3, 4, 0]], { name: '=HYPERLINK("http://evil","x")' });
    const csv = measurementsToCsv([evil], CTX);
    // Prefixed with a literal apostrophe and force-quoted (quotes doubled).
    expect(csv).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
    // The raw, un-neutralised formula must NOT appear at a cell boundary.
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });

  it('neutralises @, +, and - leading names too', () => {
    for (const name of ['@SUM(1+1)', '+1+2', '-2+3']) {
      const csv = measurementsToCsv([mk('distance', [[0, 0, 0], [1, 0, 0]], { name })], CTX);
      expect(csv).toContain(`"'${name}"`);
    }
  });

  it('leaves a benign name and negative numeric cells untouched', () => {
    const csv = measurementsToCsv([mk('distance', [[0, 0, 0], [3, 4, 0]], { name: 'Polyline 2' })], CTX);
    const row = csv.split('\n')[1];
    expect(row.split(',')).toContain('Polyline 2');
    // A negative numeric value (downhill vertical) must NOT be apostrophe-prefixed.
    const slopeCsv = measurementsToCsv([mk('distance', [[0, 0, 0], [3, 0, -4]])], CTX);
    expect(slopeCsv).not.toContain("'-");
  });
});

describe('measurementMetrics', () => {
  it('distance → length in metres', () => {
    expect(measurementMetrics(DISTANCE, UP, 1)).toEqual({ length_m: 5 });
  });

  it('area → planar area + perimeter', () => {
    const m = measurementMetrics(AREA, UP, 1);
    expect(m.area_m2).toBe(100);
    expect(m.perimeter_m).toBe(40);
  });

  it('box → width / depth / height / volume', () => {
    expect(measurementMetrics(BOX, UP, 1)).toMatchObject({
      width_m: 2, depth_m: 3, height_m: 4, volume_m3: 24,
    });
  });

  it('volume → cut / fill / net, no scaling at metric scale (×1)', () => {
    const m = measurementMetrics(VOLUME, UP, 1);
    expect(m.cut_m3).toBe(30);
    expect(m.fill_m3).toBe(120);
    expect(m.net_m3).toBe(90);
  });

  it('applies unitToMetres to lengths (×), areas (×²), and volumes (×³)', () => {
    expect(measurementMetrics(DISTANCE, UP, 0.3048).length_m).toBeCloseTo(5 * 0.3048, 3);
    // Export rounds to 3 decimals, so compare at that precision.
    expect(measurementMetrics(AREA, UP, 0.3048).area_m2).toBeCloseTo(100 * 0.3048 ** 2, 3);
    // Regression: a foot-CRS stockpile volume must export in cubic metres, not
    // native ft³ mislabelled as m³. cut/fill/net are stored native → ×0.3048³.
    const v = measurementMetrics(VOLUME, UP, 0.3048);
    expect(v.cut_m3).toBeCloseTo(30 * 0.3048 ** 3, 3);
    expect(v.fill_m3).toBeCloseTo(120 * 0.3048 ** 3, 3);
    expect(v.net_m3).toBeCloseTo(90 * 0.3048 ** 3, 3);
  });

  it('an INCOMPLETE measurement emits no metrics (never zero-filled)', () => {
    expect(measurementMetrics(mk('area', [[0, 0, 0], [1, 0, 0]]), UP, 1)).toEqual({});
    expect(measurementMetrics(mk('distance', [[0, 0, 0]]), UP, 1)).toEqual({});
  });

  it('a compound CRS scales vertical quantities by the vertical factor, horizontals by the linear', () => {
    // Metre eastings (unitToMetres = 1) over US-survey-foot heights (vertical ≈
    // 0.3048). Vertical quantities must match the panel headline, which already
    // uses the vertical factor; horizontals stay in metres.
    const box = measurementMetrics(BOX, UP, 1, 0.3048); // UP = +Z, so height is the Z span (4)
    expect(box.width_m).toBeCloseTo(2, 3); // horizontal — linear factor (1)
    expect(box.depth_m).toBeCloseTo(3, 3); // horizontal — linear factor (1)
    expect(box.height_m).toBeCloseTo(4 * 0.3048, 3); // vertical — vertical factor
    expect(box.volume_m3).toBeCloseTo(24 * 1 * 1 * 0.3048, 3); // linear²·vertical, NOT linear³
    // cut/fill/net use the same linear²·vertical volume factor.
    const vol = measurementMetrics(VOLUME, UP, 1, 0.3048);
    expect(vol.cut_m3).toBeCloseTo(30 * 0.3048, 3);
  });

  it('the vertical factor defaults to unitToMetres (single-unit CRS byte-identical)', () => {
    expect(measurementMetrics(BOX, UP, 0.3048)).toEqual(measurementMetrics(BOX, UP, 0.3048, 0.3048));
  });
});

describe('measurementsToGeoJSON', () => {
  it('emits a FeatureCollection with one feature per complete measurement', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DISTANCE, AREA, BOX, VOLUME], CTX));
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(4);
  });

  it('line kinds → LineString; polygon kinds → closed Polygon', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DISTANCE, AREA], CTX));
    const dist = fc.features.find((f: { properties: { kind: string } }) => f.properties.kind === 'distance');
    const area = fc.features.find((f: { properties: { kind: string } }) => f.properties.kind === 'area');
    expect(dist.geometry.type).toBe('LineString');
    expect(dist.geometry.coordinates).toEqual([[0, 0, 0], [3, 4, 0]]);
    expect(area.geometry.type).toBe('Polygon');
    // Ring is closed: last coord equals the first.
    const ring = area.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('carries metrics + crs in feature properties', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DISTANCE], CTX));
    expect(fc.features[0].properties).toMatchObject({ kind: 'distance', length_m: 5, crs: 'EPSG:32612' });
  });

  it('projected export carries a named-CRS member; geographic does not', () => {
    const projected = JSON.parse(measurementsToGeoJSON([DISTANCE], CTX));
    expect(projected.crs).toMatchObject({ type: 'name', properties: { name: 'EPSG:32612' } });
    const geo = JSON.parse(
      measurementsToGeoJSON([DISTANCE], { ...CTX, geographic: true }),
    );
    expect(geo.crs).toBeUndefined();
  });

  it('applies the toOutput transform to coordinates', () => {
    const fc = JSON.parse(
      measurementsToGeoJSON([DISTANCE], { ...CTX, toOutput: (p) => [p[0] + 100, p[1] + 200, p[2]] }),
    );
    expect(fc.features[0].geometry.coordinates[0]).toEqual([100, 200, 0]);
  });

  it('drops measurements with too few vertices', () => {
    const fc = JSON.parse(measurementsToGeoJSON([mk('area', [[0, 0, 0], [1, 0, 0]])], CTX));
    expect(fc.features).toHaveLength(0);
  });
});

describe('measurementsToCsv', () => {
  it('header lists every column; one row per measurement', () => {
    const csv = measurementsToCsv([DISTANCE, AREA], CTX);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('id,name,kind,vertices');
    expect(lines).toHaveLength(3); // header + 2 rows
  });

  it('fills only the applicable metric columns, leaving others blank', () => {
    const csv = measurementsToCsv([DISTANCE], CTX);
    const header = csv.split('\n')[0].split(',');
    const row = csv.split('\n')[1].split(',');
    const cell = (col: string): string => row[header.indexOf(col)];
    expect(cell('length_m')).toBe('5');
    expect(cell('area_m2')).toBe(''); // not applicable to a distance
    expect(cell('kind')).toBe('distance');
  });

  it('escapes a name containing a comma', () => {
    const csv = measurementsToCsv([mk('distance', [[0, 0, 0], [1, 0, 0]], { name: 'A, B' })], CTX);
    expect(csv).toContain('"A, B"');
  });
});
