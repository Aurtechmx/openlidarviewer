/**
 * The measurement GeoJSON is RFC 7946: WGS 84 longitude/latitude and no `crs`
 * member.
 *
 * What these tests would catch:
 *  - Projected eastings/northings written as GeoJSON positions (with or without
 *    a pre-RFC `crs` URN), which most GIS readers take as degrees.
 *  - A GeoJSON that disagrees with the site KML about where the same record is.
 *  - A height written when the vertical datum is not proven.
 *  - A local or unknown frame exported with invented degrees instead of refused.
 *  - Measured values recomputed from degrees instead of the metric frame.
 */

import { describe, it, expect } from 'vitest';
import {
  measurementsToGeoJSON,
  GeoJsonLonLatError,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import { buildKml } from '../src/export/kmlExport';
import { geoJsonLonLat, exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import { resolveLocalToLonLat } from '../src/export/lonLatMapper';
import * as serializers from '../src/export/measurementExport';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { GeoExportContext } from '../src/app/reportExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const UP: Vec3 = [0, 0, 1];
const ORIGIN: Vec3 = [400_000, 3_800_000, 100];
const UTM12: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
};
const GEO = (crs: ResolvedCrs | null): GeoExportContext => ({ origin: ORIGIN, crsName: crs?.name, name: 'scan.laz', crs });

const DIST: Measurement = { id: 'd1', kind: 'distance', name: 'Distance 1', points: [[1, 2, 3], [31, 42, 5]] };
const AREA: Measurement = {
  id: 'a1', kind: 'area', name: 'Area 1', closed: true,
  points: [[0, 0, 0], [20, 0, 0], [20, 10, 0], [0, 10, 0]],
};

function placed(crs: ResolvedCrs): MeasurementExportContext['lonLat'] {
  const r = geoJsonLonLat(GEO(crs), 'z');
  if ('refused' in r) throw new Error(r.refused);
  return r.lonLat;
}

function ctx(lonLat: MeasurementExportContext['lonLat']): MeasurementExportContext {
  return {
    toOutput: (p) => [p[0] + ORIGIN[0], p[1] + ORIGIN[1], p[2] + ORIGIN[2]],
    up: UP, unitToMetres: 1, verticalUnitToMetres: 1, crsName: UTM12.name, unitsVerified: true, lonLat,
  };
}

function kmlCoordinates(crs: ResolvedCrs, m: Measurement): number[][] {
  const r = resolveLocalToLonLat(crs, ORIGIN);
  if (!r.ok) throw new Error(r.reason);
  const kml = buildKml({
    annotations: [], measurements: [m], viewpoints: [], crsName: crs.name, unitLabel: 'm', up: UP,
    unitToMetres: 1, verticalUnitToMetres: crs.verticalUnitToMetres, verticalDatum: crs.verticalDatum ?? null,
    toLonLat: r.map, notSurveyGradeNote: 'Estimates only.',
  });
  const text = /<LineString>[\s\S]*?<coordinates>([^<]+)<\/coordinates>/.exec(kml)![1].trim();
  return text.split(/\s+/).map((t) => t.split(',').map(Number));
}

describe('measurement GeoJSON in WGS 84', () => {
  it('writes projected input as lon/lat that matches the site KML for the same record', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DIST], ctx(placed(UTM12))));
    const coords: number[][] = fc.features[0].geometry.coordinates;
    const kml = kmlCoordinates(UTM12, DIST);
    expect(coords).toHaveLength(kml.length);
    coords.forEach((c, i) => {
      expect(c).toHaveLength(2); // no vertical datum: 2D, as the KML
      expect(kml[i]).toHaveLength(2);
      expect(c[0]).toBeCloseTo(kml[i][0], 6);
      expect(c[1]).toBeCloseTo(kml[i][1], 6);
    });
    // UTM 12N, easting 400 km: west of the -111° meridian, ~34.3° N.
    expect(coords[0][0]).toBeGreaterThan(-113);
    expect(coords[0][0]).toBeLessThan(-111);
    expect(coords[0][1]).toBeCloseTo(34.33, 1);
  });

  it('carries no crs member, and closes polygon rings in lon/lat', () => {
    const fc = JSON.parse(measurementsToGeoJSON([DIST, AREA], ctx(placed(UTM12))));
    expect(fc).not.toHaveProperty('crs');
    const ring = fc.features[1].geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(fc.coordinate_note).toMatch(/2D/);
  });

  it('keeps the properties exactly as computed in the metric frame', () => {
    const lonLat = JSON.parse(measurementsToGeoJSON([DIST, AREA], ctx(placed(UTM12))));
    const metric = JSON.parse(measurementsToGeoJSON([DIST, AREA], { ...ctx(IDENTITY_LONLAT), toOutput: (p) => [p[0], p[1], p[2]] }));
    expect(lonLat.features.map((f: { properties: unknown }) => f.properties))
      .toEqual(metric.features.map((f: { properties: unknown }) => f.properties));
    expect(lonLat.features[0].properties.length_m).toBe(metric.features[0].properties.length_m);
    expect(lonLat.features[1].properties.area_m2).toBe(200);
  });

  it('writes a height only for a proven metric vertical datum, as the KML does', () => {
    const navd: ResolvedCrs = { ...UTM12, verticalDatum: 'NAVD88', verticalUnitToMetres: 1 };
    const fc = JSON.parse(measurementsToGeoJSON([DIST], ctx(placed(navd))));
    expect(fc.features[0].geometry.coordinates[0]).toHaveLength(3);
    expect(fc.features[0].geometry.coordinates[0][2]).toBe(103);
    expect(kmlCoordinates(navd, DIST)[0]).toHaveLength(3);
    const ellipsoidal: ResolvedCrs = { ...UTM12, verticalDatum: 'WGS 84 ellipsoid', verticalUnitToMetres: 1 };
    expect(JSON.parse(measurementsToGeoJSON([DIST], ctx(placed(ellipsoidal)))).features[0].geometry.coordinates[0]).toHaveLength(2);
    const feet: ResolvedCrs = { ...UTM12, verticalDatum: 'NAVD88', verticalUnitToMetres: 0.3048 };
    expect(JSON.parse(measurementsToGeoJSON([DIST], ctx(placed(feet)))).features[0].geometry.coordinates[0]).toHaveLength(2);
  });

  it('states the null-shift caveat for a NAD83 source', () => {
    const nad83: ResolvedCrs = { ...UTM12, name: 'NAD83 / UTM zone 12N', epsg: 26912 };
    const fc = JSON.parse(measurementsToGeoJSON([DIST], ctx(placed(nad83))));
    expect(fc.coordinate_note).toMatch(/NAD83/);
  });
});

describe('measurement GeoJSON refusals', () => {
  it.each([
    ['no CRS', null],
    ['a local frame', { ...UTM12, kind: 'local' } as ResolvedCrs],
    ['an unknown frame', { ...UTM12, kind: 'unknown' } as ResolvedCrs],
    ['NAD27', { ...UTM12, name: 'NAD27 / UTM zone 12N', epsg: 26712 }],
  ])('refuses %s and points to CSV', (_k, crs) => {
    const r = geoJsonLonLat(GEO(crs), 'z');
    expect('refused' in r && r.refused).toMatch(/GeoJSON export refused[\s\S]*CSV/);
  });

  it('refuses a Y-up frame', () => {
    const r = geoJsonLonLat(GEO(UTM12), 'y');
    expect('refused' in r).toBe(true);
  });

  it('the serializer refuses without a WGS 84 placement', () => {
    expect(() => measurementsToGeoJSON([DIST], { ...ctx(undefined) })).toThrow(GeoJsonLonLatError);
  });

  it('the action downloads nothing for a local scan and says why', async () => {
    const downloads: string[] = [];
    const refusals: string[] = [];
    const deps: MeasurementExportActionDeps = {
      measure: { getMeasurements: () => [DIST], worldUp: UP, unitToMetres: 1, verticalUnitToMetres: 1, crsKnown: false, geographicCrs: false },
      geo: () => GEO({ ...UTM12, kind: 'local' } as ResolvedCrs),
      upAxis: () => 'z',
      refuse: (m) => refusals.push(m),
      baseName: (n) => n.replace(/\.[^.]+$/, ''),
      downloadText: (f) => downloads.push(f),
      loadMeasurementExport: async () => serializers,
      loadMeasurementReport: async () => { throw new Error('unused'); },
      activeClassificationEpoch: () => 0,
      appVersion: '0.0.0',
      now: () => '2026-01-01T00:00:00.000Z',
    };
    await exportMeasurementsFile('geojson', deps);
    expect(downloads).toEqual([]);
    expect(refusals[0]).toMatch(/CSV/);
  });
});
