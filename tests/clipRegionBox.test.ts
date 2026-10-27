/**
 * A box drawn with Draw clipping box is a clip region: its footprint comes from
 * the two clicks and its height is the scan's, so it reports no height and no
 * volume in the panel, CSV, GeoJSON and report. A Box drawn with the Box tool
 * keeps its volume.
 */
import { describe, it, expect } from 'vitest';
import { measurementMetrics, measurementsToCsv, measurementsToGeoJSON, type MeasurementExportContext } from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { CLIP_REGION_NOTE } from '../src/render/measure/geometry';
import { useBoxAsClip } from '../src/app/boxToClip';
import type { ClipBox } from '../src/render/clip/clipBox';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const UP: Vec3 = [0, 0, 1];
const CTX: MeasurementExportContext = { toOutput: (p) => [p[0], p[1], p[2]], lonLat: IDENTITY_LONLAT, up: UP, unitToMetres: 1, crsName: 'EPSG:32612' };
const CLIP: Measurement = { id: 'c', kind: 'box', name: 'Box 1', points: [[0, 0, 0], [21, 23, 5.88]], clipRegion: true };
const BOX: Measurement = { id: 'b', kind: 'box', name: 'Box 2', points: [[0, 0, 0], [2, 3, 4]] };

describe('a clip-region box', () => {
  it('has width and depth but no height or volume', () => {
    const mm = measurementMetrics(CLIP, UP, 1);
    expect(mm.width_m).toBe(21);
    expect(mm.height_m).toBeUndefined();
    expect(mm.volume_m3).toBeUndefined();
    expect(measurementMetrics(BOX, UP, 1).volume_m3).toBe(24);
  });

  it('says so in the CSV, GeoJSON and report', () => {
    expect(measurementsToCsv([CLIP], CTX)).toContain(CLIP_REGION_NOTE);
    const p = JSON.parse(measurementsToGeoJSON([CLIP], CTX)).features[0].properties;
    expect(p.volume_m3).toBeUndefined();
    expect(p.volume_withheld).toBe(CLIP_REGION_NOTE);
    const f = measurementsToFindings([CLIP], UP, 1);
    expect(f[0].value).toBeNull();
    expect(f[0].caveats).toContain(CLIP_REGION_NOTE);
    expect(JSON.stringify(buildMeasurementRows([CLIP], 'metric'))).not.toMatch(/m³/);
  });

  it('becomes a clip at the scan full height even without the draw session', () => {
    let clip: ClipBox | null = null;
    const ok = useBoxAsClip({
      measurements: () => [CLIP], activeLayerId: () => null, layerCount: () => 1,
      verticalExtent: () => ({ axis: 2, min: -50, max: 900 }) as never,
      adoptClip: (c) => { clip = c; }, openClipPage: () => {}, toast: () => {},
    }, 'c');
    expect(ok).toBe(true);
    const c = clip as unknown as ClipBox;
    // The scan's extent (padded), not the 0..5.88 the two clicks landed at.
    expect(c.box.min[2]).toBeLessThanOrEqual(-50);
    expect(c.box.max[2]).toBeGreaterThanOrEqual(900);
  });
});
