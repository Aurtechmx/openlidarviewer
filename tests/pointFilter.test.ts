/**
 * pointFilter.test.ts
 *
 * Pins the P10 shader-filter foundation: capability reporting disables missing
 * attributes with a reason; range normalisation is order-independent and finite;
 * the inclusive range test matches the shader contract (inactive → pass, no
 * value → fail); "active" detection powers the near-zero-cost bypass; and the
 * at-most-one-range-filter constraint drops intensity in favour of elevation.
 */

import { describe, it, expect } from 'vitest';
import {
  pointFilterCapabilities,
  normalizeRange,
  isRangeActive,
  passesRange,
  activeRangeFilterCount,
  isPointFilterActive,
  limitToSingleRangeFilter,
  type PointFilterState,
} from '../src/render/pointFilter';

describe('pointFilterCapabilities', () => {
  it('marks present attributes available and missing ones disabled with a reason', () => {
    const caps = pointFilterCapabilities({
      hasClassification: true,
      hasPosition: true,
      hasIntensity: false,
    });
    expect(caps.classification.available).toBe(true);
    expect(caps.elevation.available).toBe(true);
    expect(caps.intensity.available).toBe(false);
    expect(caps.intensity.reason).toMatch(/intensity/i);
  });
  it('disables classification and elevation when absent', () => {
    const caps = pointFilterCapabilities({
      hasClassification: false,
      hasPosition: false,
      hasIntensity: true,
    });
    expect(caps.classification.available).toBe(false);
    expect(caps.classification.reason).toMatch(/classification/i);
    expect(caps.elevation.available).toBe(false);
  });
});

describe('normalizeRange', () => {
  it('orders the bounds', () => {
    expect(normalizeRange([10, 2])).toEqual([2, 10]);
    expect(normalizeRange([2, 10])).toEqual([2, 10]);
  });
  it('collapses a single finite bound to a point range', () => {
    expect(normalizeRange([5, Number.NaN])).toEqual([5, 5]);
    expect(normalizeRange([Number.POSITIVE_INFINITY, 7])).toEqual([7, 7]);
  });
  it('returns null when unusable or absent', () => {
    expect(normalizeRange([Number.NaN, Number.NaN])).toBeNull();
    expect(normalizeRange(undefined)).toBeNull();
  });
});

describe('passesRange (the shader contract)', () => {
  it('passes everything when the range is inactive', () => {
    expect(passesRange(999, undefined)).toBe(true);
    expect(passesRange(999, [Number.NaN, Number.NaN])).toBe(true);
  });
  it('is inclusive at both ends', () => {
    expect(passesRange(2, [2, 10])).toBe(true);
    expect(passesRange(10, [2, 10])).toBe(true);
    expect(passesRange(1.9, [2, 10])).toBe(false);
    expect(passesRange(10.1, [2, 10])).toBe(false);
  });
  it('is order-independent', () => {
    expect(passesRange(5, [10, 2])).toBe(true);
  });
  it('fails a point with no finite value against an active range', () => {
    expect(passesRange(Number.NaN, [2, 10])).toBe(false);
  });
});

describe('active-state helpers', () => {
  it('isRangeActive tracks usable windows', () => {
    expect(isRangeActive([0, 1])).toBe(true);
    expect(isRangeActive(undefined)).toBe(false);
  });
  it('isPointFilterActive is false for an empty state (near-zero-cost bypass)', () => {
    expect(isPointFilterActive({})).toBe(false);
    expect(isPointFilterActive({ classificationMask: new Uint32Array(0) })).toBe(false);
  });
  it('isPointFilterActive is true when a class mask or any range is set', () => {
    expect(isPointFilterActive({ classificationMask: new Uint32Array([1]) })).toBe(true);
    expect(isPointFilterActive({ elevationRange: [0, 100] })).toBe(true);
  });
});

describe('at-most-one range filter (P10 constraint)', () => {
  it('counts active range filters', () => {
    expect(activeRangeFilterCount({})).toBe(0);
    expect(activeRangeFilterCount({ elevationRange: [0, 1] })).toBe(1);
    expect(activeRangeFilterCount({ elevationRange: [0, 1], intensityRange: [0, 255] })).toBe(2);
  });
  it('drops intensity when both ranges are set — elevation precedence', () => {
    const both: PointFilterState = { elevationRange: [0, 1], intensityRange: [0, 255] };
    const limited = limitToSingleRangeFilter(both);
    expect(limited.elevationRange).toEqual([0, 1]);
    expect(limited.intensityRange).toBeUndefined();
    expect(activeRangeFilterCount(limited)).toBe(1);
  });
  it('leaves a single-range or classification-only state unchanged', () => {
    const one: PointFilterState = { intensityRange: [0, 255] };
    expect(limitToSingleRangeFilter(one)).toBe(one);
  });
});
