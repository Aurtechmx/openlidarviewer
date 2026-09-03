import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FT_PER_M, UNIT_FACTORS } from '../src/units/units';
import { displayDecimals } from '../src/render/measure/format';

/**
 * The Measure panel and the report section each used to declare their own
 * `3.28084`, a 6-digit rounding of the exact factor, while `spaceMetrics` and
 * the space-report PDF converted through the exact `0.3048`. The same length
 * therefore converted two different ways depending on which surface a reader
 * was looking at. These tests pin the single source and the call sites that
 * must use it, because a test on the shared constant alone would still pass
 * with a rounded literal left behind in a panel.
 */
describe('metre→foot factor is single-sourced and exact', () => {
  it('is the exact reciprocal of the international foot', () => {
    expect(FT_PER_M).toBe(1 / 0.3048);
    expect(UNIT_FACTORS.M_PER_FT).toBe(0.3048);
    // Not exactly 1: the reciprocal is not representable, so the round trip
    // carries one ulp. Asserted at full double precision rather than hidden.
    expect(FT_PER_M * UNIT_FACTORS.M_PER_FT).toBeCloseTo(1, 15);
    // The rounded literal that used to be used is NOT this value.
    expect(FT_PER_M).not.toBe(3.28084);
  });

  it('no surface redeclares the factor, in any spelling', () => {
    // Spellings matter: a pattern written for 3.28084 could not see
    // 3.280839895013123, which is how three offenders survived the first gate.
    const offenders = SURFACES.filter((f) => /=\s*3\.2808\d*/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('each imperial display surface imports the shared factor', () => {
    for (const f of SURFACES) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/import \{[^}]*FT_PER_M[^}]*\} from '[^']*units\/units'/);
    }
  });

  it('leaves a fixed-decimal foot value identical at real magnitudes', () => {
    // The two factors differ by ~3.2e-8 relative, so at a FIXED decimal count
    // they agree until ~1.6e5 ft (~48 km), beyond any scan extent.
    const ROUNDED = 3.28084;
    for (const m of [0.001, 0.01, 0.5, 1, 12.7, 100, 999.99, 1500, 10_000, 30_000]) {
      expect((m * FT_PER_M).toFixed(2), `${m} m`).toBe((m * ROUNDED).toFixed(2));
    }
  });

  it('does NOT leave adaptive-precision output identical across a decade', () => {
    // The honest limit of the claim above. Under adaptive precision the two
    // factors land on opposite sides of a decade for an exact 10 ft span: the
    // exact factor gives 9.999999999999998 and the rounded one 10.00000032.
    // Banding on the raw float awarded the exact value a sixth significant
    // digit, which is why `displayDecimals` bands on the printed value —
    // otherwise this fix would have changed a reported string.
    const exact = 3.048 * FT_PER_M;
    const rounded = 3.048 * 3.28084;
    expect(Math.floor(Math.log10(exact))).not.toBe(Math.floor(Math.log10(rounded)));
    expect(displayDecimals(exact, 2, 4)).toBe(displayDecimals(rounded, 2, 4));
    expect(exact.toFixed(displayDecimals(exact, 2, 4))).toBe('10.000');
  });
});

/**
 * Every surface that converts metres to feet. Six of these each declared the
 * factor themselves: two as a rounded 3.28084, three as a 16-digit
 * FEET_PER_METRE, one as its own 1/0.3048.
 */
const SURFACES = [
  'src/ui/MeasurePanel.ts',
  'src/report/ReportMeasurementSection.ts',
  'src/terrain/spaceMetrics.ts',
  'src/render/measure/format.ts',
  'src/render/measure/profilePdf.ts',
  'src/render/measure/profileSummary.ts',
];
