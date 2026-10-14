/**
 * volumeNoCoverage.test.ts: a footprint with no measured points has an unknown
 * volume, not a zero one; confidence cannot be 'high' while most of the
 * footprint is unobserved or excluded.
 */
import { describe, it, expect } from 'vitest';
import { volumeCutFill } from '../src/render/measure/volume';
import { deriveVolumeRecord, NO_USABLE_COVERAGE_REASON } from '../src/render/measure/measureDerivations';
import { stockpileResultHeadline } from '../src/render/measure/stockpileResult';
import { measurementMetrics } from '../src/export/measurementExport';
import { measurementsToFindings } from '../src/export/measurementReport';
import type { Measurement, Vec3 } from '../src/render/measure/types';

const UP: Vec3 = [0, 0, 1];
const SQUARE: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
const BIG: Vec3[] = [[0, 0, 0], [100, 0, 0], [100, 100, 0], [0, 100, 0]];

function lattice(size: number, step: number, h: number): Float32Array {
  const pts: number[] = [];
  const n = Math.round(size / step);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pts.push((i + 0.5) * step, (j + 0.5) * step, h);
  return new Float32Array(pts);
}

function asMeasurement(volume: Measurement['volume']): Measurement {
  return { id: 'v1', kind: 'volume', points: SQUARE, label: 'v', volume } as unknown as Measurement;
}

describe('no usable coverage', () => {
  const empty = deriveVolumeRecord(
    volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions: new Float32Array(0) }), 0,
  );

  it('withholds an empty cloud inside a valid footprint', () => {
    expect(empty.fill).toBeUndefined();
    expect(empty.cut).toBeUndefined();
    expect(empty.net).toBeUndefined();
    expect(empty.gridAuthority).toBe('withheld');
    expect(empty.gridAuthorityReason).toBe(NO_USABLE_COVERAGE_REASON);
    expect(empty.gridAuthorityReason).toMatch(/^No usable coverage/);
    expect(empty.confidence).toBe('low');
  });

  it('reads as withheld in the toast headline, never as a zero', () => {
    const head = stockpileResultHeadline(empty, 1);
    expect(head).toMatch(/Volume withheld \(No usable coverage/);
    expect(head).not.toMatch(/0\.00/);
  });

  it('exports no volume numbers and reports the reason', () => {
    const m = asMeasurement(empty);
    const metrics = measurementMetrics(m, UP, 1);
    expect(metrics.fill_m3).toBeUndefined();
    expect(metrics.cut_m3).toBeUndefined();
    expect(metrics.net_m3).toBeUndefined();
    const f = measurementsToFindings([m], UP, 1);
    expect(f[0].value).toBeNull();
    expect(f[0].caveats!.join(' ')).toMatch(/No usable coverage/);
  });

  it('withholds when the point-sample result reports no points', () => {
    const rec = deriveVolumeRecord(
      { fill: 0, cut: 0, net: 0, footprintArea: 50, pointsInPolygon: 0, sampleCount: 0, densityNative: 0, medianAbsDelta: NaN },
      0,
    );
    expect(rec.net).toBeUndefined();
    expect(rec.gridAuthority).toBe('withheld');
  });

  it('keeps a genuine zero: a flat observed surface at the reference height', () => {
    const rec = deriveVolumeRecord(volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions: lattice(10, 0.25, 0) }), 0);
    expect(rec.net).toBeCloseTo(0, 9);
    expect(rec.fill).toBeCloseTo(0, 9);
    expect(rec.gridAuthority).toBeUndefined();
    expect(rec.confidence).toBe('high');
  });
});

describe('confidence follows coverage', () => {
  it('is not high for 1,600 points clustered in ~5% of a large footprint', () => {
    // 40 x 40 points at 0.25 m: a 10 m x 10 m patch of a 100 m x 100 m footprint.
    const r = volumeCutFill({ polygon: BIG, referenceZ: 0, positions: lattice(10, 0.25, 1) });
    expect(r.pointsInPolygon).toBe(1600);
    const rec = deriveVolumeRecord(r, 0);
    expect(rec.confidence).not.toBe('high');
  });

  it('stays high for a well-covered footprint with many points', () => {
    const rec = deriveVolumeRecord(volumeCutFill({ polygon: SQUARE, referenceZ: 0, positions: lattice(10, 0.25, 1) }), 0);
    expect(rec.confidence).toBe('high');
    expect(rec.net).toBeCloseTo(100, 6);
  });

  it('caps by coverage tiers and ignores them when no coverage figure is carried', () => {
    const base = { fill: 1, cut: 0, net: 1, footprintArea: 50, pointsInPolygon: 5000, sampleCount: 5000, densityNative: 100, medianAbsDelta: 0.1 };
    expect(deriveVolumeRecord(base, 0).confidence).toBe('high');
    expect(deriveVolumeRecord({ ...base, coverageFraction: 0.7 }, 0).confidence).toBe('medium');
    expect(deriveVolumeRecord({ ...base, excludedFraction: 0.4 }, 0).confidence).toBe('medium');
    expect(deriveVolumeRecord({ ...base, coverageFraction: 0.4 }, 0).confidence).toBe('low');
    expect(deriveVolumeRecord({ ...base, coverageFraction: 0.95, excludedFraction: 0.05 }, 0).confidence).toBe('high');
  });
});
