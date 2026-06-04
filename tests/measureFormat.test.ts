import { describe, it, expect } from 'vitest';
import {
  formatLength,
  formatArea,
  formatAngle,
  formatGrade,
  formatBearing,
} from '../src/render/measure/format';
import { formatDistance } from '../src/render/navMath';

describe('formatBearing', () => {
  it('zero-pads whole-degree azimuths to three digits', () => {
    expect(formatBearing(0)).toBe('000°');
    expect(formatBearing(42)).toBe('042°');
    expect(formatBearing(359.6)).toBe('000°'); // rounds to 360 → wraps to 0
    expect(formatBearing(180)).toBe('180°');
  });

  it('renders an em dash for a non-finite bearing', () => {
    expect(formatBearing(Number.NaN)).toBe('—');
  });
});

describe('formatLength', () => {
  it('metric matches the v0.1.0 distance formatter', () => {
    for (const m of [0.25, 0.5, 5, 42.7, 1500]) {
      expect(formatLength(m, 'metric')).toBe(formatDistance(m));
    }
  });

  it('metric uses cm / m / km bands', () => {
    expect(formatLength(0.5, 'metric')).toBe('50.0 cm');
    expect(formatLength(5, 'metric')).toBe('5.00 m');
    expect(formatLength(1500, 'metric')).toBe('1.500 km');
  });

  it('imperial uses in / ft / mi bands', () => {
    expect(formatLength(0.1, 'imperial')).toBe('3.9 in');
    expect(formatLength(1, 'imperial')).toBe('3.28 ft');
    expect(formatLength(2000, 'imperial')).toBe('1.243 mi');
  });

  it('returns a dash for a non-finite length', () => {
    expect(formatLength(Infinity, 'metric')).toBe('—');
    expect(formatLength(NaN, 'imperial')).toBe('—');
  });
});

describe('formatArea', () => {
  it('metric uses m² then km²', () => {
    expect(formatArea(100, 'metric')).toBe('100.00 m²');
    expect(formatArea(2_000_000, 'metric')).toBe('2.000 km²');
  });

  it('imperial uses ft² then acres', () => {
    expect(formatArea(100, 'imperial')).toBe('1,076.4 ft²');
    expect(formatArea(5000, 'imperial')).toBe('1.236 acre');
  });

  it('returns a dash for an invalid area', () => {
    expect(formatArea(NaN, 'metric')).toBe('—');
    expect(formatArea(-1, 'metric')).toBe('—');
  });
});

describe('formatAngle', () => {
  it('shows one decimal degree', () => {
    expect(formatAngle(90)).toBe('90.0°');
    expect(formatAngle(53.13)).toBe('53.1°');
  });

  it('returns a dash for a non-finite angle', () => {
    expect(formatAngle(NaN)).toBe('—');
  });
});

describe('formatGrade', () => {
  it('shows a percentage', () => {
    expect(formatGrade(12.5)).toBe('12.5%');
    expect(formatGrade(0)).toBe('0.0%');
  });

  it('reads a non-finite grade as vertical', () => {
    expect(formatGrade(Infinity)).toBe('vertical');
  });
});
