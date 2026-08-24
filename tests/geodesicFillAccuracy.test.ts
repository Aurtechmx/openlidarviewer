/**
 * geodesicFillAccuracy.test.ts
 *
 * Does the geodesic void fill produce better heights than the Euclidean prefill
 * it refines, in THIS implementation?
 *
 * The question was worth asking because nothing here answered it. The method is
 * cited to Duan, Ge & He (2025), who report a 13 to 17 per cent RMSE reduction
 * on their data with their code, and `geodesicFill.test.ts` shows the two
 * methods differ in the expected direction on a 3x3 fixture without knowing
 * which of them is right. A user-facing warning said heights were less reliable
 * after a fallback to Euclidean, which is an accuracy claim resting on someone
 * else's measurement of someone else's implementation.
 *
 * These surfaces are analytic, so the truth is known at every cell and RMSE is
 * against the real surface rather than against held-out samples. That is the
 * measurement's strength and its limit: closed-form landforms are not scans,
 * and nothing here is evidence about field accuracy. It is enough to say which
 * of two interpolants is closer to a known answer, and that is all it says.
 *
 * The result is conditional, and the condition is the point. A void whose
 * neighbourhood reaches across an elevation CONTRAST is where the method wins,
 * and it wins by a wide margin. Where there is no contrast to cross it loses a
 * few per cent, because adding the rise to the path cost makes uphill
 * neighbours expensive and biases the estimate downhill. A symmetric ridge is
 * the case that looks like a barrier and is not one: crossing the crest costs
 * nothing when the far side sits at the same height as the near side.
 */

import { describe, it, expect } from 'vitest';
import { geodesicFill } from '../src/terrain/ground/geodesicFill';
import { idwFill } from '../src/terrain/ground/idwFill';

const COLS = 120, ROWS = 120;
const MID = COLS / 2;

/** A scarp: a low bench west, a plateau 50 m higher east, over `ramp` cells. */
const scarp = (ramp: number) => (c: number, r: number): number => {
  const t = Math.max(0, Math.min(1, (c - (MID - ramp / 2)) / ramp));
  return 10 + 50 * t + 0.02 * r;
};
/** A symmetric ridge: it looks like a barrier, and crossing it is free. */
const ridge = (c: number, r: number): number => 60 - 1.8 * Math.abs(c - MID) + 0.03 * r;
/** No barrier at all. */
const plane = (c: number, r: number): number => 10 + 0.25 * c + 0.11 * r;

interface Grid { truth: Float64Array; z: Float32Array; had: Uint8Array }

/** Circular voids of `radius` centred at each of `centres`. */
function build(
  surface: (c: number, r: number) => number,
  centres: readonly (readonly [number, number])[],
  radius: number,
): Grid {
  const n = COLS * ROWS;
  const truth = new Float64Array(n);
  const z = new Float32Array(n);
  const had = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const r = (i / COLS) | 0, c = i - r * COLS;
    truth[i] = surface(c, r);
    z[i] = truth[i];
  }
  for (const [cx, cy] of centres) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if ((c - cx) ** 2 + (r - cy) ** 2 <= radius * radius) {
          const i = r * COLS + c;
          had[i] = 0; z[i] = Number.NaN;
        }
      }
    }
  }
  return { truth, z, had };
}

/** RMSE over the void cells only, against the analytic surface. */
function voidRmse(filled: Float32Array, g: Grid): number {
  let s = 0, n = 0;
  for (let i = 0; i < filled.length; i++) {
    if (g.had[i] === 1 || !Number.isFinite(filled[i])) continue;
    s += (filled[i] - g.truth[i]) ** 2; n++;
  }
  return n ? Math.sqrt(s / n) : Number.NaN;
}

/** Percentage change in RMSE from Euclidean to geodesic; negative is better. */
function change(g: Grid): number {
  const e = idwFill(g.z, g.had, COLS, ROWS, { power: 2, kNearest: 12, maxRadiusCells: 24 });
  const geo = geodesicFill(g.z, g.had, COLS, ROWS, {
    cellMetresX: 1, cellMetresY: 1, verticalUnitToMetres: 1,
  });
  const re = voidRmse(e, g), rg = voidRmse(geo, g);
  return ((rg - re) / re) * 100;
}

const LOW_BENCH: readonly (readonly [number, number])[] = [
  [MID - 12, 30], [MID - 12, 60], [MID - 12, 90],
];
const FAR_AWAY: readonly (readonly [number, number])[] = [[18, 30], [20, 62], [19, 92]];

describe('geodesic fill against a known surface', () => {
  it('is closer to truth for a void beside a hard scarp', () => {
    // A void on the low bench, near enough that a Euclidean neighbourhood
    // reaches over a 50 m step. This is the failure the method exists for.
    // Measured: RMSE 6.13 m Euclidean against 4.58 m geodesic, 25% closer.
    const pct = change(build(scarp(1), [[MID - 10, 30], [MID - 10, 60], [MID - 10, 90]], 9));
    expect(pct).toBeLessThan(-15);
  });

  it('is closer to truth for a void beside a softened break in slope', () => {
    // A real break in slope is not a cliff. Over an eight-cell ramp the gain is
    // smaller: 3.75 m against 3.02 m, 20% closer, which is the range the cited
    // paper reports on its own data. The cliff above is the ceiling of the
    // effect, not its typical size.
    const pct = change(build(scarp(8), LOW_BENCH, 9));
    expect(pct).toBeLessThan(-10);
    expect(pct).toBeGreaterThan(-40);
  });

  it('changes nothing for a void far from any contrast', () => {
    const pct = change(build(scarp(8), FAR_AWAY, 9));
    expect(Math.abs(pct)).toBeLessThan(2);
  });

  it('changes nothing on a plane, where there is nothing to walk around', () => {
    const pct = change(build(plane, [[MID, 30], [30, 60], [90, 90]], 9));
    expect(Math.abs(pct)).toBeLessThan(2);
  });

  it('is slightly WORSE on the flank of a symmetric ridge', () => {
    // The finding that makes the gain conditional rather than general. A
    // symmetric crest looks like a barrier and is not one: the far side sits at
    // the same height as the near side, so crossing it costs nothing, and the
    // rise in the path cost only biases the estimate downhill. Recorded because
    // a claim that the method is uniformly better would be false, and because a
    // future change that erased this would be changing the method's behaviour
    // on ordinary terrain without anyone noticing.
    // Measured: 2.89 m Euclidean against 3.18 m geodesic, 10% worse.
    const pct = change(build(ridge, [[MID - 7, 30], [MID - 7, 60], [MID - 7, 90]], 6));
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(20);
  });

  it('costs less the larger the void, as the neighbourhood stops reaching over', () => {
    const near = change(build(ridge, [[MID - 7, 30], [MID - 7, 60], [MID - 7, 90]], 6));
    const far = change(build(ridge, [[MID - 16, 30], [MID - 16, 62], [MID - 16, 94]], 14));
    expect(far).toBeLessThan(near);
  });
});
