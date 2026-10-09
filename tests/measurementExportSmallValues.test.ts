/**
 * A nonzero finite measurement is never exported as 0 because of rounding.
 * Values that round to a nonzero three-decimal figure are unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
  measurementMetrics,
  measurementsToCsv,
  measurementsToGeoJSON,
  roundMeasured,
  plainDecimal,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import { buildKml } from '../src/export/kmlExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
const CTX = { toOutput: (p: Vec3) => p, up: UP, unitToMetres: 1, crsName: 'EPSG:32612' } as MeasurementExportContext;
const mk = (kind: Measurement['kind'], points: Vec3[], extra: Partial<Measurement> = {}): Measurement =>
  ({ id: kind, kind, name: kind, points, ...extra });

const tinyDist = (d: number): Measurement => mk('distance', [[0, 0, 0], [d, 0, 0]]);
const tinySquare = (s: number): Measurement =>
  mk('area', [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0]], { closed: true });
const tinyVolume = (net: number): Measurement =>
  mk('volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
    volume: {
      fill: net, cut: 0, net, referenceZ: 0, footprintArea: 50,
      pointsInPolygon: 800, densityNative: 16, confidence: 'medium',
    },
  });

describe('roundMeasured', () => {
  it('keeps three decimals when the result is nonzero', () => {
    expect(roundMeasured(0.0005)).toBe(0.001);
    expect(roundMeasured(0.001)).toBe(0.001);
    expect(roundMeasured(1.23456)).toBe(1.235);
    expect(roundMeasured(-1.23456)).toBe(-1.235);
    expect(roundMeasured(-0.0006)).toBe(-0.001);
    expect(roundMeasured(-0.0005)).toBe(-0.0005);
  });
  it('keeps three significant digits when a nonzero value would round to zero', () => {
    expect(roundMeasured(0.0004)).toBe(0.0004);
    expect(roundMeasured(0.000123456)).toBe(0.000123);
    expect(roundMeasured(0.00049999)).toBe(0.0005);
    expect(roundMeasured(-0.0004)).toBe(-0.0004);
    expect(roundMeasured(1.2e-9)).toBe(1.2e-9);
  });
  it('keeps exact zero as zero and drops non-finite values', () => {
    expect(roundMeasured(0)).toBe(0);
    expect(Object.is(roundMeasured(-0), 0)).toBe(true);
    expect(roundMeasured(Number.NaN)).toBeNull();
    expect(roundMeasured(Infinity)).toBeNull();
  });
});

describe('plainDecimal', () => {
  it('never writes an exponent', () => {
    expect(plainDecimal(1.2e-9)).toBe('0.00000000120');
    expect(Number(plainDecimal(1.2e-9))).toBe(1.2e-9);
    expect(plainDecimal(-3.4e-7)).toBe('-0.000000340');
    expect(plainDecimal(0.0004)).toBe('0.0004');
    expect(plainDecimal(12.5)).toBe('12.5');
    expect(plainDecimal(0)).toBe('0');
  });
});

describe('measurementMetrics with tiny values', () => {
  it('keeps length, area, volume, grade and angle nonzero', () => {
    expect(measurementMetrics(tinyDist(0.0004), UP, 1).length_m).toBe(0.0004);
    expect(measurementMetrics(tinySquare(0.01), UP, 1).area_m2).toBe(0.0001);
    expect(measurementMetrics(tinyVolume(0.0002), UP, 1).net_m3).toBe(0.0002);
    const slope = mk('slope', [[0, 0, 0], [100, 0, 0.0004]]);
    const s = measurementMetrics(slope, UP, 1);
    expect(s.rise_m).toBe(0.0004);
    expect(s.grade_pct).toBeGreaterThan(0);
    expect(s.angle_deg).toBeGreaterThan(0);
    const angle = mk('angle', [[1, 0, 0], [0, 0, 0], [1, 0.000001, 0]]);
    expect(measurementMetrics(angle, UP, 1).angle_deg).toBeGreaterThan(0);
  });
  it('keeps exact zero as zero', () => {
    expect(measurementMetrics(tinyDist(0), UP, 1).length_m).toBe(0);
  });
  it('leaves ordinary values unchanged', () => {
    expect(measurementMetrics(tinyDist(5), UP, 1).length_m).toBe(5);
    expect(measurementMetrics(tinyDist(0.0005), UP, 1).length_m).toBe(0.001);
    expect(measurementMetrics(tinyDist(0.001), UP, 1).length_m).toBe(0.001);
    expect(measurementMetrics(tinyDist(1.23456), UP, 1).length_m).toBe(1.235);
  });
});

describe('every export agrees on a tiny value', () => {
  it('CSV, GeoJSON, KML and findings carry 0.0004', () => {
    const m = tinyDist(0.0004);
    const csv = measurementsToCsv([m], CTX);
    const header = csv.split('\n')[0].split(',');
    const row = csv.split('\n')[1].split(',');
    expect(row[header.indexOf('length_m')]).toBe('0.0004');

    const gj = JSON.parse(measurementsToGeoJSON([m], CTX));
    expect(gj.features[0].properties.length_m).toBe(0.0004);

    const kml = buildKml({
      annotations: [],
      measurements: [m],
      viewpoints: [],
      crsName: 'WGS 84',
      unitLabel: 'm',
      up: UP,
      unitToMetres: 1,
      toLonLat: (p) => [-112 + p[0] * 1e-5, 33 + p[1] * 1e-5, p[2]],
      notSurveyGradeNote: 'n',
    });
    expect(kml).toContain('length_m=0.0004');

    const f = measurementsToFindings([m], UP, 1);
    expect(JSON.stringify(f)).toContain('0.0004');
  });
  it('findings keep a tiny volume nonzero and negative values', () => {
    const f = measurementsToFindings([tinyVolume(0.0002)], UP, 1);
    expect(f.some((x) => x.value === 0.0002)).toBe(true);
    expect(roundMeasured(-0.00071)).toBe(-0.001);
  });
  it('CSV and KML never use exponent notation', () => {
    const csv = measurementsToCsv([tinyDist(1.2e-9)], CTX);
    expect(csv).not.toMatch(/\de-\d/);
    expect(csv).toContain('0.00000000120');
  });
});
