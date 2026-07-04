import { describe, it, expect } from 'vitest';
import {
  intensityFilterUniform,
  intensityPasses,
  INTENSITY_FILTER_OFF,
} from '../src/render/intensityFilterUniform';

describe('intensityFilterUniform', () => {
  it('undefined / empty range disables the filter (identity)', () => {
    expect(intensityFilterUniform(undefined)).toEqual({ enabled: 0, min: 0, max: 0 });
    expect(INTENSITY_FILTER_OFF.enabled).toBe(0);
  });

  it('a finite window enables and keeps raw units (no shift)', () => {
    expect(intensityFilterUniform([100, 4000])).toEqual({ enabled: 1, min: 100, max: 4000 });
  });

  it('is order-independent', () => {
    expect(intensityFilterUniform([4000, 100])).toEqual({ enabled: 1, min: 100, max: 4000 });
  });

  it('a single finite bound collapses to a point range', () => {
    expect(intensityFilterUniform([500, Number.NaN])).toEqual({ enabled: 1, min: 500, max: 500 });
  });

  it('CPU parity: inclusive at both ends, disabled passes everything', () => {
    const u = intensityFilterUniform([100, 4000]);
    expect(intensityPasses(u, 100)).toBe(true); // inclusive lower
    expect(intensityPasses(u, 4000)).toBe(true); // inclusive upper
    expect(intensityPasses(u, 99)).toBe(false);
    expect(intensityPasses(u, 4001)).toBe(false);
    expect(intensityPasses(u, Number.NaN)).toBe(false); // non-finite fails when enabled
    expect(intensityPasses(INTENSITY_FILTER_OFF, 99999)).toBe(true); // disabled passes all
  });
});
