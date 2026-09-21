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

// A review read `resolveLocalFrame` as mixing frames: it shifts the BOX by the
// project offset and hands `frameOf` an unshifted `sourceOrigin`, which looks
// like the offset being counted on top of an origin that already carries it.
//
// It is not, and the reason is worth pinning rather than remembering.
// `precisionOfFrame` lifts the local box back by that same origin and then
// passes the origin as a `shared-origin` strategy, so `reach` is
// `max(|extent − origin|)` = `max(|local|)`. The absolute origin cancels; only
// the local box and the offset survive. If that ever stops being true these go
// red, and the permit starts depending on where in the world a scan sits.
describe('the permit does not depend on where the scan sits in the world', () => {
  const crs = { linearUnitToMetres: 1, linearUnitKnown: true } as never;
  const at = (sourceOrigin: readonly [number, number, number]) => ({
    bounds: () => ({ min: [0, 0, 0] as const, max: [500, 500, 50] as const }),
    sourceOrigin,
  });

  it('reports the same step for the same shape at any source origin', () => {
    const near = scanPrecision({ cloud: at([0, 0, 0]) as never, crs })!;
    // A real UTM easting/northing, the case the concern was about.
    const far = scanPrecision({ cloud: at([500_000, 4_000_000, 0]) as never, crs })!;
    expect(far.reach).toBe(near.reach);
    expect(far.worstCaseSpacing).toBe(near.worstCaseSpacing);
  });

  it('adds the project offset once, not once per origin', () => {
    const offset = [0, 8000, 0] as const;
    const a = scanPrecision({ cloud: at([0, 0, 0]) as never, crs, projectOffset: offset })!;
    const b = scanPrecision({ cloud: at([500_000, 4_000_000, 0]) as never, crs, projectOffset: offset })!;
    expect(b.reach).toBe(a.reach);
    // And the offset is what the accumulator actually holds: 8,000 + 500.
    expect(a.reach).toBeCloseTo(8500, 6);
  });
});
