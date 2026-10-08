/**
 * A chain total must agree with the single-measurement figure the exports and
 * the panel publish. Scaling the native result by one combined factor is wrong
 * whenever the figure mixes axes on a compound CRS: a 3D length, a tilted area,
 * a grade or an angle. And on a geographic or unconfirmed scale the chain must
 * never call its result metres.
 */
import { describe, expect, it } from 'vitest';
import type { Measurement, MeasurementKind, Vec3 } from '../src/render/measure/types';
import { GEOGRAPHIC_NOT_AVAILABLE } from '../src/render/measure/types';
import {
  aggregate,
  formatChainResult,
  type ChainDimension,
} from '../src/render/measure/measurementChains';
import { measurementMetrics } from '../src/export/measurementExport';

const UP: Vec3 = [0, 0, 1];
const FOOT = 0.3048;

function mk(id: string, kind: MeasurementKind, points: Vec3[], extra: Partial<Measurement> = {}): Measurement {
  return { id, kind, name: '', points, ...extra } as Measurement;
}

const DIST = mk('d', 'distance', [[0, 0, 0], [1, 0, 1]]);
const PROFILE = mk('p', 'profile', [[0, 0, 0], [10, 0, 10]]);
const SLOPE = mk('s', 'slope', [[0, 0, 0], [10, 0, 10]]);
const AREA = mk('r', 'area', [[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]], { closed: true });
const ANGLE = mk('a', 'angle', [[1, 0, 1], [0, 0, 0], [1, 0, 0]]);
const HEIGHT = mk('h', 'height', [[0, 0, 0], [0, 0, 10]]);
const BOX = mk('b', 'box', [[0, 0, 0], [2, 3, 4]]);
const VOLUME = mk('v', 'volume', [[0, 0, 0], [10, 0, 0], [10, 10, 0]], {
  volume: { cut: 2, fill: 10, net: 8, footprintArea: 50 },
} as Partial<Measurement>);

/** The exporter's figure for (measurement, metric key) on metre/foot axes. */
function exported(m: Measurement, key: string, fH = 1, fV = FOOT): number {
  return measurementMetrics(m, UP, fH, fV, 6)[key];
}

function one(m: Measurement, dim: ChainDimension, fH = 1, fV = FOOT) {
  return aggregate([m], 'sum', dim, UP, fH, fV);
}

describe('chain totals on a compound CRS (metre horizontal, foot vertical)', () => {
  it('a one-row chain equals that row, for every mixed-axis figure', () => {
    expect(one(DIST, 'length').value).toBeCloseTo(exported(DIST, 'length_m'), 5);
    expect(one(DIST, 'length').value).toBeCloseTo(1.04542, 4);
    expect(one(PROFILE, 'length').value).toBeCloseTo(exported(PROFILE, 'length_m'), 5);
    expect(one(PROFILE, 'grade').value).toBeCloseTo(30.48, 4);
    expect(one(SLOPE, 'grade').value).toBeCloseTo(exported(SLOPE, 'grade_pct'), 4);
    expect(one(SLOPE, 'length').value).toBeCloseTo(Math.hypot(10, 10 * FOOT), 5);
    expect(one(AREA, 'area').value).toBeCloseTo(exported(AREA, 'area_m2'), 5);
    expect(one(AREA, 'area').value).toBeCloseTo(1.04542, 4);
    expect(one(ANGLE, 'angle').value).toBeCloseTo(exported(ANGLE, 'angle_deg'), 4);
    expect(one(ANGLE, 'angle').value).toBeCloseTo(16.951, 3);
  });

  it('heights, box figures and stored volumes keep their per-axis factors', () => {
    expect(one(HEIGHT, 'height').value).toBeCloseTo(10 * FOOT, 6);
    expect(one(PROFILE, 'height').value).toBeCloseTo(10 * FOOT, 6);
    expect(one(BOX, 'area').value).toBeCloseTo(6, 6);
    expect(one(BOX, 'volume-fill').value).toBeCloseTo(exported(BOX, 'volume_m3'), 5);
    expect(one(VOLUME, 'volume-fill').value).toBeCloseTo(10 * FOOT, 6);
    expect(one(VOLUME, 'volume-net').value).toBeCloseTo(8 * FOOT, 6);
    expect(one(VOLUME, 'area').value).toBeCloseTo(50, 6);
    // Foot horizontal: stored volume is horizontal squared times vertical.
    expect(one(VOLUME, 'volume-cut', FOOT, 1).value).toBeCloseTo(2 * FOOT * FOOT, 6);
  });

  it('multi-row aggregates combine the per-row figures', () => {
    const rows = [DIST, PROFILE, SLOPE];
    const each = rows.map((m) => one(m, 'length').value);
    expect(aggregate(rows, 'sum', 'length', UP, 1, FOOT).value).toBeCloseTo(each[0] + each[1] + each[2], 6);
    expect(aggregate(rows, 'mean', 'length', UP, 1, FOOT).value).toBeCloseTo((each[0] + each[1] + each[2]) / 3, 6);
    expect(aggregate(rows, 'max', 'length', UP, 1, FOOT).value).toBeCloseTo(Math.max(...each), 6);
    expect(aggregate([PROFILE, SLOPE], 'mean', 'grade', UP, 1, FOOT).value).toBeCloseTo(30.48, 4);
  });

  it('a single-unit CRS is unchanged', () => {
    expect(one(DIST, 'length', FOOT, FOOT).value).toBeCloseTo(Math.SQRT2 * FOOT, 6);
    expect(one(PROFILE, 'grade', FOOT, FOOT).value).toBeCloseTo(100, 6);
    expect(one(ANGLE, 'angle', 1, 1).value).toBeCloseTo(45, 6);
    expect(one(AREA, 'area', 1, 1).value).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe('chain totals on an unconfirmed or geographic scale', () => {
  const dims: ChainDimension[] = ['length', 'area', 'volume-fill', 'volume-cut', 'volume-net', 'height', 'angle', 'grade'];
  const all = [DIST, PROFILE, SLOPE, AREA, ANGLE, HEIGHT, BOX, VOLUME];

  it('an unverified scale names source units, never metres', () => {
    for (const d of dims) {
      const r = aggregate(all, 'sum', d, UP, 1, 1, { unitsVerified: false });
      expect(r.unit, d).not.toMatch(/^m/);
      expect(formatChainResult(r), d).not.toMatch(/\bm[²³]?$/);
    }
    expect(aggregate([DIST], 'sum', 'length', UP, 1, 1, { unitsVerified: false }).unit).toBe('source units');
  });

  it('a geographic frame refuses every figure but height, and never says metres', () => {
    for (const d of dims) {
      const r = aggregate(all, 'sum', d, UP, 1, 1, { geographic: true });
      expect(r.unit, d).not.toMatch(/^m/);
      if (d === 'height') {
        expect(r.refusal).toBeUndefined();
        expect(r.value).toBeCloseTo(10 + 10 + 10, 6);
      } else {
        expect(r.refusal, d).toBe(GEOGRAPHIC_NOT_AVAILABLE);
        expect(formatChainResult(r), d).toBe(GEOGRAPHIC_NOT_AVAILABLE);
      }
    }
  });
});
