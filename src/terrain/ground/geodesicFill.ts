/**
 * geodesicFill.ts
 *
 * Void interpolation that measures distance ALONG the terrain surface (a
 * geodesic / shortest path over the grid) instead of straight-line. Following
 * Duan, Ge & He (2025, Remote Sensing of Environment 328:114900), this fixes
 * the classic IDW failure where a void on one side of a ridge or channel is
 * filled from measured cells on the OTHER side: the surface path has to climb
 * over the crest, so its geodesic cost is large and that far-side cell is
 * correctly down-weighted. They report ~13-17% RMSE reduction vs Euclidean IDW.
 *
 * Bounded, pure-data, deterministic:
 *   Pass 1 — a plain Euclidean IDW prefill (`idwFill`) gives a provisional
 *            surface to walk on (voids have no height of their own yet).
 *   Pass 2 — for each void cell, a Dijkstra over an 8-connected window (capped
 *            at `maxRadiusCells` from the source) accumulates path cost
 *            = Σ sqrt(stepXY² + Δz²) — both terms in METRES — using the
 *            prefilled heights, collecting the
 *            nearest `kNearest` MEASURED cells by geodesic cost; the void is the
 *            inverse-distance blend of those (weight 1/cost^power).
 *
 * KNOWN LIMIT — pass 1 is frame-blind. `idwFill` weights by distance in CELLS,
 * isotropically, so on an anisotropic grid (a geographic raster away from the
 * equator, where the E–W cell is cos φ × the N–S cell) the provisional surface
 * is built by an interpolant that does not know the cells are not square. Pass
 * 2's step cost is metre-correct, but every Δz it differences comes from that
 * surface. Because IDW weights are normalised (1/d^power over the collected
 * samples), a UNIFORM scale cancels exactly — so projected frames, metre or
 * foot, are unaffected and this is a geographic-only residual. Fixing it means
 * metric distances in `idwFill`, which also changes the DEFAULT (non-geodesic)
 * fill and needs its expanding Chebyshev ring search reworked, since "the k
 * nearest" would no longer follow cell-ring order. Deliberately out of scope
 * here; the pass-2 unit bug it sat behind is the one being fixed.
 *
 * Honesty is unchanged: this only produces better interpolated HEIGHTS. Which
 * cells count as measured / interpolated / gap, and their confidence, is still
 * decided in cellConfidence.ts. No DOM, no I/O.
 */

import { idwFill } from './idwFill';

export interface GeodesicParams {
  /** Distance exponent for the inverse-distance blend. Default 2. */
  readonly power?: number;
  /** Measured cells to collect per void before blending. Default 12. */
  readonly kNearest?: number;
  /** Max search radius in cells from each void (bounds the Dijkstra). Default 24. */
  readonly maxRadiusCells?: number;
  /**
   * East–west (column) cell size in METRES — the horizontal half of the step
   * cost. Callers derive it with `horizontalCellMetresXY`, the same helper the
   * slope stage uses, so a geographic (degree) or foot grid converts once and
   * identically. Default 1.
   */
  readonly cellMetresX?: number;
  /** North–south (row) cell size in metres. Defaults to `cellMetresX`. */
  readonly cellMetresY?: number;
  /**
   * Metres per vertical unit (`verticalUnitToMetres`), applied to Δz. Default 1.
   * The step cost is sqrt(stepXY² + Δz²), so the two terms must be in the same
   * unit; a foot-vertical grid measured against metre steps overstates the climb.
   */
  readonly verticalUnitToMetres?: number;
}

/** Positive-and-finite guard, or the fallback. Never a silent 0 step. */
function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

// 8-connected neighbour offsets.
const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
const DC = [-1, 0, 1, -1, 1, -1, 0, 1];

/**
 * Fill empty cells (`hadData[i] === 0`) by geodesic-distance IDW over the
 * nearest measured cells. Measured cells are kept verbatim; voids the prefill
 * couldn't reach stay NaN (the caller decides the fallback).
 */
export function geodesicFill(
  z: Float32Array,
  hadData: Uint8Array,
  cols: number,
  rows: number,
  params: GeodesicParams = {},
): Float32Array {
  const n = cols * rows;
  const out = new Float32Array(n);
  out.set(z);
  if (n === 0) return out;

  const power = Number.isFinite(params.power) && (params.power as number) > 0 ? (params.power as number) : 2;
  const kNearest = Math.max(1, Math.floor(params.kNearest ?? 12));
  const maxRadius = Math.max(1, Math.floor(params.maxRadiusCells ?? 24));
  const cellX = positiveOr(params.cellMetresX, 1);
  const cellY = positiveOr(params.cellMetresY, cellX);
  const zScale = positiveOr(params.verticalUnitToMetres, 1);
  // Diagonal step length in metres — the hypotenuse of the two axes, which
  // reduces to cell·√2 on a square grid (the historical isotropic step).
  const cellDiag = Math.hypot(cellX, cellY);

  // Pass 1 — Euclidean prefill gives a walkable provisional surface.
  const surface = idwFill(z, hadData, cols, rows, { power, kNearest, maxRadiusCells: maxRadius });

  // Per-void Dijkstra scratch, reused across cells via a stamp so we never
  // pay an O(n) clear: a cell is "seen this void" when `seen[c] === iter`.
  const dist = new Float64Array(n);
  const seen = new Int32Array(n).fill(-1);
  // A measured cell can be pushed several times (a cheaper geodesic path found
  // after the first push), and the pop reads `dist[c]` rather than the popped
  // entry's cost, so without a guard the same measured cell is absorbed into the
  // blend more than once — double-counting its weight and over-incrementing the
  // kNearest tally. `absorbed[c] === iter` marks it consumed for this void.
  const absorbed = new Int32Array(n).fill(-1);
  // Binary min-heap over (cost, node) as parallel arrays.
  const heapCost = new Float64Array(n);
  const heapNode = new Int32Array(n);
  let heapLen = 0;
  const swap = (a: number, b: number): void => {
    const tc = heapCost[a]; heapCost[a] = heapCost[b]; heapCost[b] = tc;
    const tn = heapNode[a]; heapNode[a] = heapNode[b]; heapNode[b] = tn;
  };
  const heapPush = (cost: number, node: number): void => {
    let i = heapLen++;
    heapCost[i] = cost; heapNode[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapCost[p] <= heapCost[i]) break;
      swap(p, i); i = p;
    }
  };
  const heapPop = (): number => {
    const top = heapNode[0];
    heapLen--;
    if (heapLen > 0) {
      heapCost[0] = heapCost[heapLen]; heapNode[0] = heapNode[heapLen];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let s = i;
        if (l < heapLen && heapCost[l] < heapCost[s]) s = l;
        if (r < heapLen && heapCost[r] < heapCost[s]) s = r;
        if (s === i) break;
        swap(s, i); i = s;
      }
    }
    return top;
  };

  for (let srow = 0; srow < rows; srow++) {
    for (let scol = 0; scol < cols; scol++) {
      const src = srow * cols + scol;
      if (hadData[src] === 1) continue; // measured — keep verbatim
      if (!Number.isFinite(surface[src])) { out[src] = Number.NaN; continue; } // unreachable gap

      const iter = src; // unique per void; stamps scratch arrays
      heapLen = 0;
      dist[src] = 0; seen[src] = iter;
      heapPush(0, src);

      let wSum = 0;
      let vSum = 0;
      let collected = 0;

      while (heapLen > 0 && collected < kNearest) {
        const c = heapPop();
        const cost = dist[c];
        if (hadData[c] === 1) {
          // Nearest measured cell by geodesic cost — absorb into the blend and
          // do not expand through it. Skip a stale duplicate pop so each measured
          // cell contributes exactly once (its first, lowest-cost pop).
          if (absorbed[c] === iter) continue;
          absorbed[c] = iter;
          const w = 1 / Math.pow(cost, power);
          wSum += w; vSum += w * z[c];
          collected++;
          continue;
        }
        const cr = (c / cols) | 0;
        const cc = c - cr * cols;
        for (let k = 0; k < 8; k++) {
          const nr = cr + DR[k];
          const nc = cc + DC[k];
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          // Stay within the window around the source so the search is bounded.
          if (Math.abs(nr - srow) > maxRadius || Math.abs(nc - scol) > maxRadius) continue;
          const nb = nr * cols + nc;
          if (!Number.isFinite(surface[nb])) continue; // can't walk over unknown ground
          let stepXY: number;
          if (DR[k] !== 0 && DC[k] !== 0) stepXY = cellDiag;
          else if (DC[k] !== 0) stepXY = cellX;
          else stepXY = cellY;
          const dz = (surface[nb] - surface[c]) * zScale;
          const nd = cost + Math.sqrt(stepXY * stepXY + dz * dz);
          if (seen[nb] !== iter || nd < dist[nb]) {
            dist[nb] = nd; seen[nb] = iter;
            heapPush(nd, nb);
          }
        }
      }

      out[src] = wSum > 0 ? vSum / wSum : surface[src];
    }
  }
  return out;
}
