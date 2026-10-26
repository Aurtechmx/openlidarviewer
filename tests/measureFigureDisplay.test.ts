/**
 * Measurement figures as displayed: the volume bands, imperial stationing,
 * the PDF report's imperial volume and profile average grade, and the chain
 * total. Each case states the reference value it is checked against.
 */
import { describe, it, expect } from 'vitest';
import { formatVolume } from '../src/render/measure/format';
import { formatStation } from '../src/render/measure/profileSummary';
import { summariseSlopes } from '../src/render/measure/profileStations';
import { aggregate, formatChainResult } from '../src/render/measure/measurementChains';
import { buildMeasurementRows } from '../src/report/ReportMeasurementSection';
import type { Measurement, ProfileChartSample } from '../src/render/measure/types';

/** The number a volume string states, in cubic metres. */
function statedM3(shown: string): number {
  const n = Number(shown.replace(/[^0-9.]/g, ''));
  if (shown.endsWith('km³')) return n * 1e9;
  if (shown.endsWith('dm³')) return n / 1000;
  return n;
}

describe('formatVolume', () => {
  it.each([2_345_678, 1_499_000, 999_999_999])('%d m³ stays in cubic metres at its own precision', (v) => {
    const shown = formatVolume(v, 'metric');
    expect(shown).toMatch(/ m³$/);
    expect(Math.abs(statedM3(shown) - v)).toBeLessThanOrEqual(0.005);
  });

  it('switches to km³ at a cubic kilometre, with significant figures', () => {
    expect(formatVolume(2_345_678_901, 'metric')).toBe('2.3457 km³');
    expect(formatVolume(1e9, 'metric')).toBe('1.0000 km³');
  });

  it('a nonzero volume below a cubic decimetre is not shown as zero', () => {
    expect(formatVolume(0.0004, 'metric')).toBe('0.4000 dm³');
    expect(formatVolume(0.25, 'metric')).toBe('250.00 dm³');
    expect(formatVolume(0.0004, 'imperial')).not.toMatch(/^0(\.0+)? ft³$/);
  });

  it('keeps the cubic-metre and cubic-yard bands as they were', () => {
    expect(formatVolume(304.8, 'metric')).toBe('304.80 m³');
    expect(formatVolume(1000 * 0.3048 ** 3, 'imperial')).toBe('37.04 yd³');
  });
});

describe('formatStation imperial', () => {
  it('rounds before splitting the 100 ft station', () => {
    expect(formatStation(199.996 * 0.3048, 'imperial')).toBe('2+00.00');
    expect(formatStation(99.999 * 0.3048, 'imperial')).toBe('1+00.00');
    expect(formatStation(113.45 * 0.3048, 'imperial')).toBe('1+13.45');
    expect(formatStation(0, 'imperial')).toBe('0+00.00');
    expect(formatStation(-0.001 * 0.3048, 'imperial')).toBe('0+00.00');
    expect(formatStation(-150 * 0.3048, 'imperial')).toBe('-1+50.00');
  });
});

describe('PDF report imperial volume', () => {
  it('converts with the exact yard (1 / 0.9144³ yd³ per m³)', () => {
    const m = { id: 'b', kind: 'box', name: 'B', points: [[0, 0, 0], [100, 100, 100]] } as unknown as Measurement;
    const v = buildMeasurementRows([m], 'imperial')[0].value;
    expect(Number(v.replace(/[^0-9.]/g, ''))).toBeCloseTo(1e6 / 0.9144 ** 3, 1);
  });
});

describe('profile average grade', () => {
  it('weighs each segment by its run (total rise over total run)', () => {
    const s = summariseSlopes([
      { fromIndex: 0, toIndex: 1, run: 20, rise: 0, gradePercent: 0, gradeDegrees: 0 },
      { fromIndex: 1, toIndex: 2, run: 3, rise: 3, gradePercent: 100, gradeDegrees: 45 },
    ]);
    expect(s.avgGradePercent).toBeCloseTo((3 / 23) * 100, 9);
    expect(s.maxGradePercent).toBe(100);
    expect(s.minGradePercent).toBe(0);
  });

  it('the PDF slope line prints the net rise over run', () => {
    // Stations every 5 m to 23 m. Flat to chainage 20, then up 3 m by 23.
    const samples: ProfileChartSample[] = [];
    for (let d = 0; d <= 23; d += 0.5) samples.push({ distance: d, height: d <= 20 ? 0 : d - 20, count: 5 });
    samples.push({ distance: 23, height: 3, count: 5 });
    const m = { id: 'p', kind: 'profile', name: 'P', points: [[0, 0, 0], [23, 0, 3]], profileChart: samples } as unknown as Measurement;
    const slope = buildMeasurementRows([m], 'metric')[0].profileExtras!.slopeSummary;
    const net = Number(/Net \+?(-?[0-9.]+)% \(total rise ÷ total run\)/.exec(slope)![1]);
    expect(net).toBeCloseTo((3 / 23) * 100, 1);
    expect(slope).not.toMatch(/Avg/);
  });
});

describe('chain total display', () => {
  const dist = (len: number): Measurement =>
    ({ id: `d${len}`, kind: 'distance', name: 'd', points: [[0, 0, 0], [len, 0, 0]] }) as unknown as Measurement;

  it('a 3 mm sum keeps its significant figures', () => {
    const r = aggregate([dist(0.003)], 'sum', 'length');
    expect(r.value).toBeCloseTo(0.003, 12);
    expect(formatChainResult(r)).toBe('0.3000 cm');
  });

  it('reads in the active unit system', () => {
    const r = aggregate([dist(3.048)], 'sum', 'length');
    expect(formatChainResult(r, 'imperial')).toBe('10.000 ft');
    expect(formatChainResult(r, 'metric')).toBe('3.0480 m');
  });

  it('a net volume below zero keeps its sign', () => {
    const v = {
      id: 'v', kind: 'volume', name: 'v', closed: true,
      points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
      volume: { cut: 5, fill: 2, net: -3, footprintArea: 1 },
    } as unknown as Measurement;
    const r = aggregate([v], 'sum', 'volume-net');
    expect(r.value).toBeCloseTo(-3, 9);
    expect(formatChainResult(r)).toBe('-3.00 m³');
  });

  it('source units keep the significant-figure policy without converting', () => {
    const r = aggregate([dist(0.003)], 'sum', 'length', [0, 0, 1], 1, 1, { unitsVerified: false });
    expect(formatChainResult(r, 'imperial')).toBe('0.0030 source units');
  });
});
