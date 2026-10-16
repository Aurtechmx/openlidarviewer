/**
 * RFC 7946 §3.1.6: a Polygon's exterior ring is counter-clockwise. An Area
 * measurement picked clockwise and a footprint traced clockwise are both
 * written counter-clockwise; one picked counter-clockwise is left as picked.
 */
import { describe, it, expect } from 'vitest';
import { measurementsToGeoJSON, type MeasurementExportContext } from '../src/export/measurementExport';
import { footprintsToGeoJson } from '../src/features/footprintGeoJson';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]],
  lonLat: IDENTITY_LONLAT,
  up: [0, 0, 1],
  unitToMetres: 1,
  crsName: 'EPSG:4326',
};

function signedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2;
}

const CW: Vec3[] = [[-100.001, 40.0, 1], [-100.001, 40.001, 2], [-100.0, 40.001, 3], [-100.0, 40.0, 4]];

function ringOf(points: Vec3[]): number[][] {
  const m: Measurement = { id: 'a', kind: 'area', name: 'ring', points, closed: true };
  const fc = JSON.parse(measurementsToGeoJSON([m], CTX));
  return fc.features[0].geometry.coordinates[0] as number[][];
}

describe('GeoJSON Polygon exterior ring winding', () => {
  it('writes a clockwise-picked Area ring counter-clockwise and closed', () => {
    const ring = ringOf(CW);
    expect(signedArea(ring)).toBeGreaterThan(0);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(5);
  });

  it('keeps a counter-clockwise Area ring in the order it was picked', () => {
    const ccw = CW.slice().reverse();
    const ring = ringOf(ccw);
    expect(signedArea(ring)).toBeGreaterThan(0);
    expect(ring.slice(0, 4).map((p) => [p[0], p[1]])).toEqual(ccw.map((p) => [p[0], p[1]]));
  });

  it('keeps the source elevations aligned with the reversed vertices', () => {
    const ctx = { ...CTX, lonLat: { ...IDENTITY_LONLAT, sourceHeights: { verticalDatum: null, unit: 'metre' } } } as unknown as MeasurementExportContext;
    const m: Measurement = { id: 'a', kind: 'area', name: 'ring', points: CW, closed: true };
    const fc = JSON.parse(measurementsToGeoJSON([m], ctx));
    const f = fc.features[0];
    const ring = f.geometry.coordinates[0] as number[][];
    const elev = f.properties.elevations_source as number[];
    expect(elev).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      const src = CW.find((p) => p[0] === ring[i][0] && p[1] === ring[i][1])!;
      expect(elev[i]).toBe(src[2]);
    }
  });

  it('writes a clockwise building footprint counter-clockwise', () => {
    const ring = CW.map((p) => ({ x: p[0], y: p[1] }));
    const fc = footprintsToGeoJson([{ ring, areaSource: 1, centroidX: 0, centroidY: 0 } as never]);
    const coords = (fc.features[0].geometry as { coordinates: number[][][] }).coordinates[0];
    expect(signedArea(coords)).toBeGreaterThan(0);
    expect(coords[0]).toEqual(coords[coords.length - 1]);
  });
});
