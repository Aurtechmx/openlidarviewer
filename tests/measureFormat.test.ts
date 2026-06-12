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

/**
 * B2 (v0.4.5) — render-space formatting through the CRS unit factor.
 * Truth fixture: a US-survey-foot CRS (EPSG:2225-style), where
 * 1 render unit = 1200/3937 m exactly. Every expectation below is
 * hand-computed:
 *
 *   10 sft  = 10 × 0.30480060960121924 m = 3.0480060960121924 m
 *           = 10.00002 international ft  (sft/ft = 1.000002)
 */
import {
  formatLengthRender,
  formatAreaRender,
  formatVolumeRender,
} from '../src/render/measure/format';

const US_SURVEY_FOOT = 1200 / 3937; // 0.30480060960121924 m

describe('formatLengthRender (B2 foot-CRS fixture)', () => {
  it('labels a 10 sft span correctly in both unit systems', () => {
    // 3.0480060960121924 m → "3.05 m"; NOT the pre-B2 "10.00 m".
    expect(formatLengthRender(10, US_SURVEY_FOOT, 'metric')).toBe('3.05 m');
    // 10.00002 ft → "10.00 ft" — the span reads back as the feet it is.
    expect(formatLengthRender(10, US_SURVEY_FOOT, 'imperial')).toBe('10.00 ft');
  });

  it('factor 1 is a byte-identical passthrough (metric/local scans)', () => {
    expect(formatLengthRender(5, 1, 'metric')).toBe(formatLength(5, 'metric'));
    expect(formatLengthRender(5, 1, 'imperial')).toBe(formatLength(5, 'imperial'));
  });

  it('invalid factors fall back to 1, never multiply by garbage', () => {
    expect(formatLengthRender(10, Number.NaN, 'metric')).toBe('10.00 m');
    expect(formatLengthRender(10, 0, 'metric')).toBe('10.00 m');
    expect(formatLengthRender(10, -2, 'metric')).toBe('10.00 m');
  });
});

describe('formatAreaRender (B2: areas scale by the factor squared)', () => {
  it('1000 sft² = 92.90 m² = 1,000.0 ft²', () => {
    // 1000 × (1200/3937)² = 92.90341161327482 m².
    expect(formatAreaRender(1000, US_SURVEY_FOOT, 'metric')).toBe('92.90 m²');
    // 92.903411… m² × 10.76391042 ft²/m² = 1000.004000004 ft².
    expect(formatAreaRender(1000, US_SURVEY_FOOT, 'imperial')).toBe('1,000.0 ft²');
  });
});

describe('formatVolumeRender (B2: volumes scale by the factor cubed)', () => {
  // International foot here so the imperial round-trip is exact.
  const INTL_FOOT = 0.3048;
  it('1000 ft³ = 28.32 m³ = 37.04 yd³', () => {
    // 1000 × 0.3048³ = 28.316846592 m³.
    expect(formatVolumeRender(1000, INTL_FOOT, 'metric')).toBe('28.32 m³');
    // Back through 35.31466672 ft³/m³ = 1000 ft³ = 37.037 yd³.
    expect(formatVolumeRender(1000, INTL_FOOT, 'imperial')).toBe('37.04 yd³');
  });
});
