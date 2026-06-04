/**
 * idwFill.ts
 *
 * Pure-data leaf — void interpolation by inverse-distance weighting
 * (IDW). It replaces the previous nearest-finite flood fill for the DTM
 * height surface, which assigned every empty cell the value of its single
 * closest measured cell — producing blocky Voronoi terraces whose
 * contours stair-stepped. IDW blends the k nearest measured cells,
 * weighted by 1/distance^power, so a void is filled by a smooth, locally
 * supported estimate instead of one neighbour's value.
 *
 * Honesty is preserved by SEPARATION OF CONCERNS: this module only
 * produces better interpolated HEIGHTS. Whether a cell is measured,
 * interpolated, or an unreachable gap — and how much confidence it earns
 * — is still decided in `cellConfidence.ts` from coverage and
 * distance-to-data. A smoother interpolant does not raise a cell's
 * confidence; it only makes the interpolated height a better guess.
 *
 * Algorithm (deterministic): for each empty cell, expand a square ring
 * search outwards until at least `kNearest` measured cells are collected
 * or `maxRadiusCells` is reached, then weight the collected samples by
 * 1/d^power (an exact hit returns that value). Cells with no measured
 * cell inside `maxRadiusCells` are left NaN — the caller decides the
 * fallback. Exact distances make the result independent of scan order.
 *
 * No DOM, no three.js, no I/O.
 */

/** Options for {@link idwFill}. */
export interface IdwParams {
  /** Distance exponent. 2 = classic IDW. Higher = more local. Default 2. */
  readonly power?: number;
  /** Stop collecting once this many measured cells are found. Default 12. */
  readonly kNearest?: number;
  /**
   * Maximum search radius in cells. A void with no measured cell within
   * this radius stays NaN. Default 32 — large enough for typical gaps,
   * bounded so the search stays O(cells · radius^2) in the worst case.
   */
  readonly maxRadiusCells?: number;
}

/**
 * Fill empty cells of a row-major grid by IDW over the nearest measured
 * cells. `hadData[i] === 1` marks measured cells (kept verbatim). Empty
 * cells with no measured cell within `maxRadiusCells` stay NaN.
 */
export function idwFill(
  z: Float32Array,
  hadData: Uint8Array,
  cols: number,
  rows: number,
  params: IdwParams = {},
): Float32Array {
  const n = cols * rows;
  const out = new Float32Array(n);
  out.set(z);
  if (n === 0) return out;

  const power = Number.isFinite(params.power) && (params.power as number) > 0 ? (params.power as number) : 2;
  const kNearest = Math.max(1, Math.floor(params.kNearest ?? 12));
  const maxRadius = Math.max(1, Math.floor(params.maxRadiusCells ?? 32));

  // Quick exit if there is nothing to interpolate from.
  let anyData = false;
  for (let i = 0; i < n; i++) {
    if (hadData[i] === 1) {
      anyData = true;
      break;
    }
  }
  if (!anyData) {
    out.fill(NaN);
    return out;
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (hadData[i] === 1) continue; // measured — keep as-is

      // Expanding square-ring search for measured cells.
      let wSum = 0;
      let vSum = 0;
      let found = 0;
      let radius = 1;
      // `lastFoundRadius` lets us finish the ring at which we crossed k so
      // the result doesn't depend on scan order within that ring.
      let lastFoundRadius = -1;
      while (radius <= maxRadius) {
        // Walk only the perimeter cells at Chebyshev distance === radius.
        const rLo = row - radius;
        const rHi = row + radius;
        const cLo = col - radius;
        const cHi = col + radius;
        for (let r = rLo; r <= rHi; r++) {
          if (r < 0 || r >= rows) continue;
          const onRowEdge = r === rLo || r === rHi;
          for (let c = cLo; c <= cHi; c++) {
            if (c < 0 || c >= cols) continue;
            // Perimeter only: full rows on top/bottom, else just the ends.
            if (!onRowEdge && c !== cLo && c !== cHi) continue;
            const j = r * cols + c;
            if (hadData[j] !== 1) continue;
            const dr = r - row;
            const dc = c - col;
            const dist = Math.sqrt(dr * dr + dc * dc);
            const w = 1 / Math.pow(dist, power);
            wSum += w;
            vSum += w * z[j];
            found++;
          }
        }
        if (found >= kNearest && lastFoundRadius < 0) lastFoundRadius = radius;
        // Finish one extra ring past crossing k so all equidistant
        // neighbours at the boundary contribute, then stop.
        if (lastFoundRadius >= 0 && radius >= lastFoundRadius + 1) break;
        radius++;
      }

      out[i] = wSum > 0 ? vSum / wSum : NaN;
    }
  }
  return out;
}
