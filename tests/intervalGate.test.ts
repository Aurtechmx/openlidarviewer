/**
 * intervalGate.test.ts — specs. The gate must refuse intervals
 * finer than the surface can honestly support and recommend a legible
 * default.
 */

import { describe, it, expect } from 'vitest';
import { gateIntervals } from '../src/terrain/contour/intervalGate';

const supported = (r: ReturnType<typeof gateIntervals>) =>
  r.options.filter((o) => o.supported).map((o) => o.intervalM);

describe('gateIntervals', () => {
  it('disables intervals finer than 2x the validation RMSE', () => {
    const r = gateIntervals({ cellSizeM: 1, elevationRangeM: 50, rmseM: 1.0 });
    const map = new Map(r.options.map((o) => [o.intervalM, o]));
    expect(map.get(0.5)!.supported).toBe(false);
    expect(map.get(0.5)!.reason).toMatch(/finer than/i);
    expect(map.get(1)!.supported).toBe(false);
    expect(map.get(2)!.supported).toBe(true);
    expect(map.get(5)!.supported).toBe(true);
  });

  it('recommends a legible interval (4..40 contours)', () => {
    const r = gateIntervals({ cellSizeM: 1, elevationRangeM: 50, rmseM: 1.0 });
    expect(r.recommendedM).toBe(2); // 50/2 = 25 contours
  });

  it('warns and falls back to range-only when no RMSE is given', () => {
    const r = gateIntervals({ cellSizeM: 1, elevationRangeM: 50 });
    expect(r.warnings.join(' ')).toMatch(/no validation rmse/i);
    expect(supported(r)).toContain(0.5); // nothing disabled by error
    expect(r.recommendedM).toBe(2); // smallest with <=40 contours
  });

  it('disables intervals coarser than the elevation range', () => {
    const r = gateIntervals({ cellSizeM: 1, elevationRangeM: 1.5 });
    const map = new Map(r.options.map((o) => [o.intervalM, o]));
    expect(map.get(2)!.supported).toBe(false);
    expect(map.get(2)!.reason).toMatch(/coarser than/i);
    expect(map.get(1)!.supported).toBe(true);
    // none give 4..40 contours, so fall back to coarsest supported (1).
    expect(r.recommendedM).toBe(1);
  });

  it('disables everything on a flat surface', () => {
    const r = gateIntervals({ cellSizeM: 1, elevationRangeM: 0, rmseM: 0.1 });
    expect(supported(r)).toEqual([]);
    expect(r.recommendedM).toBeNull();
  });
});
