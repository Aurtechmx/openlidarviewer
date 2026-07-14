/**
 * trainOnlyReclassify.ts
 *
 * Train-only ground reclassifier for the hold-out validation — the
 * implementation of `HoldoutParams.reclassifyGround` the shipped analysis
 * path injects (see `contour/analyseContours.ts`).
 *
 * Why it exists: `holdoutValidateDtm` validates a SURFACE given a ground
 * mask; by default that mask was produced over the WHOLE cloud, so the
 * held-out points helped decide their own ground membership — a mild
 * optimism the report could only disclose. This factory removes the leak:
 * it re-runs the SAME production classifier with the SAME resolved
 * parameters on the training points only, so a withheld point never
 * influences the classification that decides the training surface
 * (classify-inside-fold).
 *
 * Cost honesty: the hold-out split is a SINGLE deterministic split, so the
 * hook runs the classifier exactly once more — over the training share of
 * the analysed cloud (which the gather already caps; see
 * `app/terrainAnalysisRunner.ts`). Total ground-filter cost for a run is
 * therefore at most 2× the main pass, never K passes.
 *
 * Determinism: `classifyGroundSmrf` is deterministic, so the returned hook
 * is pure (same points + same held-out flags ⇒ same mask), which keeps the
 * validation report reproducible.
 *
 * Pure data: no DOM, no three.js, no I/O. Worker-safe.
 */

import type { TerrainPoint } from '../TerrainContracts';
import { classifyGroundSmrf, type GroundFilterParams } from '../ground/groundFilter';

/**
 * The classifier seam — structurally satisfied by {@link classifyGroundSmrf}
 * (the production default); injectable so tests can prove what the hook
 * shows the classifier without running SMRF.
 */
export type GroundClassifierFn = (
  points: ReadonlyArray<TerrainPoint>,
  params: GroundFilterParams,
) => { readonly isGround: Uint8Array };

/**
 * Build a `reclassifyGround` hook (see `HoldoutParams.reclassifyGround` in
 * `validate/holdoutRmse.ts`) that classifies ground over the TRAINING points
 * only and scatters the verdicts back to source indices. Held-out indices
 * are always 0 in the returned mask — a withheld point can never be called
 * ground by a pass that was forbidden from seeing it (`holdoutValidateDtm`
 * additionally excludes held-out indices from the fit regardless).
 *
 * @param params   The EXACT resolved parameters of the main classification
 *                 pass — sharing the object is what makes parameter drift
 *                 between the delivered surface and the validated one
 *                 structurally impossible.
 * @param classify Injectable classifier; production default is
 *                 {@link classifyGroundSmrf}.
 */
export function makeTrainOnlyReclassifier(
  params: GroundFilterParams,
  classify: GroundClassifierFn = classifyGroundSmrf,
): (points: ReadonlyArray<TerrainPoint>, isHeldOut: Uint8Array) => Uint8Array {
  return (points, isHeldOut) => {
    const trainPts: TerrainPoint[] = [];
    const trainIdx: number[] = [];
    for (let i = 0; i < points.length; i++) {
      if (isHeldOut[i] === 1) continue;
      trainPts.push(points[i]);
      trainIdx.push(i);
    }
    // Held-out indices stay 0 by construction.
    const mask = new Uint8Array(points.length);
    if (trainPts.length === 0) return mask;
    const re = classify(trainPts, params);
    for (let j = 0; j < trainIdx.length; j++) {
      mask[trainIdx[j]] = re.isGround[j] === 1 ? 1 : 0;
    }
    return mask;
  };
}
