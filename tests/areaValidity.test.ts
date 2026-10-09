/**
 * An Area ring that does not establish an area carries no area figure, in the
 * verdict, the chain totals and every export. Shoelace area and validity are
 * independent of the ring's offset.
 */
import { describe, it, expect } from 'vitest';
import { areaRingVerdict, areaWithheldReason } from '../src/render/measure/areaValidity';
import { signedArea2D, validatePolygon, isPolygonSelfIntersecting } from '../src/render/measure/polygonHygiene';
import {
  areaWithheldNote,
  measurementMetrics,
  measurementsToCsv,
  measurementsToGeoJSON,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import { buildKml } from '../src/export/kmlExport';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import { aggregate } from '../src/render/measure/measurementChains';
import type { Measurement, Vec3 } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
const CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]],
  up: UP,
  unitToMetres: 1,
  crsName: 'EPSG:32612',
};
const area = (points: Vec3[]): Measurement => ({ id: 'a', kind: 'area', name: 'Plot', points, closed: true });

const BOWTIE: Vec3[] = [[0, 0, 0], [2, 2, 0], [0, 2, 0], [2, 0, 0]];
const SQUARE: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [0, 2, 0]];

describe('shoelace area anchoring', () => {
  const ring = (ox: number, oy: number, s: number, cw = false) => {
    const r = [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }];
    const out = r.map((p) => ({ x: p.x + ox, y: p.y + oy }));
    return cw ? out.reverse() : out;
  };
  it('keeps a 1 cm square at a large offset', () => {
    expect(signedArea2D(ring(1e7, 1e7, 0.01))).toBeCloseTo(1e-4, 10);
  });
  it('is the same at every offset and either winding', () => {
    for (const o of [0, 1e3, 1e6, 1e7, 5e8]) {
      expect(signedArea2D(ring(o, o, 0.01))).toBeCloseTo(1e-4, 8);
      expect(signedArea2D(ring(o, -o, 0.01, true))).toBeCloseTo(-1e-4, 8);
      expect(validatePolygon(ring(o, o, 0.01)).validity).toBe('ok');
    }
  });
  it('keeps ordinary recentred results exact', () => {
    expect(signedArea2D(ring(0, 0, 10))).toBe(100);
  });
  it('accepts a tiny valid polygon', () => {
    expect(validatePolygon(ring(0, 0, 1e-6)).validity).toBe('ok');
  });
});

describe('areaRingVerdict', () => {
  it('accepts a simple square, either winding', () => {
    expect(areaRingVerdict(SQUARE).ok).toBe(true);
    expect(areaRingVerdict([...SQUARE].reverse()).ok).toBe(true);
  });
  it('refuses a bowtie', () => {
    const v = areaRingVerdict(BOWTIE);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe('self-intersecting');
  });
  it('refuses overlapping collinear edges', () => {
    const r: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 3, 0], [1, 0, 0], [1, 3, 0], [0, 3, 0]];
    expect(areaRingVerdict(r).ok).toBe(false);
  });
  it('refuses a vertex resting on a non-adjacent edge', () => {
    const r: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [2, 0, 0], [0, 4, 0]];
    expect(areaRingVerdict(r).ok).toBe(false);
  });
  it('refuses a ring that repeats a vertex elsewhere', () => {
    const r: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [4, 0, 0], [2, -3, 0]];
    expect(areaRingVerdict(r).ok).toBe(false);
  });
  it('accepts a doubled click and an explicit closing vertex', () => {
    expect(areaRingVerdict([SQUARE[0], SQUARE[1], SQUARE[1], SQUARE[2], SQUARE[3], SQUARE[0]]).ok).toBe(true);
  });
  it('refuses a non-finite vertex', () => {
    expect(areaRingVerdict([[0, 0, 0], [1, 0, 0], [1, Number.NaN, 0]]).ok).toBe(false);
    expect(areaRingVerdict([[0, 0, 0], [1, 0, 0], [Infinity, 1, 0]]).ok).toBe(false);
  });
  it('refuses collinear and too-few vertices', () => {
    expect(areaRingVerdict([[0, 0, 0], [1, 1, 1], [2, 2, 2]]).ok).toBe(false);
    expect(areaRingVerdict([[0, 0, 0], [1, 0, 0]]).ok).toBe(false);
  });
  it('accepts a valid concave ring', () => {
    const L: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 1, 0], [1, 1, 0], [1, 4, 0], [0, 4, 0]];
    expect(areaRingVerdict(L).ok).toBe(true);
    expect(isPolygonSelfIntersecting(L.map((p) => ({ x: p[0], y: p[1] })))).toBe(false);
  });
  it('accepts a vertical wall and a tilted plane', () => {
    const wall: Vec3[] = [[0, 0, 0], [3, 0, 0], [3, 0, 2], [0, 0, 2]];
    expect(areaRingVerdict(wall).ok).toBe(true);
    const tilt: Vec3[] = [[0, 0, 0], [4, 0, 2], [4, 3, 2], [0, 3, 0]];
    expect(areaRingVerdict(tilt).ok).toBe(true);
  });
  it('refuses a bowtie on a vertical wall', () => {
    expect(areaRingVerdict([[0, 0, 0], [2, 0, 2], [0, 0, 2], [2, 0, 0]]).ok).toBe(false);
  });
  it('is the same at a large offset', () => {
    const shift = (r: Vec3[]): Vec3[] => r.map((p) => [p[0] + 5e6, p[1] + 5e6, p[2] + 1e3]);
    expect(areaRingVerdict(shift(SQUARE)).ok).toBe(true);
    expect(areaRingVerdict(shift(BOWTIE)).ok).toBe(false);
  });
  it('refuses a ring far from any plane', () => {
    const tent: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 4, 0], [0, 4, 0], [2, 2, 9], [2, 2, -9]];
    expect(areaRingVerdict(tent).ok).toBe(false);
  });
  it('states the reason', () => {
    expect(areaWithheldReason(BOWTIE)).toMatch(/crosses itself/);
    expect(areaWithheldReason(SQUARE)).toBeUndefined();
  });
});

describe('exports of a ring with no area', () => {
  const bad = area(BOWTIE);
  const good = area(SQUARE);
  it('omits the area keys and keeps the perimeter', () => {
    const m = measurementMetrics(bad, UP, 1);
    expect('area_m2' in m).toBe(false);
    expect('horizontal_area_m2' in m).toBe(false);
    expect(m.perimeter_m).toBeGreaterThan(0);
    expect(measurementMetrics(good, UP, 1).area_m2).toBe(4);
  });
  it('states the reason in the CSV and leaves the cell empty', () => {
    const csv = measurementsToCsv([bad], CTX);
    const [head, row] = csv.split('\n');
    const cols = head.split(',');
    expect(row).toContain('Area withheld');
    expect(row.split(',')[cols.indexOf('area_m2')]).toBe('');
  });
  it('states the reason in GeoJSON and omits the area', () => {
    const f = JSON.parse(measurementsToGeoJSON([bad], CTX)).features[0].properties;
    expect(f.area_m2).toBeUndefined();
    expect(f.area_withheld).toMatch(/Area withheld/);
  });
  it('states the reason in KML', () => {
    const kml = buildKml({
      annotations: [],
      measurements: [bad],
      viewpoints: [],
      crsName: 'EPSG:32612',
      unitLabel: 'm',
      up: UP,
      unitToMetres: 1,
      toLonLat: (p) => [p[0], p[1], p[2]],
      notSurveyGradeNote: 'Estimates only.',
    });
    expect(kml).toContain('Area withheld');
    expect(kml).not.toContain('area_m2=');
  });
  it('records a null finding with the reason', () => {
    const [f] = measurementsToFindings([bad], UP, 1);
    expect(f.value).toBeNull();
    expect(f.caveats?.[0]).toMatch(/Area withheld/);
  });
  it('prints the reason in the report text, not a number', () => {
    const [row] = buildMeasurementRows([bad], 'metric', 1, UP, 1, true, false);
    expect(row.value).toMatch(/Area withheld/);
    expect(row.value).not.toMatch(/^0/);
  });
  it('leaves a valid ring untouched', () => {
    expect(areaWithheldNote(good, UP, 1)).toBeUndefined();
    expect(measurementsToCsv([good], CTX)).not.toContain('Area withheld');
  });
});

describe('imported records', () => {
  it('a session record with a crossing ring or a null vertex reports no area', () => {
    const json = '{"id":"i","kind":"area","name":"Imported","closed":true,"points":[[0,0,0],[2,2,0],[0,2,0],[2,0,0]]}';
    const m = JSON.parse(json) as Measurement;
    expect(areaWithheldNote(m, UP, 1)).toMatch(/Area withheld/);
    const malformed = { ...m, points: [[0, 0, 0], [1, 0, 0], [null, 1, 0]] } as unknown as Measurement;
    expect('area_m2' in measurementMetrics(malformed, UP, 1)).toBe(false);
  });
  it('chain totals skip a ring with no area', () => {
    const r = aggregate([area(BOWTIE), area(SQUARE)], 'sum', 'area', UP);
    expect(r.value).toBe(4);
  });
});
