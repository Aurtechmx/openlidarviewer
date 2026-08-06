/**
 * inMemoryPrecisionExtents.test.ts — the measured table the precision policy's
 * thresholds are set against.
 *
 * The grade boundaries in `geo/inMemoryPrecision.ts` are 1 mm and 10 mm, chosen
 * from what those steps mean for a measurement. This file records what they
 * mean for an EXTENT: which project frames stay under each one, measured rather
 * than reasoned about. Every figure below is asserted, so the table in
 * `docs/wide-area-precision.md` cannot drift from the code that produced it.
 *
 * Two frames are covered, because the runtime has two:
 *   • a single cloud on its own floored minimum — the reach is its extent;
 *   • a layer in a shared project frame — the reach is its distance from the
 *     anchor, so a small tile far from the anchor pays for the separation.
 *
 * Pure arithmetic; no fixtures, no I/O. Runs in the `unit` bucket.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateInMemoryPrecision,
  float32Spacing,
  PRECISION_GRADE_THRESHOLDS_M,
  type PrecisionGrade,
} from '../../src/geo/inMemoryPrecision';

const METRE_UNIT = { linearUnitKnown: true, linearUnitToMetres: 1 } as const;

/** A cloud spanning `extent` metres on each horizontal axis, on its own origin. */
function ownFrame(extent: number) {
  return estimateInMemoryPrecision({
    extent: { min: [0, 0, 0], max: [extent, extent, extent / 20] },
    strategy: { kind: 'per-cloud-floor-min' },
    unit: METRE_UNIT,
  });
}

/** A 1 km tile sitting `separation` metres from a shared project anchor. */
function sharedFrame(separation: number) {
  return estimateInMemoryPrecision({
    extent: {
      min: [separation, 0, 0],
      max: [separation + 1_000, 1_000, 50],
    },
    strategy: { kind: 'shared-origin', origin: [0, 0, 0] },
    unit: METRE_UNIT,
  });
}

const mm = (metres: number): number => metres * 1000;

describe('measured: single-cloud extents on their own floored origin', () => {
  /** extent (m) → [worst-case mm, typical mm, grade] */
  const TABLE: readonly [number, number, number, PrecisionGrade][] = [
    [100, 0.0076, 0.0044, 'fine'],
    [500, 0.0305, 0.0201, 'fine'],
    [1_000, 0.061, 0.0402, 'fine'],
    [2_000, 0.1221, 0.0804, 'fine'],
    [4_000, 0.2441, 0.1608, 'fine'],
    [8_000, 0.4883, 0.3216, 'fine'],
    [10_000, 0.9766, 0.4432, 'fine'],
    [16_000, 0.9766, 0.6432, 'fine'],
    [20_000, 1.9531, 0.8865, 'coarse'],
    [50_000, 3.9063, 2.1996, 'coarse'],
    [100_000, 7.8125, 4.3992, 'coarse'],
    [200_000, 15.625, 8.7983, 'unusable'],
    [400_000, 31.25, 17.5967, 'unusable'],
    [800_000, 62.5, 35.1933, 'unusable'],
  ];

  for (const [extent, worstMm, typicalMm, grade] of TABLE) {
    it(`${extent} m extent → ${worstMm} mm worst case, ${typicalMm} mm typical (${grade})`, () => {
      const p = ownFrame(extent);
      expect(mm(p.metres!.worstCaseSpacing)).toBeCloseTo(worstMm, 4);
      expect(mm(p.metres!.typicalSpacing)).toBeCloseTo(typicalMm, 4);
      expect(p.grade).toBe(grade);
    });
  }
});

describe('measured: a 1 km tile placed in a shared project frame', () => {
  /** separation from the anchor (m) → [worst-case mm, grade] */
  const TABLE: readonly [number, number, PrecisionGrade][] = [
    [0, 0.061, 'fine'],
    [1_000, 0.1221, 'fine'],
    [10_000, 0.9766, 'fine'],
    [100_000, 7.8125, 'coarse'],
    [500_000, 31.25, 'unusable'],
  ];

  for (const [separation, worstMm, grade] of TABLE) {
    it(`${separation} m from the anchor → ${worstMm} mm worst case (${grade})`, () => {
      const p = sharedFrame(separation);
      expect(mm(p.metres!.worstCaseSpacing)).toBeCloseTo(worstMm, 4);
      expect(p.grade).toBe(grade);
    });
  }

  it('a tile pays for its distance from the anchor, not for its own size', () => {
    // The same 1 km tile, 100 km out, is two binades coarser than at the anchor.
    expect(sharedFrame(100_000).metres!.worstCaseSpacing).toBeGreaterThan(
      sharedFrame(0).metres!.worstCaseSpacing * 100,
    );
  });
});

describe('where the documented thresholds actually engage', () => {
  // The step is constant inside a binade and doubles at each power of two, so
  // every boundary below is an exact power of two rather than a fitted number.

  it('a metre-unit scan stays fine while its reach is under 16,384 m', () => {
    expect(float32Spacing(2 ** 14 - 1)).toBeLessThanOrEqual(PRECISION_GRADE_THRESHOLDS_M.fine);
    expect(float32Spacing(2 ** 14)).toBeGreaterThan(PRECISION_GRADE_THRESHOLDS_M.fine);
    expect(ownFrame(2 ** 14 - 1).grade).toBe('fine');
    expect(ownFrame(2 ** 14).grade).toBe('coarse');
  });

  it('the refusal engages once the reach reaches 131,072 m', () => {
    expect(float32Spacing(2 ** 17 - 1)).toBeLessThanOrEqual(PRECISION_GRADE_THRESHOLDS_M.coarse);
    expect(float32Spacing(2 ** 17)).toBeGreaterThan(PRECISION_GRADE_THRESHOLDS_M.coarse);
    expect(ownFrame(2 ** 17 - 1).grade).toBe('coarse');
    expect(ownFrame(2 ** 17).grade).toBe('unusable');
  });

  it('a foot-unit scan reaches the same METRE steps at a larger extent', () => {
    // A foot is 0.3048 m, so a foot-unit reach buys about 3.28x the extent
    // before the same metre step arrives. That is between one and two binades,
    // and which one depends on where the threshold sits inside a binade: the
    // 1 mm ceiling lands one binade out, the 10 mm ceiling two.
    const feet = (extent: number) =>
      estimateInMemoryPrecision({
        extent: { min: [0, 0, 0], max: [extent, extent, extent / 20] },
        strategy: { kind: 'per-cloud-floor-min' },
        unit: { linearUnitKnown: true, linearUnitToMetres: 0.3048 },
      });
    expect(feet(2 ** 15 - 1).grade).toBe('fine');
    expect(feet(2 ** 15).grade).toBe('coarse');
    expect(feet(2 ** 19 - 1).grade).toBe('coarse');
    expect(feet(2 ** 19).grade).toBe('unusable');
  });
});
