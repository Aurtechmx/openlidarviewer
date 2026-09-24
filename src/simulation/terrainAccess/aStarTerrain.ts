/**
 * aStarTerrain.ts — deterministic 8-connected A* over the eligible cells of a
 * terrain-access grid, per §12.8 of the governing prompt.
 *
 * ── ADMISSIBILITY ────────────────────────────────────────────────────────
 * `edgeCost` (traversabilityCost.ts) is `distance · multiplier` with
 * `multiplier ≥ 1` always (every soft-cost term is a non-negative utilization
 * added to the base 1). So true physical (planimetric, metres) distance from
 * any cell to the goal is a lower bound on the cost still to pay, and it is
 * also a genuine metric (it satisfies the triangle inequality), which makes
 * this heuristic not just admissible but CONSISTENT: no cell is ever
 * re-opened after being closed, and a closed cell's `g` is final the moment
 * it is popped.
 *
 * ── THE TIE-BREAK, WRITTEN DOWN RATHER THAN LEFT TO THE HEAP ────────────────
 * Two open cells can carry the identical `f = g + h` — a symmetric cost
 * surface produces this constantly. Expanding whichever the heap happens to
 * return first would make the exact route depend on heap implementation
 * details, which is not a route the same inputs can be trusted to reproduce.
 * The order here is fixed and total:
 *
 *   1. lower f (standard A*);
 *   2. lower h (prefer the node nearer the goal — a standard, deterministic
 *      A* tie-break, sometimes called "greedy tie-breaking");
 *   3. lower cell index (row-major) — an arbitrary but TOTAL and stable
 *      final tie-break, so no two distinct cells ever compare equal.
 *
 * Within one cell's expansion, neighbours are tried in the fixed
 * `TERRAIN_ACCESS_NEIGHBOURS` order and a candidate only replaces an already
 *-open cell's `g` on a STRICT improvement, so among several neighbours that
 * would reach a third cell at equal cost, the first one in that fixed order
 * wins. Both rules together make the returned path a pure function of the
 * grid, the profile and the two endpoints.
 *
 * ── NEVER CROSSES A BLOCKED CELL ─────────────────────────────────────────
 * A cell whose `eligibility.blocked` bit is set is never pushed onto the open
 * set, in either direction, and an edge `evaluateEdge` reports as blocked is
 * skipped before a cost is even computed for it. No blocked cell can
 * therefore ever receive a finite `g`, so none can appear in a reconstructed
 * path — pinned directly by test rather than only implied by the search.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { edgeCost } from './traversabilityCost';
import { TERRAIN_ACCESS_NEIGHBOURS, type TerrainAccessGrid, type TerrainAccessProfile } from './terrainAccessTypes';
import type { CostWeights, NodeEligibility, TerrainAccessFeatures } from './traversabilityCost';

export type AStarOutcome = 'FOUND' | 'NO_ROUTE' | 'START_BLOCKED' | 'END_BLOCKED';

/** A completed (or failed) search. */
export interface AStarResult {
  readonly outcome: AStarOutcome;
  /** Cell indices from start to goal inclusive, or empty when not FOUND. */
  readonly path: readonly number[];
  /** Total route cost (the A* `g` at the goal), or null when not FOUND. */
  readonly cost: number | null;
  /** Cells popped from the open set — a search-effort figure for benchmarks. */
  readonly explored: number;
}

/** One entry in the binary min-heap: a cell and its ordering keys. */
interface OpenEntry {
  readonly index: number;
  readonly f: number;
  readonly h: number;
}

/** Ordering per the module header: lower f, then lower h, then lower index. */
function isBetter(a: OpenEntry, b: OpenEntry): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  return a.index < b.index;
}

/** A minimal binary min-heap keyed by {@link isBetter}. */
class OpenHeap {
  private readonly items: OpenEntry[] = [];

  get size(): number { return this.items.length; }

  push(entry: OpenEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!isBetter(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop(): OpenEntry | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as OpenEntry;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let smallest = i;
        if (l < items.length && isBetter(items[l], items[smallest])) smallest = l;
        if (r < items.length && isBetter(items[r], items[smallest])) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Planimetric straight-line distance between two cells, in metres. */
function heuristic(grid: TerrainAccessGrid, from: number, to: number): number {
  const cols = grid.cols;
  const fr = Math.floor(from / cols);
  const fc = from - fr * cols;
  const tr = Math.floor(to / cols);
  const tc = to - tr * cols;
  return Math.hypot((tc - fc) * grid.cellMetresX, (tr - fr) * grid.cellMetresY);
}

/**
 * Search for the least-cost route from `startIndex` to `endIndex` over the
 * cells `eligibility` (post width-clearance) accepts.
 */
export function aStarTerrain(
  grid: TerrainAccessGrid,
  features: TerrainAccessFeatures,
  eligibility: NodeEligibility,
  profile: TerrainAccessProfile,
  startIndex: number,
  endIndex: number,
  weights: CostWeights,
): AStarResult {
  const n = grid.cols * grid.rows;
  const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n;

  if (!inRange(startIndex) || eligibility.blocked[startIndex] === 1) {
    return { outcome: 'START_BLOCKED', path: [], cost: null, explored: 0 };
  }
  if (!inRange(endIndex) || eligibility.blocked[endIndex] === 1) {
    return { outcome: 'END_BLOCKED', path: [], cost: null, explored: 0 };
  }
  if (startIndex === endIndex) {
    return { outcome: 'FOUND', path: [startIndex], cost: 0, explored: 0 };
  }

  const gScore = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  gScore[startIndex] = 0;

  const open = new OpenHeap();
  open.push({ index: startIndex, f: heuristic(grid, startIndex, endIndex), h: heuristic(grid, startIndex, endIndex) });

  let explored = 0;
  while (open.size > 0) {
    const current = open.pop() as OpenEntry;
    const i = current.index;
    if (closed[i] === 1) continue; // a stale duplicate entry from an earlier, worse push
    closed[i] = 1;
    explored++;

    if (i === endIndex) {
      const path: number[] = [];
      let at = endIndex;
      while (at !== -1) { path.push(at); at = cameFrom[at]; }
      path.reverse();
      return { outcome: 'FOUND', path, cost: gScore[endIndex], explored };
    }

    const row = Math.floor(i / grid.cols);
    const col = i - row * grid.cols;
    for (const [dx, dy] of TERRAIN_ACCESS_NEIGHBOURS) {
      const c = col + dx;
      const r = row + dy;
      if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
      const j = r * grid.cols + c;
      if (closed[j] === 1 || eligibility.blocked[j] === 1) continue;
      const cost = edgeCost(grid, features, profile, i, j, dx, dy, weights);
      if (cost == null) continue; // edge itself hard-blocked
      const tentative = gScore[i] + cost;
      if (tentative < gScore[j]) {
        gScore[j] = tentative;
        cameFrom[j] = i;
        const h = heuristic(grid, j, endIndex);
        open.push({ index: j, f: tentative + h, h });
      }
    }
  }

  return { outcome: 'NO_ROUTE', path: [], cost: null, explored };
}
