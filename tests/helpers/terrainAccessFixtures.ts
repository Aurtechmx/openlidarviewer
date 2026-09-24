/**
 * terrainAccessFixtures.ts — the `gridOf`/`PERMISSIVE` fixtures shared by the
 * Terrain Access unit tests. Sonar flagged near-identical copies of both in
 * terrainAccessAdversarial.test.ts, terrainAccessTraversabilityCost.test.ts,
 * terrainAccessAStar.test.ts and terrainAccessLocalStep.test.ts.
 *
 * `confidence` is 0 for a NoData cell and 100 for a valid one — the shared
 * semantics three of the four already used (the fourth filled every cell,
 * including NoData ones, with 100; no test in this tree ever read a NoData
 * cell's confidence, so switching it to 0 changes nothing observable).
 */
import type { TerrainAccessGrid, TerrainAccessProfile } from '../../src/simulation/terrainAccess/terrainAccessTypes';

/** A grid from a row-major elevation list; `null` marks NoData. `over` overrides any field (e.g. `allowed`, `coverage`). */
export function gridOf(
  rows: readonly (readonly (number | null)[])[],
  over: Partial<TerrainAccessGrid> = {},
): TerrainAccessGrid {
  const h = rows.length;
  const w = rows[0].length;
  const z = new Float32Array(w * h).fill(Number.NaN);
  const valid = new Uint8Array(w * h);
  const confidence = new Float32Array(w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const v = rows[r][c];
      if (v === null) continue;
      z[r * w + c] = v;
      valid[r * w + c] = 1;
      confidence[r * w + c] = 100;
    }
  }
  return {
    z, valid, confidence, coverage: null, heightAboveGround: null, allowed: null,
    cols: w, rows: h, cellMetresX: 1, cellMetresY: 1,
    ...over,
  };
}

/** A mobility profile with every limit effectively unconstrained (tan 10 ≈ 84°), for tests that exercise something other than the limits themselves. */
export const PERMISSIVE: TerrainAccessProfile = Object.freeze({
  name: 'test',
  maxLongitudinalGrade: 10,
  maxCrossSlope: 10,
  maxStepHeight: 10,
  maxRuggedness: null,
  vehicleWidth: 0,
  vehicleLength: null,
  minimumTerrainConfidence: 0,
  unknownPolicy: 'block',
  obstacleHeightThreshold: null,
});
