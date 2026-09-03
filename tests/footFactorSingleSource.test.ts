import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { FT_PER_M, UNIT_FACTORS } from '../src/units/units';

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

  it('no source file redeclares the rounded literal', () => {
    const offenders = SURFACES.filter((f) => readFileSync(f, 'utf8').includes('3.28084'));
    expect(offenders).toEqual([]);
  });

  it('each imperial display surface imports the shared factor', () => {
    for (const f of SURFACES) {
      expect(readFileSync(f, 'utf8'), f).toMatch(/import \{[^}]*FT_PER_M[^}]*\} from '[^']*units\/units'/);
    }
  });

  it('leaves every displayed value byte-identical at real magnitudes', () => {
    // Why this matters: the fix is a correctness change landing during a
    // science freeze, so it must not move a number a user reads. The two
    // factors differ by ~3.2e-8 relative, so a 2-decimal foot string only
    // diverges above ~1.6e5 ft (~48 km) — beyond any scan extent, but
    // asserted rather than assumed.
    const ROUNDED = 3.28084;
    for (const m of [0.001, 0.01, 0.5, 1, 12.7, 100, 999.99, 1500, 10_000, 30_000]) {
      expect((m * FT_PER_M).toFixed(2), `${m} m`).toBe((m * ROUNDED).toFixed(2));
    }
  });
});

const SURFACES = [
  'src/ui/MeasurePanel.ts',
  'src/report/ReportMeasurementSection.ts',
  'src/terrain/spaceMetrics.ts',
];
