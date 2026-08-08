/**
 * terrainBoundary.test.ts — how OLV's slope/aspect behave near a dataset edge.
 *
 * A 3x3 Horn kernel needs a full neighbourhood. At a grid edge OLV clamps
 * (replicates) the missing neighbours, so a cell one row in from a REAL edge and
 * the same cell one row in from an ARTIFICIAL crop edge are computed from
 * different neighbours. This study makes that measurable: build one complete
 * surface, compute slope/aspect on it (the truth), crop it, recompute, and group
 * the error by distance from the crop boundary.
 *
 * The invariant the spec asks for (§23 interior isolation): a crop that only
 * moves a distant boundary must not change the interior. With a 3x3 kernel that
 * means every cell at least ONE cell in from the crop edge has its full real
 * neighbourhood and must match the truth exactly; only the edge ring (distance 0)
 * carries the clamp error. Aspect is compared circularly, so a 359/1 wrap never
 * reads as a huge boundary error.
 *
 * Pure and analytic: the surface is generated in-test, so this needs no fixture
 * and tests the KERNEL's edge behaviour, not a particular dataset.
 */

import { describe, it, expect } from 'vitest';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';
import { circularAspectError } from '../src/validation/terrainMetrics';

const FULL = 60;
const M = 10; // crop margin: crop is [M, FULL-M) on both axes
const CROP = FULL - 2 * M; // 40

/** A complete surface with slope AND aspect that vary across the grid, and no
 *  mirror symmetry (so a transpose or flip would change the answer). */
function surface(cols: number, rows: number): Float32Array {
  const z = new Float32Array(cols * rows);
  const a = 0.002, b = 0.0009, c = 0.0006, d = 0.03, e = -0.02;
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = col, y = r;
      z[r * cols + col] = a * x * x + b * y * y + c * x * y + d * x + e * y;
    }
  }
  return z;
}

describe('slope/aspect behaviour by distance from an artificial crop boundary', () => {
  const full = surface(FULL, FULL);
  const truth = hornSlopeAspect(full, FULL, FULL, 1);

  // Crop the surface and recompute on the sub-grid.
  const crop = new Float32Array(CROP * CROP);
  for (let r = 0; r < CROP; r++)
    for (let cc = 0; cc < CROP; cc++) crop[r * CROP + cc] = full[(r + M) * FULL + (cc + M)];
  const cropped = hornSlopeAspect(crop, CROP, CROP, 1);

  // Error per crop cell vs the truth cell it maps to, plus its boundary distance.
  interface Cell { dist: number; slopeErr: number; aspectErr: number }
  const cells: Cell[] = [];
  for (let r = 0; r < CROP; r++) {
    for (let cc = 0; cc < CROP; cc++) {
      const dist = Math.min(r, cc, CROP - 1 - r, CROP - 1 - cc);
      const ci = r * CROP + cc;
      const ti = (r + M) * FULL + (cc + M);
      cells.push({
        dist,
        slopeErr: Math.abs(cropped.slope[ci] - truth.slope[ti]),
        aspectErr: circularAspectError(cropped.aspect[ci], truth.aspect[ti]),
      });
    }
  }

  const band = (pred: (d: number) => boolean) => {
    const sel = cells.filter((c) => pred(c.dist));
    const maxSlope = Math.max(...sel.map((c) => c.slopeErr));
    const maxAspect = Math.max(...sel.map((c) => c.aspectErr));
    return { count: sel.length, maxSlope, maxAspect };
  };

  it('the interior (>= 1 cell in) matches the full-surface truth exactly', () => {
    const interior = band((d) => d >= 1);
    expect(interior.count).toBeGreaterThan(0);
    // A full real 3x3 neighbourhood → identical Horn slope and aspect.
    expect(interior.maxSlope).toBeLessThan(1e-6);
    expect(interior.maxAspect).toBeLessThan(1e-3);
  });

  it('only the edge ring (distance 0) carries the clamp error', () => {
    const edge = band((d) => d === 0);
    const interior = band((d) => d >= 1);
    // eslint-disable-next-line no-console
    console.log(`[terrain-boundary] edge maxSlope=${edge.maxSlope.toExponential(2)} maxAspect=${edge.maxAspect.toFixed(2)}deg | interior maxSlope=${interior.maxSlope.toExponential(2)}`);
    expect(edge.maxSlope).toBeGreaterThan(interior.maxSlope);
  });

  it('aspect is compared circularly — no wraparound blow-up at the boundary', () => {
    // Every aspect error is a real circular separation, so it is bounded by 180,
    // not the 358 a naive subtraction would produce.
    const edge = band((d) => d === 0);
    expect(edge.maxAspect).toBeLessThanOrEqual(180);
  });
});
