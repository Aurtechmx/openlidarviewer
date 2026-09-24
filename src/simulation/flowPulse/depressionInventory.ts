/**
 * depressionInventory.ts — sinks and filled depressions, catalogued rather
 * than summed into one count.
 *
 * `priorityFlood` already reports how many cells it raised and the deepest
 * rise, but those are grid-wide totals: a reader cannot tell a single deep
 * borrow pit from fifty shallow single-cell potholes that happen to sum to
 * the same `cellsRaised`. This groups the raised cells into their connected
 * depressions and reports each one — cell count, area, its own deepest fill,
 * and the elevation of the rim it would spill over — which is what §10.10
 * asks for and what "do not call every single-cell sink a natural pond"
 * requires a caller to be able to tell apart.
 *
 * ── RAW MODE REPORTS CANDIDATES, NOT EXTENTS ────────────────────────────────
 * Without conditioning there is no filled surface to group, so raw mode lists
 * each D8 sink as its own one-cell candidate: a pinpoint, not the depression's
 * true extent. Finding that extent is exactly what Priority-Flood computes, so
 * a raw-mode "depression" here is honestly a single low point, not a claim
 * about how much ground would pond behind it.
 *
 * ── SINK COUNT IS ALWAYS ABOUT THE RAW SURFACE ──────────────────────────────
 * Conditioning removes most interior sinks by construction, so a sink count
 * read off the conditioned routing would mostly say "conditioning worked" —
 * not how many depressions the raw terrain actually had. This runs its own D8
 * pass over the unconditioned grid for that count, regardless of which
 * surface the caller's main run routed over. The extra pass is O(cells), the
 * same order the routing model itself runs at, in exchange for one honest
 * number in both modes.
 *
 * ── THE OUTLET ELEVATION ─────────────────────────────────────────────────
 * For a filled depression, the outlet is the lowest raw elevation among the
 * valid, unfilled cells immediately touching it — the lowest point on its
 * rim, which is where the flood entered before finding anywhere higher to go.
 * Every filled cell is interior (Priority-Flood never raises a boundary
 * seed), so a depression cannot fail to have at least one such neighbour
 * unless it is entirely enclosed by NoData, which `cellsUnreachable` already
 * covers separately and which this module leaves the elevation `null` for.
 *
 * ── DETERMINISTIC ORDERING ──────────────────────────────────────────────────
 * Depressions rank largest cell count first; single-cell raw candidates,
 * which carry no size to rank by, are ordered by grid position instead. Both
 * tie-break on the lowest member cell index, so the order depends only on the
 * grid and never on component-discovery order or object-key iteration.
 *
 * Pure: no DOM, no three.js, no I/O.
 */

import { CELL_SINK, D8_NEIGHBOURS, type FlowGrid } from './flowTypes';
import { d8Flow } from './d8Flow';
import type { PriorityFloodResult } from './priorityFlood';

/** One sink candidate (raw mode) or one filled depression (conditioned mode). */
export interface DepressionEntry {
  /** 1-based position in the deterministic ordering. */
  readonly rank: number;
  /** Cells in this depression, itself included. */
  readonly cells: number;
  /** `cells * cell area`, or null when the horizontal scale is unresolved. */
  readonly areaM2: number | null;
  /**
   * The deepest rise within this depression. Null in raw mode: without
   * conditioning there is no filled surface to measure a rise against.
   */
  readonly maxFillDepth: number | null;
  /**
   * The lowest raw elevation on this depression's rim — where it would spill.
   * Null when not determinable: raw mode, or a depression Priority-Flood
   * could not reach (see `cellsUnreachable` on {@link PriorityFloodResult}).
   */
  readonly outletElevation: number | null;
  /** Lowest linear cell index among this depression's members. */
  readonly seedCell: number;
}

/** The catalogue for one run. */
export interface DepressionInventoryResult {
  /** D8 sinks on the RAW (unconditioned) surface, regardless of run mode. */
  readonly sinkCount: number;
  /** Cells Priority-Flood raised. Zero in raw mode. */
  readonly filledCellCount: number;
  /** Every depression, largest first. Raw-mode sinks in raw mode. */
  readonly depressions: readonly DepressionEntry[];
  readonly largestCells: number;
  readonly largestAreaM2: number | null;
  readonly largestMaxFillDepth: number | null;
  readonly largestOutletElevation: number | null;
}

const EMPTY: readonly DepressionEntry[] = Object.freeze([]);

/**
 * Catalogue the depressions in `rawGrid`.
 *
 * `conditioned` and `filled` are null together in raw mode (the caller did
 * not run Priority-Flood) and present together in conditioned mode (`filled`
 * is `filledCells(rawGrid, conditioned)`, computed once by the caller rather
 * than recomputed here). `areaResolved` gates every square-metre figure, the
 * same declaration {@link mayReportMetricArea} makes for the rest of a run.
 */
export function depressionInventory(
  rawGrid: FlowGrid,
  conditioned: PriorityFloodResult | null,
  filled: Uint8Array | null,
  areaResolved: boolean,
): DepressionInventoryResult {
  const { cols, rows, valid, z } = rawGrid;
  const n = cols * rows;
  const cellAreaM2 = rawGrid.cellMetresX * rawGrid.cellMetresY;

  const routed = d8Flow(rawGrid);
  const sinkCount = routed.sinkCount;

  if (!conditioned || !filled) {
    const seeds: number[] = [];
    for (let i = 0; i < n; i++) {
      if (routed.status[i] === CELL_SINK) seeds.push(i);
    }
    const depressions: DepressionEntry[] = seeds.map((seedCell, idx) => ({
      rank: idx + 1,
      cells: 1,
      areaM2: areaResolved ? cellAreaM2 : null,
      maxFillDepth: null,
      outletElevation: null,
      seedCell,
    }));
    return {
      sinkCount,
      filledCellCount: 0,
      depressions: depressions.length > 0 ? depressions : EMPTY,
      largestCells: 0,
      largestAreaM2: null,
      largestMaxFillDepth: null,
      largestOutletElevation: null,
    };
  }

  // Group the raised cells into 8-connected components — the same adjacency
  // D8 routes over, so two cells that could drain into one another are never
  // split into separate depressions on a technicality of connectivity.
  const label = new Int32Array(n).fill(-1);
  const components: number[][] = [];
  for (let start = 0; start < n; start++) {
    if (filled[start] !== 1 || label[start] !== -1) continue;
    const id = components.length;
    const members: number[] = [];
    const stack = [start];
    label[start] = id;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      members.push(c);
      const col = c % cols;
      const row = (c - col) / cols;
      for (const [dx, dy] of D8_NEIGHBOURS) {
        const nc = col + dx;
        const nr = row + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        if (filled[nb] === 1 && label[nb] === -1) {
          label[nb] = id;
          stack.push(nb);
        }
      }
    }
    components.push(members);
  }

  interface Raw { cells: number; maxFillDepth: number; outletElevation: number | null; seedCell: number }
  let filledCellCount = 0;
  const raw: Raw[] = [];
  for (const members of components) {
    filledCellCount += members.length;
    let maxFillDepth = 0;
    let outletElevation: number | null = null;
    let seedCell = members[0];
    for (const c of members) {
      if (c < seedCell) seedCell = c;
      const depth = conditioned.z[c] - z[c];
      if (depth > maxFillDepth) maxFillDepth = depth;

      const col = c % cols;
      const row = (c - col) / cols;
      for (const [dx, dy] of D8_NEIGHBOURS) {
        const nc = col + dx;
        const nr = row + dy;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const nb = nr * cols + nc;
        // A neighbour outside this depression, with an elevation: either
        // NoData (excluded) or another depression entirely (excluded, since
        // its own rim is measured from ITS neighbours, not this one's).
        if (valid[nb] !== 1 || filled[nb] === 1) continue;
        const rim = z[nb];
        if (outletElevation === null || rim < outletElevation) outletElevation = rim;
      }
    }
    raw.push({ cells: members.length, maxFillDepth, outletElevation, seedCell });
  }

  raw.sort((a, b) => (b.cells - a.cells) || (a.seedCell - b.seedCell));
  const depressions: DepressionEntry[] = raw.map((d, idx) => ({
    rank: idx + 1,
    cells: d.cells,
    areaM2: areaResolved ? d.cells * cellAreaM2 : null,
    maxFillDepth: d.maxFillDepth,
    outletElevation: d.outletElevation,
    seedCell: d.seedCell,
  }));

  const largest = depressions.length > 0 ? depressions[0] : null;
  return {
    sinkCount,
    filledCellCount,
    depressions: depressions.length > 0 ? depressions : EMPTY,
    largestCells: largest?.cells ?? 0,
    largestAreaM2: largest?.areaM2 ?? null,
    largestMaxFillDepth: largest?.maxFillDepth ?? null,
    largestOutletElevation: largest?.outletElevation ?? null,
  };
}
