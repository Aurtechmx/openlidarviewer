/**
 * distanceCsvRunRiseGrade.test.ts
 *
 * The Measure panel shows a Distance's run, rise and grade beside its length.
 * The CSV left horizontal_m, vertical_m, rise_m, run_m and grade_pct empty for
 * the same measurement; they now carry the figures the panel shows, and a
 * formula-looking cell stays neutralised.
 */

import { describe, it, expect } from 'vitest';
import {
  measurementMetrics,
  measurementsToCsv,
  type MeasurementExportContext,
} from '../src/export/measurementExport';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { IDENTITY_LONLAT } from './helpers/geoJsonLonLat';

const UP: Vec3 = [0, 0, 1];
const CTX: MeasurementExportContext = {
  toOutput: (p) => [p[0], p[1], p[2]], lonLat: IDENTITY_LONLAT, up: UP, unitToMetres: 1, crsName: 'EPSG:32612',
};
const D: Measurement = { id: 'd', kind: 'distance', name: '=cmd', points: [[0, 0, 0], [30, 40, 5]] };

describe('distance figures in the measurement exports', () => {
  it('carries run, rise and grade beside the length', () => {
    const m = measurementMetrics(D, UP, 1);
    expect(m.horizontal_m).toBe(50);
    expect(m.run_m).toBe(50);
    expect(m.vertical_m).toBe(5);
    expect(m.rise_m).toBe(5);
    expect(m.grade_pct).toBe(10);
  });

  it('fills the CSV columns and keeps the formula guard', () => {
    const [header, row] = measurementsToCsv([D], CTX).trim().split('\n');
    const cols = header!.split(',');
    const cells = row!.split(',');
    const at = (k: string): string => cells[cols.indexOf(k)] ?? '';
    expect(at('horizontal_m')).toBe('50');
    expect(at('run_m')).toBe('50');
    expect(at('vertical_m')).toBe('5');
    expect(at('rise_m')).toBe('5');
    expect(at('grade_pct')).toBe('10');
    expect(row).not.toMatch(/(^|,)=cmd/);
  });
});
