/**
 * contourIntervalUnits.test.ts — the contour interval gate must be unit-consistent.
 *
 * The gate's candidate intervals and elevation range/bounds are in the surface's
 * SOURCE vertical units (contours draw against `dtm.z` raw), but the hold-out
 * RMSE is in METRES. Feeding metre-RMSE into a source-unit comparison made the
 * "finer than 2×error" rule wrong for foot-based data. The fix expresses RMSE in
 * the interval's own units, so gating is entirely source-unit — which means the
 * recommended interval MUST be invariant to `verticalUnitToMetres` for identical
 * source geometry. This test pins that invariance (it fails on the metre-vs-source
 * mixing bug).
 */
import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { gaussianHill } from './fixtures/terrainScenes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** Add deterministic vertical jitter so the hold-out RMSE is clearly nonzero
 * (the error rule only bites when there is measurable surface error). */
function withNoise(points: ReadonlyArray<TerrainPoint>, sigma: number, seed: number): TerrainPoint[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  // Box–Muller for roughly-normal jitter.
  return points.map((p) => {
    const u = Math.max(1e-9, rnd());
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
    return { x: p.x, y: p.y, z: p.z + z * sigma };
  });
}

describe('contour interval gate — unit consistency', () => {
  it('recommended interval is invariant to verticalUnitToMetres (gating is source-unit)', () => {
    const pts = withNoise(gaussianHill({ amplitude: 6 }), 0.4, 12345);
    const base = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' } as const;

    // Same SOURCE geometry; only the declared vertical scale differs.
    const asMetre = analyseContours(pts, { ...base, verticalUnitToMetres: 1 });
    const asFoot = analyseContours(pts, { ...base, verticalUnitToMetres: 0.3048 });

    // The metre-scaled hold-out RMSE differs between the two (feet read smaller in
    // metres), which is exactly what used to corrupt the gate — but the interval
    // recommendation AND the per-interval supported flags must not move, because
    // gating happens in the interval's own units.
    expect(asFoot.gate.recommendedM).toBe(asMetre.gate.recommendedM);
    const supported = (r: typeof asMetre): Array<[number, boolean]> =>
      r.gate.options.map((o) => [o.intervalM, o.supported]);
    expect(supported(asFoot)).toEqual(supported(asMetre));
    // Sanity: the noise makes the error rule actually bite (not a trivial pass).
    expect(asMetre.gate.options.some((o) => !o.supported)).toBe(true);
  });
});
