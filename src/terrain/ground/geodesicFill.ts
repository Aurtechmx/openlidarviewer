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
  /**
   * Heap pops the whole fill may spend. Default {@link GEODESIC_NODE_BUDGET}.
   * Exposed so a test can drive the abandon path without building a grid large
   * enough to reach the real ceiling.
   */
  readonly nodeBudget?: number;
  /**
   * Voids sampled to project the cost. Default {@link GEODESIC_PROBE_VOIDS}.
   *
   * Exposed because the sample size sets the order voids are solved in, and a
   * fill whose answer depended on that order would be a defect the default
   * alone could not reveal.
   */
  readonly probeVoids?: number;
}

/**
 * Heap pops the whole fill may spend before it abandons the geodesic pass.
 *
 * `maxRadiusCells` bounds the work for ONE void, and nothing bounded the total.
 * A scan of scattered single-cell voids is cheap because each Dijkstra finds
 * its twelve measured cells within a step or two, and a scan with large
 * contiguous gaps is not: every void inside a blob has to expand most of its
 * radius-24 window first. The only thing separating the two cases is void
 * shape, which no existing cap looked at.
 *
 * Pops are the unit because they are the reproducible measurement: the same
 * grid yields the same count on every run and every machine, while the seconds
 * below moved 40% between two runs on one loaded laptop.
 *
 *   2000x2000, 35% scattered voids     28M pops     2.3 to 2.8 s
 *   500x500, 32-cell void tiles        35M pops     6.1 s
 *   1000x1000, 32-cell void tiles     137M pops    23.5 to 23.8 s
 *   1500x1500, 64-cell void tiles     629M pops    83 s
 *
 * Sixty million sits above every scattered case and above the smallest blobby
 * one, and below the grids that run for tens of seconds. What it bounds is
 * work; how long that work takes is the device's business.
 */
export const GEODESIC_NODE_BUDGET = 60_000_000;

/** Voids sampled to project the cost of the whole pass. */
export const GEODESIC_PROBE_VOIDS = 2_000;

/** What the fill actually did, so a caller can say which method built a cell. */
export interface GeodesicFillReport {
  /** Void cells the pass was asked to fill. */
  readonly voids: number;
  /** True when the pass was given up and no void got a geodesic value. */
  readonly abandoned: boolean;
  /**
   * Which check gave the pass up.
   *
   * `'projection'` means it never started, because the probe's estimate was
   * already above the ceiling. `'ceiling'` means it started and ran out, which
   * happens when the estimate was low. The two need different words in a
   * report: only the first can say the cost was projected above the ceiling.
   */
  readonly stoppedBy: 'projection' | 'ceiling' | null;
  /** Heap pops spent, including the probe. */
  readonly nodesExpanded: number;
  /** Pops the projection expected for the whole grid, from the probe. */
  readonly projectedNodes: number;
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
  return geodesicFillWithReport(z, hadData, cols, rows, params).z;
}

/**
 * {@link geodesicFill}, plus what it did.
 *
 * The pass is costed before it is committed to. A strided sample of voids is
 * solved first and its pops per void projected over the whole void set; if the
 * projection exceeds the budget the geodesic values are discarded and every
 * void keeps its Euclidean prefill. All or nothing, deliberately: a surface
 * built by one interpolant in the north and another in the south is harder to
 * defend than one built throughout by the weaker of the two and labelled as
 * such, and the seam between them would be visible in the contours.
 *
 * The sample strides through the voids in index order, so it spans the grid and
 * the same grid always yields the same answer.
 */
export function geodesicFillWithReport(
  z: Float32Array,
  hadData: Uint8Array,
  cols: number,
  rows: number,
  params: GeodesicParams = {},
): { z: Float32Array; report: GeodesicFillReport } {
  const n = cols * rows;
  const out = new Float32Array(n);
  out.set(z);
  const empty: GeodesicFillReport = {
    voids: 0, abandoned: false, stoppedBy: null, nodesExpanded: 0, projectedNodes: 0,
  };
  if (n === 0) return { z: out, report: empty };

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

  // Pops spent so far, the unit the budget is denominated in.
  let pops = 0;

  /** Solve one void by geodesic-distance IDW, writing `out[src]`. */
  const solve = (src: number): void => {
    const srow = (src / cols) | 0;
    const scol = src - srow * cols;
    const iter = src; // unique per void; stamps scratch arrays
    heapLen = 0;
    dist[src] = 0; seen[src] = iter;
    heapPush(0, src);

    let wSum = 0;
    let vSum = 0;
    let collected = 0;

    while (heapLen > 0 && collected < kNearest) {
      const c = heapPop();
      pops++;
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
  };

  // The voids to fill, in index order. A cell the prefill could not reach has
  // no provisional height to walk from, so it stays NaN and the caller decides.
  const voids: number[] = [];
  for (let i = 0; i < n; i++) {
    if (hadData[i] === 1) continue; // measured — keep verbatim
    if (!Number.isFinite(surface[i])) { out[i] = Number.NaN; continue; } // unreachable gap
    voids.push(i);
  }
  if (voids.length === 0) return { z: out, report: empty };

  // Probe: solve a strided sample, then project its pops per void over the
  // whole set. Striding through the void list rather than taking its head
  // spreads the sample across the grid, where the expensive voids are: one
  // inside a large gap has to expand most of its window before it collects
  // kNearest measured cells, and one beside a measured cell does not.
  const probeVoids = Math.max(1, Math.floor(positiveOr(params.probeVoids, GEODESIC_PROBE_VOIDS)));
  const probeStride = Math.max(1, Math.ceil(voids.length / probeVoids));
  let probed = 0;
  for (let i = 0; i < voids.length; i += probeStride) { solve(voids[i]); probed++; }
  const projectedNodes = Math.round((pops / probed) * voids.length);

  const nodeBudget = positiveOr(params.nodeBudget, GEODESIC_NODE_BUDGET);
  if (projectedNodes > nodeBudget) {
    // Discard the probe's geodesic values so the whole grid is one interpolant.
    for (const src of voids) out[src] = surface[src];
    return {
      z: out,
      report: {
        voids: voids.length, abandoned: true, stoppedBy: 'projection',
        nodesExpanded: pops, projectedNodes,
      },
    };
  }

  for (let i = 0; i < voids.length; i++) {
    if (i % probeStride === 0) continue; // solved by the probe
    solve(voids[i]);
    // The projection decides whether to start; this decides whether to finish.
    // Cost per void varies by two orders of magnitude between a void beside
    // measured ground and one deep inside a gap, and a strided sample of that
    // distribution can be well out: measured across 24 void morphologies the
    // median error is 0.5% and the worst is 36%. Without this the ceiling would
    // bound a projection rather than the work, which is not what it is for.
    if (pops > nodeBudget) {
      for (const src of voids) out[src] = surface[src];
      return {
        z: out,
        report: {
          voids: voids.length, abandoned: true, stoppedBy: 'ceiling',
          nodesExpanded: pops, projectedNodes,
        },
      };
    }
  }
  return {
    z: out,
    report: {
      voids: voids.length, abandoned: false, stoppedBy: null,
      nodesExpanded: pops, projectedNodes,
    },
  };
}
