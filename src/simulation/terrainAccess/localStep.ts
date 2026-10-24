/**
 * localStep.ts — the height figures Terrain Access reads straight off the
 * grid: the step of one move, which `maxStepHeight` gates, and the local
 * relief around a cell, which is only reported.
 *
 * ── THE STEP OF A MOVE IS A DISCONTINUITY, NOT ITS RISE ─────────────────────
 * A move from cell A to its neighbour B by raster offset d rises
 * Δz = z(B) − z(A). On a slope, most or all of that rise is the slope itself,
 * which the grade limit already judges. Comparing the whole rise with the
 * step limit made the step limit a second, tighter grade limit whose angle
 * depended on the cell size: 0.3 m over a 2.566 m cell is a 6.7° cap.
 *
 * So the step is the part of Δz the terrain on either side of the move does
 * not explain. The trend along the same heading is read from the two
 * one-sided differences just outside the move:
 *
 *     behind = z(A) − z(A − d)        ahead = z(B + d) − z(B)
 *
 * Any rise between those two is what a continuous surface whose grade changes
 * once somewhere from A − d to B + d produces (a hill toe, a crest, a bank
 * top), so it is not a discontinuity. The step is how far Δz falls outside
 * that bracket:
 *
 *     step = max(0, Δz − max(behind, ahead), min(behind, ahead) − Δz)
 *
 * which is the smallest |Δz − p| over every p between `behind` and `ahead`.
 * A plane of any slope gives 0 (behind = ahead = Δz); a ledge of height h on
 * a plane of any slope gives h (behind = ahead = Δz − h).
 *
 * When only one of A − d and B + d holds an elevation the bracket is that one
 * difference. When neither does (A and B are the only cells along the heading),
 * the bracket is the Horn gradient at A and at B projected on the move. Horn's
 * 3×3 window spans the move itself, so there a ledge reads at about half its
 * height. With one side only, a change of grade right beside the grid edge or
 * a NoData cell reads as a step: the estimate errs towards blocking there, and
 * {@link stepOneSided} lets a route say which of its moves rest on one side.
 *
 * Why a bracket rather than the mean of the two differences: the mean reads a
 * single change of grade at a cell centre as a step of half that change times
 * the move length (flat ground meeting a 19° slope on 2.566 m cells reads
 * 0.44 m), reads a ledge as a step of h/2 on the moves either side of it, and
 * is a third difference of the heights, so it amplifies DTM noise more than
 * the raw rise does.
 *
 * ── A DIAGONAL MOVE PASSES BETWEEN TWO CORNER CELLS ─────────────────────────
 * The straight trend along a diagonal only reads A − d, A, B and B + d. A
 * one-cell-wide berm or ditch running across the move occupies both corner
 * cells and none of those four, so it would read as no step at all. A
 * diagonal move is therefore taken to cross whichever corner the ground makes
 * easier:
 *
 *     step_diag = max(direct step,
 *                     min over the two corners c of max(step(A → c), step(c → B)))
 *
 * where each of `step(A → c)` and `step(c → B)` is the orthogonal step above,
 * with its own neighbours. A berm or ditch along the diagonal makes both
 * corner paths cross it; a single high or low cell at one corner leaves the
 * other corner open. A corner cell with no elevation is not a way past.
 *
 * ── WHAT IT CANNOT RESOLVE ───────────────────────────────────────────────────
 * A step is only seen at the grid's own resolution. A ledge the DTM spreads
 * over more than one cell (interpolation, a coarse cell) reads as slope and is
 * judged by the grade limit instead. Two ledges inside one cell read as one.
 * The bracket allows one change of grade anywhere in the four cells it reads,
 * so a ledge where the grade also changes reads lower than its height by up
 * to that change in rise per cell; a coarse cell makes that allowance larger.
 * The other way round, a level move between two risers one cell apart (a
 * tread between two steps) reads the smaller riser as its own step.
 *
 * ── LOCAL RELIEF ─────────────────────────────────────────────────────────────
 * `computeLocalStep` is the CELL diagnostic: the largest raw height difference
 * between a cell and any valid cell in its footprint (default the 3×3 window,
 * the neighbourhood Horn's slope estimator and VRM already use). It includes
 * slope as well as steps, is reported as local relief, and is never compared
 * with the step limit.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { GradientField } from './directionalGrade';
import type { TerrainAccessGrid } from './terrainAccessTypes';

/** What the step of a move reads from the grid. */
export type StepGrid = Pick<TerrainAccessGrid, 'z' | 'valid' | 'cols' | 'rows' | 'cellMetresX' | 'cellMetresY'>;

/**
 * Per-cell local relief, row-major, metres: the largest raw height difference
 * between the cell and any valid cell in its footprint. NaN where the cell
 * itself is invalid, or where every neighbour in its footprint is invalid too
 * (nothing to compare against).
 *
 * `footprintRadius` is the half-width of the square window in cells (1 = the
 * 3×3 neighbourhood, the default and the value the traversability core uses
 * unless a caller declares otherwise).
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
 * The raw height difference between two cells, |z(to) − z(from)|, metres. NaN
 * if either is invalid — "no data to compare", never a fabricated 0. This is
 * the rise a move's own grade is read from, not its step.
 */
export function edgeRise(grid: Pick<TerrainAccessGrid, 'z' | 'valid'>, fromIndex: number, toIndex: number): number {
  const { z, valid } = grid;
  if (valid[fromIndex] === 0 || valid[toIndex] === 0) return Number.NaN;
  return Math.abs(z[fromIndex] - z[toIndex]);
}

/** The height at (col, row), or NaN off the grid, at an invalid cell, or for a non-finite height. */
function heightAt(grid: StepGrid, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return Number.NaN;
  const i = row * grid.cols + col;
  if (grid.valid[i] === 0) return Number.NaN;
  const v = grid.z[i];
  return Number.isFinite(v) ? v : Number.NaN;
}

/**
 * The step of the straight move from `fromIndex` by raster offset (dx, dy),
 * metres: how far its rise falls outside the bracket of the one-sided rises
 * just behind and just past it (see the module header). NaN when either
 * endpoint is off the grid or has no elevation. Symmetric: the reverse move
 * has the same step.
 */
export function trendStep(grid: StepGrid, gradient: GradientField, fromIndex: number, dx: number, dy: number): number {
  const { cols } = grid;
  const row = Math.floor(fromIndex / cols);
  const col = fromIndex - row * cols;
  const za = heightAt(grid, col, row);
  const zb = heightAt(grid, col + dx, row + dy);
  if (Number.isNaN(za) || Number.isNaN(zb)) return Number.NaN;
  const rise = zb - za;

  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const zBehind = heightAt(grid, col - dx, row - dy);
  if (!Number.isNaN(zBehind)) {
    const r = za - zBehind;
    lo = r; hi = r;
  }
  const zAhead = heightAt(grid, col + 2 * dx, row + 2 * dy);
  if (!Number.isNaN(zAhead)) {
    const r = zAhead - zb;
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  if (lo > hi) {
    // Neither neighbour along the heading: the Horn gradient at each endpoint
    // projected on the move (rows run north, as `headingUnit` reads them).
    const east = dx * grid.cellMetresX;
    const north = dy * grid.cellMetresY;
    const toIndex = (row + dy) * cols + col + dx;
    const ra = gradient.east[fromIndex] * east + gradient.north[fromIndex] * north;
    const rb = gradient.east[toIndex] * east + gradient.north[toIndex] * north;
    lo = Math.min(ra, rb);
    hi = Math.max(ra, rb);
  }
  return Math.max(0, rise - hi, lo - rise);
}

/**
 * The step `maxStepHeight` gates a move against, metres: {@link trendStep}
 * for an orthogonal move, and for a diagonal move the larger of its own
 * trend step and the easier of the two paths through its corner cells (see
 * the module header). NaN when either endpoint has no elevation.
 */
export function moveStep(grid: StepGrid, gradient: GradientField, fromIndex: number, dx: number, dy: number): number {
  const direct = trendStep(grid, gradient, fromIndex, dx, dy);
  if (dx === 0 || dy === 0 || Number.isNaN(direct)) return direct;
  const { cols } = grid;
  const row = Math.floor(fromIndex / cols);
  const col = fromIndex - row * cols;
  // Corner (col + dx, row): along dx first, then dy. Corner (col, row + dy): the other way round.
  const viaX = Math.max(
    trendStep(grid, gradient, fromIndex, dx, 0),
    trendStep(grid, gradient, row * cols + col + dx, 0, dy),
  );
  const viaY = Math.max(
    trendStep(grid, gradient, fromIndex, 0, dy),
    trendStep(grid, gradient, (row + dy) * cols + col, dx, 0),
  );
  // Math.max propagates NaN, so a corner without an elevation drops out here.
  let corner = Number.NaN;
  if (!Number.isNaN(viaX)) corner = viaX;
  if (!Number.isNaN(viaY)) corner = Number.isNaN(corner) ? viaY : Math.min(corner, viaY);
  return Number.isNaN(corner) ? direct : Math.max(direct, corner);
}

/** Whether the straight trend of the move from (col, row) by (dx, dy) lacks a cell on either side. */
function trendOneSided(grid: StepGrid, col: number, row: number, dx: number, dy: number): boolean {
  return Number.isNaN(heightAt(grid, col - dx, row - dy)) || Number.isNaN(heightAt(grid, col + 2 * dx, row + 2 * dy));
}

/**
 * True when {@link moveStep} read a trend from one side of a move only (or
 * from the Horn fallback): the direct trend, or for a diagonal the trend of
 * any orthogonal move on a corner path whose corner has an elevation, has no
 * cell with an elevation behind its start or past its end. Every such cell
 * lies in the 3×3 window of the move's start or end cell, so a move between
 * two cells whose Horn windows read only the grid is never one-sided. False
 * when either endpoint has no elevation (there is no step to qualify).
 */
export function stepOneSided(grid: StepGrid, fromIndex: number, dx: number, dy: number): boolean {
  const { cols } = grid;
  const row = Math.floor(fromIndex / cols);
  const col = fromIndex - row * cols;
  if (Number.isNaN(heightAt(grid, col, row)) || Number.isNaN(heightAt(grid, col + dx, row + dy))) return false;
  if (trendOneSided(grid, col, row, dx, dy)) return true;
  if (dx === 0 || dy === 0) return false;
  if (!Number.isNaN(heightAt(grid, col + dx, row))
    && (trendOneSided(grid, col, row, dx, 0) || trendOneSided(grid, col + dx, row, 0, dy))) return true;
  return !Number.isNaN(heightAt(grid, col, row + dy))
    && (trendOneSided(grid, col, row, 0, dy) || trendOneSided(grid, col, row + dy, dx, 0));
}
