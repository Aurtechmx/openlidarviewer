/**
 * units.test.ts
 *
 * Pins the branded-unit conversions to their exact factors and confirms the
 * round-trips are lossless within float tolerance. The compile-time safety
 * (that a SourceUnits can't be passed where Metres is required) is enforced by
 * `tsc` on the whole tree, not assertable at runtime; these tests cover the
 * numeric contract.
 */

import { describe, it, expect } from 'vitest';
import {
  metres, feet, sourceUnits, degrees, sqMetres, cubicMetres, raw,
  feetToMetres, metresToFeet, sourceToMetres, usSurveyFeetToMetres,
  radToDeg, degToRad, sqMetresToSqFeet, cubicMetresToCubicFeet, UNIT_FACTORS,
  knownUnit, unknownUnit, toMetresIfKnown,
} from '../src/units/units';

describe('branded unit conversions', () => {
  it('uses the exact international-foot factor (0.3048)', () => {
    expect(raw(feetToMetres(feet(1)))).toBe(0.3048);
    expect(raw(metresToFeet(metres(0.3048)))).toBeCloseTo(1, 12);
    expect(UNIT_FACTORS.M_PER_FT).toBe(0.3048);
  });

  it('round-trips feet ↔ metres losslessly', () => {
    for (const ft of [0, 1, 3.28084, 100, 5280]) {
      const back = raw(metresToFeet(feetToMetres(feet(ft))));
      expect(back).toBeCloseTo(ft, 9);
    }
  });

  it('converts source units to metres by the CRS factor, not a guess', () => {
    // US survey foot factor as it arrives from a WKT linear-unit definition.
    const usFt = 1200 / 3937;
    expect(raw(sourceToMetres(sourceUnits(10), usFt))).toBeCloseTo(10 * usFt, 12);
    // Unknown unit → factor 1 → value passes through unchanged (caller must
    // then NOT claim metres; that policy lives in the CRS layer).
    expect(raw(sourceToMetres(sourceUnits(42), 1))).toBe(42);
  });

  it('keeps the US survey foot distinct from the international foot', () => {
    const intl = raw(feetToMetres(feet(10000)));
    const survey = raw(usSurveyFeetToMetres(10000));
    expect(survey).not.toBe(intl);
    // The two disagree by ~2 ppm — small, but real over survey distances.
    expect(Math.abs(survey - intl)).toBeGreaterThan(0);
    expect(Math.abs(survey - intl) / intl).toBeLessThan(1e-5);
  });

  it('round-trips degrees ↔ radians', () => {
    for (const d of [0, 30, 45, 90, 180, 359.9]) {
      expect(raw(radToDeg(degToRad(degrees(d))))).toBeCloseTo(d, 9);
    }
    expect(raw(degToRad(degrees(180)))).toBeCloseTo(Math.PI, 12);
  });

  it('converts to metres only when the unit is known, else null', () => {
    // Known unit (feet) → real metres.
    const known = toMetresIfKnown(sourceUnits(10), knownUnit(0.3048));
    expect(known).not.toBeNull();
    expect(raw(known!)).toBeCloseTo(3.048, 12);
    // Unknown unit → null, so it can never be presented as metres.
    expect(toMetresIfKnown(sourceUnits(10), unknownUnit())).toBeNull();
  });

  it('derives area and volume factors from the exact linear factor', () => {
    expect(sqMetresToSqFeet(sqMetres(1))).toBeCloseTo(1 / (0.3048 * 0.3048), 9);
    expect(cubicMetresToCubicFeet(cubicMetres(1))).toBeCloseTo(1 / 0.3048 ** 3, 9);
  });
});

describe('unit constructors reject non-finite values (poison at the source)', () => {
  it('throws on NaN / ±Infinity', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => metres(bad)).toThrow(/finite/);
      expect(() => feet(bad)).toThrow(/finite/);
      expect(() => sqMetres(bad)).toThrow(/finite/);
      expect(() => cubicMetres(bad)).toThrow(/finite/);
      expect(() => degrees(bad)).toThrow(/finite/);
    }
  });
  it('accepts finite values incl. zero and negatives', () => {
    expect(() => metres(0)).not.toThrow();
    expect(() => metres(-12.5)).not.toThrow();
    expect(metres(3.2) as number).toBe(3.2);
  });
});
