/**
 * localStep.ts — the step-height metric §12.4 of the governing prompt asks
 * for: "maximum absolute elevation discontinuity between the current cell and
 * valid neighbouring cells within the declared local footprint".
 *
 * Two related numbers live here, both derived from the same elevation grid so
 * neither is a second, silently-divergent estimator:
 *
 *  - `computeLocalStep` is the CELL diagnostic: the worst discontinuity in a
 *    cell's footprint (default the 3×3 window — a 1-cell radius — the same
 *    neighbourhood Horn's slope estimator and VRM already use). It is what
 *    the traversability map, route diagnostics and the why-not inspector
 *    show as "step" for a cell, independent of which direction a route
 *    enters or leaves it.
 *
 *  - `edgeStep` is the pairwise discontinuity between two specific adjacent
 *    cells: `|z[to] - z[from]|`. It is exactly the radius-1 footprint term
 *    for the neighbour actually being moved to, which is what physically
 *    determines whether THAT move is passable. `aStarTerrain.ts` and
 *    `traversabilityCost.ts` gate a move against `edgeStep`, not the
 *    footprint maximum, because a discontinuity elsewhere in the 3×3 window
 *    that the route does not cross is not a reason to block the move that
 *    it does take. TA-4 ("a one-cell elevation discontinuity … blocks
 *    passage") is exactly `edgeStep` on the edge being tested.
 *
 * Both read only `z`/`valid`; neither needs cell size, because a step is a
 * vertical discontinuity, not a slope — it says nothing about the horizontal
 * distance it occurs over.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainAccessGrid } from './terrainAccessTypes';

/**
 * Per-cell local step, row-major, metres. NaN where the cell itself is
 * invalid, or where every neighbour in its footprint is invalid too (nothing
 * to compare against).
 *
 * `footprintRadius` is the half-width of the square window in cells (1 = the
 * 3×3 neighbourhood, the default and the value the traversability core uses
 * unless a caller declares otherwise). Documented here rather than left
 * implicit, per §12.4's "the exact window/footprint must be documented".
 */
export function computeLocalStep(grid: TerrainAccessGrid, footprintRadius = 1): Float32Array {
  const { z, valid, cols, rows } = grid;
  const n = cols * rows;
  const step = new Float32Array(n).fill(Number.NaN);
  const radius = Number.isInteger(footprintRadius) && footprintRadius >= 1 ? footprintRadius : 1;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (valid[i] === 0) continue;
      const zHere = z[i];
      let worst = Number.NaN;
      for (let dr = -radius; dr <= radius; dr++) {
        const r = row + dr;
        if (r < 0 || r >= rows) continue;
        for (let dc = -radius; dc <= radius; dc++) {
          if (dr === 0 && dc === 0) continue;
          const c = col + dc;
          if (c < 0 || c >= cols) continue;
          const j = r * cols + c;
          if (valid[j] === 0) continue;
          const d = Math.abs(zHere - z[j]);
          if (!(worst >= d)) worst = d; // NaN-safe "worst < d" that also captures the first sample
        }
      }
      step[i] = worst;
    }
  }
  return step;
}

/**
 * The elevation discontinuity between two specific adjacent cells, metres.
 * NaN if either is invalid — "no data to compare", never a fabricated 0.
 */
export function edgeStep(grid: TerrainAccessGrid, fromIndex: number, toIndex: number): number {
  const { z, valid } = grid;
  if (valid[fromIndex] === 0 || valid[toIndex] === 0) return Number.NaN;
  return Math.abs(z[fromIndex] - z[toIndex]);
}
