/**
 * A Box with both corners at one height has no height, so it has no volume.
 * The panel headline, CSV, GeoJSON and report findings withhold the volume and
 * say why, instead of printing 0 m³.
 */
import { describe, it, expect } from 'vitest';
import { measurementMetrics, measurementsToCsv, measurementsToGeoJSON, type MeasurementExportContext } from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { formatBoxHeadline } from '../src/render/measure/format';
import { BOX_NO_HEIGHT_NOTE } from '../src/render/measure/geometry';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const UP: Vec3 = [0, 0, 1];
const CTX: MeasurementExportContext = { toOutput: (p) => [p[0], p[1], p[2]], lonLat: IDENTITY_LONLAT, up: UP, unitToMetres: 1, crsName: 'EPSG:32612' };
const FLAT: Measurement = { id: 'b', kind: 'box', name: 'Box 2', points: [[0, 0, 5], [21.082, 23.467, 5]] };
const TALL: Measurement = { id: 't', kind: 'box', name: 'Box 3', points: [[0, 0, 0], [2, 3, 4]] };

describe('a box with no height', () => {
  it('has no volume_m3 in the metrics, keeps width, depth and height', () => {
    const mm = measurementMetrics(FLAT, UP, 1);
    expect(mm.volume_m3).toBeUndefined();
    expect(mm.width_m).toBeCloseTo(21.082, 3);
    expect(mm.height_m).toBe(0);
    expect(measurementMetrics(TALL, UP, 1).volume_m3).toBe(24);
  });

  it('says why in the CSV and GeoJSON', () => {
    const csv = measurementsToCsv([FLAT], CTX);
    expect(csv).toContain(BOX_NO_HEIGHT_NOTE);
    const gj = JSON.parse(measurementsToGeoJSON([FLAT], CTX));
    const p = gj.features[0].properties;
    expect(p.volume_m3).toBeUndefined();
    expect(p.volume_withheld).toBe(BOX_NO_HEIGHT_NOTE);
  });

  it('is a null finding with the reason in the report, never 0', () => {
    const f = measurementsToFindings([FLAT], UP, 1);
    expect(f[0].value).toBeNull();
    expect(f[0].caveats).toContain(BOX_NO_HEIGHT_NOTE);
    const rows = buildMeasurementRows([FLAT], 'metric');
    expect(JSON.stringify(rows)).not.toMatch(/\b0 m³/);
    expect(JSON.stringify(rows)).toContain('set a height');
  });

  it('headline withholds the volume', () => {
    const h = formatBoxHeadline(210.82, 234.67, 0, Number.NaN, 'metric');
    expect(h).toMatch(/no volume: set a height/);
    expect(h).not.toMatch(/m³/);
  });
});
