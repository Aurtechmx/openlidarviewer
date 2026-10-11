/**
 * Three export defects from the v0.7.0 release audit:
 *  1. GeoJSON wrote an orthometric (NAVD88) elevation as the RFC 7946 third
 *     coordinate, which RFC 7946 section 4 defines as WGS 84 ellipsoidal height.
 *  2. A valid vertical wall / vertical line collapsed to a degenerate
 *     Polygon / LineString once written as 2D lon/lat.
 *  3. An angle with a zero-length arm was published as 0°.
 */
import { describe, it, expect } from 'vitest';
import { geoJsonLonLat } from '../src/app/measurementExportActions';
import { measurementsToGeoJSON, measurementMetrics, measurementsToCsv } from '../src/export/measurementExport';
import { buildKml, kmlAltitudeMode, type KmlExportInput } from '../src/export/kmlExport';
import { angleAtVertex } from '../src/render/measure/geometry';
import { formatArmAngle } from '../src/render/measure/format';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Measurement } from '../src/render/measure/types';

const crs: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 12N', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1,
  verticalUnitToMetres: 1, verticalDatum: 'NAVD88', source: 'las-vlr', confidence: 'high', userConfirmed: false,
};
const origin: [number, number, number] = [400000, 3800000, 100];

function ctxFor(c: ResolvedCrs) {
  const placement = geoJsonLonLat({ origin, crsName: c.name, name: 'test.las', crs: c }, 'z');
  if ('refused' in placement) throw new Error(placement.refused);
  return {
    toOutput: (p: readonly number[]) => [p[0] + origin[0], p[1] + origin[1], p[2] + origin[2]] as [number, number, number],
    up: [0, 0, 1] as [number, number, number],
    unitToMetres: 1,
    verticalUnitToMetres: 1,
    unitsVerified: true,
    crsName: c.name,
    lonLat: placement.lonLat,
  };
}

const line: Measurement = { id: 'd', name: 'distance', kind: 'distance', points: [[0, 0, 3], [10, 0, 3]] };
const wall: Measurement = { id: 'w', name: 'wall', kind: 'area', closed: true, points: [[0, 0, 0], [10, 0, 0], [10, 0, 5], [0, 0, 5]] };

describe('GeoJSON height policy (RFC 7946 ellipsoidal heights)', () => {
  it('does not emit a NAVD88 elevation as the third coordinate', () => {
    const fc = JSON.parse(measurementsToGeoJSON([line], ctxFor(crs)));
    expect(fc.features[0].geometry.coordinates[0]).toHaveLength(2);
    expect(fc.coordinate_note).toMatch(/2D/);
    expect(fc.coordinate_note).toMatch(/ellipsoid/);
    expect(fc.coordinate_note).toMatch(/NAVD88/);
  });

  it('keeps the source elevations, datum and unit unconverted in properties', () => {
    const fc = JSON.parse(measurementsToGeoJSON([line], ctxFor(crs)));
    expect(fc.features[0].properties.elevations_source).toEqual([103, 103]);
    expect(fc.vertical_reference.elevations_source_datum).toBe('NAVD88');
    expect(fc.vertical_reference.elevations_source_unit).toBe('metre');
  });

  it('passes a WGS 84 ellipsoidal (EPSG:4979) metre height through as the third coordinate', () => {
    const fc = JSON.parse(measurementsToGeoJSON([line], ctxFor({ ...crs, verticalDatum: 'EPSG:4979' })));
    expect(fc.features[0].geometry.coordinates[0]).toHaveLength(3);
    expect(fc.features[0].geometry.coordinates[0][2]).toBe(103);
  });

  it('stays 2D for an ellipsoidal height in feet', () => {
    const fc = JSON.parse(measurementsToGeoJSON([line], ctxFor({ ...crs, verticalDatum: 'EPSG:4979', verticalUnitToMetres: 0.3048 })));
    expect(fc.features[0].geometry.coordinates[0]).toHaveLength(2);
  });
});

describe('KML absolute altitude states the geoid mismatch', () => {
  it('names EGM96 and the NAVD88 offset when writing NAVD88 as absolute', () => {
    const r = kmlAltitudeMode('NAVD88', 1);
    expect(r.mode).toBe('absolute');
    expect(r.reason).toMatch(/EGM96/);
    expect(r.reason).toMatch(/1–2 m/);
  });
  it('makes no mismatch claim for an EGM96 height', () => {
    expect(kmlAltitudeMode('EPSG:5773', 1).reason).not.toMatch(/differ/);
  });
});

describe('collapsed geometry', () => {
  it('writes a vertical wall as geometry null with a reason and its area kept', () => {
    const fc = JSON.parse(measurementsToGeoJSON([wall], ctxFor({ ...crs, verticalDatum: undefined })));
    const f = fc.features[0];
    expect(f.geometry).toBeNull();
    expect(f.properties.geometry_withheld).toMatch(/no plan area/);
    expect(f.properties.area_m2).toBe(50);
  });

  it('writes a purely vertical distance as geometry null with a reason', () => {
    const v: Measurement = { id: 'v', name: 'v', kind: 'distance', points: [[0, 0, 0], [0, 0, 7]] };
    const f = JSON.parse(measurementsToGeoJSON([v], ctxFor(crs))).features[0];
    expect(f.geometry).toBeNull();
    expect(f.properties.geometry_withheld).toMatch(/single longitude\/latitude/);
    expect(f.properties.length_m).toBe(7);
  });

  it('keeps a plan polygon as a valid Polygon', () => {
    const flat: Measurement = { ...wall, points: [[0, 0, 0], [10, 0, 0], [10, 5, 0], [0, 5, 0]] };
    const f = JSON.parse(measurementsToGeoJSON([flat], ctxFor(crs))).features[0];
    expect(f.geometry.type).toBe('Polygon');
    expect(f.geometry.coordinates[0]).toHaveLength(5);
  });

  const kmlInput = (over: Partial<KmlExportInput>): KmlExportInput => ({
    annotations: [], measurements: [wall], viewpoints: [], crsName: 'test', unitLabel: 'm', up: [0, 0, 1],
    unitToMetres: 1, verticalUnitToMetres: 1, toLonLat: (p) => [p[0] * 1e-5 + 10, p[1] * 1e-5 + 50, p[2]],
    notSurveyGradeNote: 'n', ...over,
  });

  it('KML clamped to ground: a vertical wall carries no geometry, only its description', () => {
    const kml = buildKml(kmlInput({ verticalDatum: undefined }));
    expect(kml).not.toContain('<Polygon>');
    expect(kml).toMatch(/no plan area/);
  });

  it('KML with absolute altitude keeps the 3D wall polygon', () => {
    expect(buildKml(kmlInput({ verticalDatum: 'EPSG:5703' }))).toContain('<Polygon>');
  });
});

describe('angle with a zero-length arm', () => {
  it('is undefined, not 0°', () => {
    expect(angleAtVertex([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBeNaN();
    expect(angleAtVertex([1, 0, 0], [0, 0, 0], [0, 0, 0])).toBeNaN();
    expect(formatArmAngle(Number.NaN)).toBe('undefined (zero-length arm)');
  });

  it('keeps legitimate 0° and 180° angles with two non-zero arms', () => {
    expect(angleAtVertex([1, 0, 0], [0, 0, 0], [2, 0, 0])).toBe(0);
    expect(angleAtVertex([1, 0, 0], [0, 0, 0], [-1, 0, 0])).toBe(180);
    // Large coordinates: a real 1 cm arm is still an arm.
    expect(angleAtVertex([500000.01, 4e6, 0], [500000, 4e6, 0], [500001, 4e6, 0])).toBe(0);
  });

  it('omits angle_deg and states why in the GeoJSON and CSV', () => {
    const m: Measurement = { id: 'a', name: 'angle', kind: 'angle', points: [[0, 0, 0], [0, 0, 0], [1, 0, 0]] };
    expect(measurementMetrics(m, [0, 0, 1], 1)).not.toHaveProperty('angle_deg');
    const f = JSON.parse(measurementsToGeoJSON([m], ctxFor(crs))).features[0];
    expect(f.properties.angle_withheld).toMatch(/zero length/);
    expect(measurementsToCsv([m], ctxFor(crs))).toMatch(/zero length/);
  });
});
