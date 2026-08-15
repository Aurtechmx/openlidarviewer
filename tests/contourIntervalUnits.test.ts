/**
 * contourIntervalUnits.test.ts — the contour interval gate must consume RMSE in
 * the interval's own (source) units.
 *
 * The gate's candidate intervals are source-unit numbers (a foot-CRS surveyor
 * wants 1 ft / 2 ft contours, not 0.5 m), but the hold-out RMSE arrives in
 * METRES. Feeding it raw made the "finer than 2×error" rule compare feet against
 * metres on foot data, offering contours finer than the surface can support. The
 * fix expresses RMSE in the interval's own units (`rmse / verticalUnitToMetres`).
 *
 * The old form of this test pinned "same SOURCE numbers ⇒ same recommendation",
 * which held only while the DTM was unit-blind. The SMRF ground tolerance is now
 * a physical constant (0.5 m), so identical source numbers under different
 * vertical units describe DIFFERENT physical terrain and no longer classify the
 * same — see groundFilterUnitFrame. This test instead holds the PHYSICAL terrain
 * fixed and checks that the RMSE gate implies a CONSISTENT physical error cutoff
 * across unit frames: the finest supported PHYSICAL interval must agree to within
 * the candidate grid's own granularity. Feeding metre-RMSE unconverted collapses
 * the foot frame's cutoff by ~3.28× and breaks that agreement.
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

const FOOT = 0.3048;

/** Finest supported interval, expressed in PHYSICAL metres (source × vum). */
function finestSupportedPhysicalM(
  result: ReturnType<typeof analyseContours>,
  vum: number,
): number {
  const supported = result.gate.options.filter((o) => o.supported).map((o) => o.intervalM);
  expect(supported.length).toBeGreaterThan(0);
  return Math.min(...supported) * vum;
}

describe('contour interval gate — RMSE unit consistency', () => {
  it('implies a consistent physical error cutoff in metre and foot frames', () => {
    // One physical surface (a 6 m hill with 0.4 m jitter), expressed once in
    // metres and once in international feet — all coordinates and the cell size
    // scaled by 1/0.3048 so the PHYSICAL terrain is identical.
    const physical = withNoise(gaussianHill({ amplitude: 6 }), 0.4, 12345);
    const asMetre = analyseContours(physical, {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
    });
    const footPts = physical.map((p) => ({ x: p.x / FOOT, y: p.y / FOOT, z: p.z / FOOT }));
    const asFoot = analyseContours(footPts, {
      cellSizeM: 2 / FOOT,
      crs: 'EPSG:2229',
      verticalDatum: 'EPSG:6360',
      horizontalUnitToMetres: FOOT,
      verticalUnitToMetres: FOOT,
    });

    const metreCutoffM = finestSupportedPhysicalM(asMetre, 1);
    const footCutoffM = finestSupportedPhysicalM(asFoot, FOOT);

    // The candidate grid is [0.5,1,2,5,10] in each frame's own units, so the two
    // frames sample the physical cutoff at DIFFERENT rungs — they can only agree
    // to within one candidate step (≤ 2.5×). Feeding metre-RMSE unconverted
    // shrinks the foot cutoff ~3.28× and pushes this ratio well past that.
    const ratio = footCutoffM / metreCutoffM;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);

    // Sanity: the noise makes the error rule actually bite in both frames (some
    // fine intervals are rejected, not a trivial all-supported pass).
    expect(asMetre.gate.options.some((o) => !o.supported)).toBe(true);
    expect(asFoot.gate.options.some((o) => !o.supported)).toBe(true);
  });
});
