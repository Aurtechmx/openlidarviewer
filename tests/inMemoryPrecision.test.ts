/**
 * inMemoryPrecision.test.ts — the wide-area Float32 precision policy.
 *
 * Three questions, pinned separately so a failure names which one broke:
 *   1. Is the Float32 spacing arithmetic right (against an independent
 *      derivation and against the formula `PointCloud.rebaseQuantum` uses)?
 *   2. Does the estimate follow the local-origin strategy the runtime uses?
 *   3. Does the grade and the refusal fail closed on an unknown unit?
 */

import { describe, it, expect } from 'vitest';
import {
  float32Spacing,
  meanFloat32Spacing,
  estimateInMemoryPrecision,
  gradeInMemoryPrecision,
  resolvePrecisionPermit,
  PRECISION_GRADE_THRESHOLDS_M,
  PRECISION_BUDGET_M,
  type InMemoryPrecisionInput,
} from '../src/geo/inMemoryPrecision';

const METRE_UNIT = { linearUnitKnown: true, linearUnitToMetres: 1 } as const;

function box(
  origin: readonly [number, number, number],
  span: readonly [number, number, number],
): { min: [number, number, number]; max: [number, number, number] } {
  return {
    min: [origin[0], origin[1], origin[2]],
    max: [origin[0] + span[0], origin[1] + span[1], origin[2] + span[2]],
  };
}

describe('float32Spacing — the gap between representable Float32 values', () => {
  it('is 2^-23 at 1.0, the definition of the 24-bit significand', () => {
    expect(float32Spacing(1)).toBe(2 ** -23);
  });

  it('is the smallest subnormal at zero', () => {
    expect(float32Spacing(0)).toBe(2 ** -149);
  });

  it('is sign-independent — magnitude is what sets the step', () => {
    expect(float32Spacing(-4_100_876.789)).toBe(float32Spacing(4_100_876.789));
  });

  it('agrees with 2^(floor(log2 m) - 23), the formula PointCloud.rebaseQuantum uses', () => {
    for (const m of [1, 3, 100, 1_000, 8_192, 10_000, 65_536, 100_000, 4_100_876.789, 1e7]) {
      expect(float32Spacing(m)).toBe(2 ** (Math.floor(Math.log2(m)) - 23));
    }
  });

  it('is the real distance to the next Float32 — nothing representable sits inside it', () => {
    for (const m of [1, 137.25, 10_000, 500_000, 4_100_876.789]) {
      const stored = Math.fround(m);
      const step = float32Spacing(m);
      // Half a step up still rounds back to the same Float32; a whole step does not.
      expect(Math.fround(stored + step / 4)).toBe(stored);
      expect(Math.fround(stored + step)).not.toBe(stored);
    }
  });

  it('reports a UTM northing as the half-metre-class value the precision doc names', () => {
    // 4,100,876.789 lies in [2^21, 2^22), so the step is 2^-2 = 0.25 m and the
    // round-to-nearest error is 0.125 m. This is why coordinates are recentred.
    expect(float32Spacing(4_100_876.789)).toBe(0.25);
  });

  it('returns NaN for a non-finite magnitude rather than a plausible number', () => {
    expect(Number.isNaN(float32Spacing(NaN))).toBe(true);
    expect(Number.isNaN(float32Spacing(Infinity))).toBe(true);
  });

  it('stays finite at the top of the Float32 range', () => {
    const step = float32Spacing(3.4e38);
    expect(Number.isFinite(step)).toBe(true);
    expect(step).toBeGreaterThan(0);
  });
});

describe('meanFloat32Spacing — the typical step over a uniformly filled extent', () => {
  /** Numerically integrate the true step over [0, R] and compare the closed form. */
  function integratedMean(R: number, samples = 200_003): number {
    let total = 0;
    for (let i = 0; i < samples; i++) {
      total += float32Spacing((R * (i + 0.5)) / samples);
    }
    return total / samples;
  }

  it('matches a direct numerical integration of the step function', () => {
    for (const R of [1_000, 8_192, 12_345, 65_536, 100_000]) {
      const closed = meanFloat32Spacing(R);
      const measured = integratedMean(R);
      expect(Math.abs(closed - measured) / closed).toBeLessThan(0.005);
    }
  });

  it('is one third of the top step when the reach is exactly a power of two', () => {
    // Every coordinate below 2^b sits in a smaller binade, so the mean is
    // pulled well under the worst case: 2^(b-23)/3.
    const third = 2 ** (13 - 23) / 3;
    expect(Math.abs(meanFloat32Spacing(2 ** 13) - third) / third).toBeLessThan(1e-15);
  });

  it('approaches two thirds of the top step at the end of a binade', () => {
    const R = 2 ** 14 - 1;
    expect(meanFloat32Spacing(R) / float32Spacing(R)).toBeCloseTo(2 / 3, 3);
  });

  it('never exceeds the worst case', () => {
    for (const R of [1, 17, 1_000, 9_999, 131_071, 1e6]) {
      expect(meanFloat32Spacing(R)).toBeLessThanOrEqual(float32Spacing(R));
    }
  });
});

describe('estimateInMemoryPrecision — the per-cloud floor(min) origin', () => {
  it('sets the reach from the extent, not from the absolute coordinate', () => {
    // Two clouds of the same size, one at the UTM origin and one 4,100 km north.
    const near = estimateInMemoryPrecision({
      extent: box([0, 0, 0], [500, 500, 40]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    const far = estimateInMemoryPrecision({
      extent: box([500_000, 4_100_876.789, 61.5], [500, 500, 40]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    expect(far.worstCaseSpacing).toBe(near.worstCaseSpacing);
    expect(far.grade).toBe('fine');
  });

  it('reports the local origin it derived', () => {
    const r = estimateInMemoryPrecision({
      extent: box([500_000.75, 4_100_876.789, -3.25], [10, 10, 5]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    expect(r.localOrigin).toEqual([500_000, 4_100_876, -4]);
  });

  it('names the axis that governs the worst case', () => {
    const r = estimateInMemoryPrecision({
      extent: box([0, 0, 0], [100, 40_000, 40]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    expect(r.governingAxis).toBe('y');
    expect(r.worstCaseSpacing).toBe(float32Spacing(40_000));
  });

  it('grows the step with the extent, one binade at a time', () => {
    const at = (span: number): number =>
      estimateInMemoryPrecision({
        extent: box([0, 0, 0], [span, span, 100]),
        strategy: { kind: 'per-cloud-floor-min' },
        unit: METRE_UNIT,
      }).metres!.worstCaseSpacing;
    expect(at(1_000)).toBe(2 ** -14); // ~0.061 mm
    expect(at(10_000)).toBe(2 ** -10); // ~0.98 mm
    expect(at(100_000)).toBe(2 ** -7); // ~7.8 mm
  });

  it('halves the worst case into a round-to-nearest coordinate error', () => {
    const r = estimateInMemoryPrecision({
      extent: box([0, 0, 0], [40_000, 40_000, 100]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    expect(r.worstCaseError).toBe(r.worstCaseSpacing / 2);
    expect(r.typicalError).toBe(r.typicalSpacing / 2);
  });

  it('handles a degenerate (single-point) extent without producing NaN', () => {
    const r = estimateInMemoryPrecision({
      extent: box([12, 34, 56], [0, 0, 0]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    expect(Number.isFinite(r.worstCaseSpacing)).toBe(true);
    expect(r.grade).toBe('fine');
  });
});

describe('estimateInMemoryPrecision — a shared project origin', () => {
  it('charges the distance from the shared origin, not the cloud extent', () => {
    const r = estimateInMemoryPrecision({
      extent: box([600_000, 4_500_000, 0], [500, 500, 40]),
      strategy: { kind: 'shared-origin', origin: [500_000, 4_500_000, 0] },
      unit: METRE_UNIT,
    });
    // 100 km east of the anchor: the reach is the separation, not the 500 m tile.
    expect(r.metres!.worstCaseSpacing).toBe(2 ** -7);
    expect(r.grade).toBe('coarse');
  });

  it('reduces to the per-cloud case when the shared origin is the cloud floor', () => {
    const extent = box([600_000.25, 4_500_000.5, 12.75], [500, 500, 40]);
    const shared = estimateInMemoryPrecision({
      extent,
      strategy: { kind: 'shared-origin', origin: [600_000, 4_500_000, 12] },
      unit: METRE_UNIT,
    });
    const own = estimateInMemoryPrecision({
      extent,
      strategy: { kind: 'per-cloud-floor-min' },
      unit: METRE_UNIT,
    });
    expect(shared.worstCaseSpacing).toBe(own.worstCaseSpacing);
  });

  it('takes the larger side when the cloud straddles the shared origin', () => {
    const r = estimateInMemoryPrecision({
      extent: { min: [-30_000, -100, -5], max: [10_000, 100, 5] },
      strategy: { kind: 'shared-origin', origin: [0, 0, 0] },
      unit: METRE_UNIT,
    });
    expect(r.axes[0].reach).toBe(30_000);
  });
});

describe('unit handling fails closed', () => {
  const wideExtent = box([0, 0, 0], [400_000, 400_000, 500]);

  it('withholds metres when the linear unit is not established', () => {
    const r = estimateInMemoryPrecision({
      extent: wideExtent,
      strategy: { kind: 'per-cloud-floor-min' },
      unit: { linearUnitKnown: false, linearUnitToMetres: 1 },
    });
    expect(r.metres).toBeNull();
    expect(r.grade).toBe('unknown');
    expect(r.worstCaseSpacing).toBeGreaterThan(0); // the source-unit figure still stands
  });

  it('withholds metres when no unit is supplied at all', () => {
    const r = estimateInMemoryPrecision({
      extent: wideExtent,
      strategy: { kind: 'per-cloud-floor-min' },
    });
    expect(r.metres).toBeNull();
    expect(r.grade).toBe('unknown');
  });

  it('converts a foot CRS through its own factor', () => {
    const feet = estimateInMemoryPrecision({
      extent: box([0, 0, 0], [40_000, 40_000, 500]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: { linearUnitKnown: true, linearUnitToMetres: 0.3048 },
    });
    expect(feet.metres!.worstCaseSpacing).toBeCloseTo(float32Spacing(40_000) * 0.3048, 12);
  });

  it('does not borrow the horizontal factor for the vertical axis', () => {
    // Feet across, metres up: the Z step must not be scaled by 0.3048.
    const r = estimateInMemoryPrecision({
      extent: box([0, 0, 0], [100, 100, 300_000]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: { linearUnitKnown: true, linearUnitToMetres: 0.3048, verticalUnitToMetres: 1 },
    });
    expect(r.governingAxis).toBe('z');
    expect(r.metres!.worstCaseSpacing).toBe(float32Spacing(300_000));
  });

  it('governs on the metre figure, not the source number, under mixed units', () => {
    // 200,000 ft across (step 2^-8 ft = 0.00119 m) vs 90,000 m up (step 2^-7 m).
    // The larger source-unit step is horizontal; the larger METRE step is vertical.
    const r = estimateInMemoryPrecision({
      extent: box([0, 0, 0], [200_000, 100, 90_000]),
      strategy: { kind: 'per-cloud-floor-min' },
      unit: { linearUnitKnown: true, linearUnitToMetres: 0.3048, verticalUnitToMetres: 1 },
    });
    expect(r.governingAxis).toBe('z');
  });
});

describe('gradeInMemoryPrecision — the documented thresholds', () => {
  it('grades at or below a millimetre as fine', () => {
    expect(gradeInMemoryPrecision(0)).toBe('fine');
    expect(gradeInMemoryPrecision(PRECISION_GRADE_THRESHOLDS_M.fine)).toBe('fine');
  });

  it('grades between a millimetre and a centimetre as coarse', () => {
    expect(gradeInMemoryPrecision(0.002)).toBe('coarse');
    expect(gradeInMemoryPrecision(PRECISION_GRADE_THRESHOLDS_M.coarse)).toBe('coarse');
  });

  it('grades above a centimetre as unusable for precision work', () => {
    expect(gradeInMemoryPrecision(0.0101)).toBe('unusable');
    expect(gradeInMemoryPrecision(1)).toBe('unusable');
  });

  it('returns unknown for a figure that is not a real length', () => {
    expect(gradeInMemoryPrecision(null)).toBe('unknown');
    expect(gradeInMemoryPrecision(NaN)).toBe('unknown');
  });

  it('keeps the thresholds ordered', () => {
    expect(PRECISION_GRADE_THRESHOLDS_M.fine).toBeLessThan(PRECISION_GRADE_THRESHOLDS_M.coarse);
    expect(PRECISION_BUDGET_M).toBe(PRECISION_GRADE_THRESHOLDS_M.coarse);
  });
});

describe('resolvePrecisionPermit — the refusal', () => {
  const wide = (span: number): InMemoryPrecisionInput => ({
    extent: box([0, 0, 0], [span, span, 500]),
    strategy: { kind: 'per-cloud-floor-min' },
    unit: METRE_UNIT,
  });

  it('permits a fine cloud', () => {
    const permit = resolvePrecisionPermit(estimateInMemoryPrecision(wide(2_000)));
    expect(permit.ok).toBe(true);
    expect(permit.precision.grade).toBe('fine');
  });

  it('permits a coarse cloud — disclosure, not refusal', () => {
    const permit = resolvePrecisionPermit(estimateInMemoryPrecision(wide(40_000)));
    expect(permit.ok).toBe(true);
    expect(permit.precision.grade).toBe('coarse');
  });

  it('refuses an unusable cloud', () => {
    const permit = resolvePrecisionPermit(estimateInMemoryPrecision(wide(400_000)));
    expect(permit.ok).toBe(false);
  });

  it('states the measured step and the budget in the refusal', () => {
    const permit = resolvePrecisionPermit(estimateInMemoryPrecision(wide(400_000)));
    expect(permit.ok).toBe(false);
    if (permit.ok) return;
    const text = permit.reasons.join(' ');
    expect(text).toMatch(/mm/);
    expect(text).toMatch(/Float32/);
  });

  it('recommends tiling or COPC in the refusal', () => {
    const permit = resolvePrecisionPermit(estimateInMemoryPrecision(wide(400_000)));
    expect(permit.ok).toBe(false);
    if (permit.ok) return;
    const text = permit.reasons.join(' ').toLowerCase();
    expect(text).toContain('tile');
    expect(text).toContain('copc');
  });

  it('honours a caller-supplied budget', () => {
    const estimate = estimateInMemoryPrecision(wide(40_000)); // ~1.95 mm
    expect(resolvePrecisionPermit(estimate, { budgetMetres: 0.001 }).ok).toBe(false);
    expect(resolvePrecisionPermit(estimate, { budgetMetres: 0.05 }).ok).toBe(true);
  });

  it('ignores a budget that is not a usable length, keeping the default', () => {
    const estimate = estimateInMemoryPrecision(wide(400_000));
    expect(resolvePrecisionPermit(estimate, { budgetMetres: NaN }).ok).toBe(false);
    expect(resolvePrecisionPermit(estimate, { budgetMetres: -1 }).ok).toBe(false);
    expect(resolvePrecisionPermit(estimate, { budgetMetres: 0 }).ok).toBe(false);
  });

  it('does not refuse on precision when the unit is unestablished', () => {
    // No metre figure exists, so this gate has nothing to measure. The unit gate
    // (SpatialContext.metricClaimsPermitted) is the authority that blocks a
    // metric claim there; two gates answering one question is how they drift.
    const permit = resolvePrecisionPermit(
      estimateInMemoryPrecision({
        extent: box([0, 0, 0], [400_000, 400_000, 500]),
        strategy: { kind: 'per-cloud-floor-min' },
        unit: { linearUnitKnown: false, linearUnitToMetres: 1 },
      }),
    );
    expect(permit.ok).toBe(true);
    expect(permit.precision.grade).toBe('unknown');
  });

  it('makes no quality assertion the geometry has not been measured against', () => {
    const banned = /\b(accurate|precise|certified|survey-grade|professional)\b/i;
    for (const span of [500, 40_000, 400_000]) {
      const permit = resolvePrecisionPermit(estimateInMemoryPrecision(wide(span)));
      const text = permit.ok ? '' : permit.reasons.join(' ');
      expect(text).not.toMatch(banned);
    }
  });
});
