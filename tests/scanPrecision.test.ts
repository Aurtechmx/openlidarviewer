/**
 * scanPrecision.test.ts — the permit describes the frame the measurement
 * pipeline actually reads.
 */

import { describe, it, expect } from 'vitest';

import { scanPrecision } from '../src/app/scanPrecision';


// The permit measured the layer's OWN box, while the buffers the measurement
// pipeline consumes are project-local: `placeBufferInto` folds the offset into
// a Float32Array before any volume, profile or terrain gather reads it. A tile
// mounted far from the project origin therefore quantises on a coarser grid
// than its own extent implies, and the permit said otherwise.
describe('the permit measures the frame the accumulator sees', () => {
  const tile = {
    bounds: () => ({ min: [0, 0, 0] as const, max: [500, 500, 50] as const }),
    sourceOrigin: [0, 0, 0] as const,
  };
  const crs = { linearUnitToMetres: 1, linearUnitKnown: true } as never;

  it('reports a coarser step for a layer placed far from the origin', () => {
    const own = scanPrecision({ cloud: tile as never, crs });
    const placed = scanPrecision({
      cloud: tile as never, crs, projectOffset: [0, 8000, 0],
    });
    expect(own).not.toBeNull();
    expect(placed).not.toBeNull();
    // 500 m of reach vs 8,500 m: two more binary decades, so a step four
    // times coarser at least.
    expect(placed!.worstCaseSpacing).toBeGreaterThan(own!.worstCaseSpacing * 3);
    expect(placed!.reach).toBeGreaterThan(own!.reach * 10);
  });

  it('is unchanged when the layer is not placed', () => {
    const own = scanPrecision({ cloud: tile as never, crs });
    for (const off of [null, undefined, [0, 0, 0] as const]) {
      const same = scanPrecision({ cloud: tile as never, crs, projectOffset: off as never });
      expect(same!.worstCaseSpacing, String(off)).toBe(own!.worstCaseSpacing);
    }
  });
});
