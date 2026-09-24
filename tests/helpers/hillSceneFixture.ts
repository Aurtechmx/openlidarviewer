/**
 * tests/helpers/hillSceneFixture.ts
 *
 * A small synthetic hill, shared by analysePanelCoverageTile.test.ts and
 * analyseSurfaceTilesKeyboard.test.ts so `analyseContours()` yields both
 * covered and interpolated cells for the Analyse-panel tile tests.
 */

import type { TerrainPoint } from '../../src/terrain/TerrainContracts';

export function hillScene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 30; x++) {
    for (let y = 0; y <= 30; y++) {
      const dx = x - 15;
      const dy = y - 15;
      pts.push({ x, y, z: 6 * Math.exp(-(dx * dx + dy * dy) / 200) });
    }
  }
  return pts;
}
