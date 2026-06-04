/**
 * civilProfileStats.test.ts — civil/topographic stats over a profile.
 */

import { describe, it, expect } from 'vitest';
import {
  computeCivilProfileStats,
  formatStationing,
  formatGradePercent,
  formatGradeRatio,
  formatGradeDegrees,
} from '../src/render/measure/civilProfileStats';
import type { ProfileChartSample } from '../src/render/measure/types';

const s = (distance: number, height: number): ProfileChartSample => ({ distance, height });

describe('computeCivilProfileStats', () => {
  it('computes length, relief, mean and max grade on a clean profile', () => {
    // 0,10,20,30 m chainage; elevations rise then fall.
    const stats = computeCivilProfileStats([s(0, 100), s(10, 102), s(20, 108), s(30, 105)]);
    expect(stats.length).toBe(30);
    expect(stats.sampleCount).toBe(4);
    expect(stats.coverage).toBe(1);
    expect(stats.minElevation).toBe(100);
    expect(stats.maxElevation).toBe(108);
    expect(stats.reliefSpan).toBe(8);
    // net grade (105-100)/30
    expect(stats.meanGrade).toBeCloseTo(5 / 30, 6);
    // steepest adjacent segment is 20→30: (108? no, 108→105 = -0.3) vs 10→20: 6/10=0.6
    expect(stats.maxGrade).toBeCloseTo(0.6, 6);
    // per-segment grade to next
    expect(stats.stations[1].gradeToNext).toBeCloseTo(0.6, 6);
    expect(stats.stations[3].gradeToNext).toBeNull(); // last station
  });

  it('treats NaN bins as gaps: null elevation and null grade across them', () => {
    const stats = computeCivilProfileStats([s(0, 50), s(10, NaN), s(20, 56)]);
    expect(stats.coverage).toBeCloseTo(2 / 3, 6);
    expect(stats.stations[1].elevation).toBeNull();
    // segment 0→1 touches a gap → no grade; 1→2 touches a gap → no grade
    expect(stats.stations[0].gradeToNext).toBeNull();
    expect(stats.stations[1].gradeToNext).toBeNull();
    // mean grade uses first/last covered (0→20): (56-50)/20
    expect(stats.meanGrade).toBeCloseTo(6 / 20, 6);
  });

  it('returns nulls when nothing is covered', () => {
    const stats = computeCivilProfileStats([s(0, NaN), s(10, NaN)]);
    expect(stats.minElevation).toBeNull();
    expect(stats.reliefSpan).toBeNull();
    expect(stats.meanGrade).toBeNull();
    expect(stats.maxGrade).toBeNull();
    expect(stats.coverage).toBe(0);
  });
});

describe('civil formatters', () => {
  it('formats metric stationing as km+metres', () => {
    expect(formatStationing(0)).toBe('0+000.00');
    expect(formatStationing(116.73)).toBe('0+116.73');
    expect(formatStationing(1234.5)).toBe('1+234.50');
  });

  it('formats grade as percent, ratio and degrees', () => {
    expect(formatGradePercent(0.024)).toBe('2.40%');
    expect(formatGradeRatio(0.02)).toBe('1:50'); // shallow slope → integer ratio
    expect(formatGradeRatio(0.5)).toBe('1:2.0'); // steep → one decimal
    expect(formatGradeRatio(0)).toBe('level');
    expect(formatGradeDegrees(0)).toBe('0.0°');
    expect(formatGradePercent(null)).toBe('—');
  });
});
