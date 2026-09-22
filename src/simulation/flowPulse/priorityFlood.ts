/**
 * priorityFlood.ts — conditioning a surface so every cell has somewhere to go.
 *
 * Priority-Flood (Barnes, Lehman & Mulla 2014) floods inward from the edge of
 * the mapped surface, always advancing from the lowest cell reached so far.
 * A cell the flood reaches from below is raised to the level it was reached
 * at, which is the elevation water would have to reach to spill out of the
 * depression holding it. One pass, O(n log n), no iteration to convergence.
 *
 * ── THIS PRODUCES A SECOND SURFACE ──────────────────────────────────────────
 * The input is never modified. A conditioned surface is a drainage aid, not a
 * correction: a quarry sump, a kettle hole and a borrow pit are real terrain,
 * and a workflow that filled them silently would report drainage through
 * ground that does not drain. Raw routing remains the honest inspection mode
 * and this is the declared alternative, which is why the result carries what
 * it changed rather than only the new heights.
 *
 * ── THE EPSILON, AND WHY IT IS COUNTED ──────────────────────────────────────
 * Filling to exactly the spill level leaves a plateau, and a plateau has no
 * descent, so D8 would report flats across every filled depression. The
 * standard remedy raises each filled cell a hair above its spill parent, which
 * gives a deterministic path out.
 *
 * That remedy has a failure mode worth naming. Elevations are held as Float32,
 * and at a magnitude of a few hundred thousand metres the gap between
 * neighbouring Float32 values exceeds a millimetre-scale epsilon, so the
 * increment is absorbed and the cell does not rise at all. The flat then
 * survives, and a caller reading only "cellsRaised" would believe the surface
 * was resolved. The arithmetic here runs in double and every absorbed
 * increment is counted, so the result can say plainly that part of the
 * surface could not be resolved at this epsilon.
 *
 * ── NODATA IS A WALL, AS ROUTING READS IT ───────────────────────────────────
 * D8 routes nothing into an invalid cell, so the flood seeds only at the grid
 * boundary. Seeding the rim of every gap as well would call a survey hole a
 * drainage exit: a depression beside the hole would stay unfilled because it
 * "spills" into it, and D8, which does not route into the hole, would then
 * find a sink on the rim that conditioning reported as resolved. A region
 * NoData encloses has no route to the boundary at all; it keeps its heights
 * and is counted, so the result says how much of the surface conditioning did
 * not reach rather than leaving a reader to take every sink in it for a pit.
 *
 * Reading a gap as an exit is right when the gap is open water, which a
 * LiDAR survey often leaves empty. That reading is an option the caller
 * names, never the default.
 */

import { CELL_NODATA } from './flowTypes';
import { assertFlowGrid, D8_NEIGHBOURS, type FlowGrid } from './flowTypes';

/** A conditioned surface, and what conditioning it cost. */
export interface PriorityFloodResult {
  /** The conditioned elevations. The input grid is untouched. */
  readonly z: Float32Array;
  /** Cells whose elevation rose. */
  readonly cellsRaised: number;
  /** The largest rise applied to any one cell, in the grid's vertical unit. */
  readonly maxFillDepth: number;
  /**
   * Sum of the rises, in cell·metres of the vertical unit. A volume proxy
   * only: multiplying by cell area gives a filled volume under the
   * assumption that each cell's rise is uniform across it.
   */
  readonly fillDepthSum: number;
  /**
   * Cells whose epsilon increment was absorbed by Float32 precision and which
   * therefore did not rise above their spill parent. Non-zero means part of
   * the surface is still flat after conditioning.
   */
  readonly epsilonAbsorbed: number;
  /**
   * Valid cells the flood never reached, because NoData encloses them and
   * leaves no route to the grid boundary. They keep their elevations, so a
   * pit among them is still a pit. Always zero when gaps are read as exits.
   */
  readonly cellsUnreachable: number;
}

/**
 * How conditioning reads a cell with no elevation.
 *
 * `wall`: flow neither enters nor leaves it, which is how D8 reads it.
 * `outlet`: a valid cell touching it is a place water leaves the surface, as
 * at the grid boundary. Appropriate where gaps are water bodies.
 */
export type NoDataReading = 'wall' | 'outlet';

/** Options for a conditioning pass. */
export interface PriorityFloodOptions {
  /**
   * How far above its spill parent a filled cell is placed. Zero fills to the
   * exact spill level and leaves plateaux, which is a legitimate choice when
   * the caller wants fill depths rather than a drainable surface.
   */
  readonly epsilon?: number;
  /** How a NoData cell is read. Defaults to `wall`. */
  readonly noData?: NoDataReading;
}

/**
 * A binary heap ordered by elevation, then by insertion order.
 *
 * The second key is what makes the result reproducible. Two cells reached at
 * the same elevation are ordered by when they entered rather than by where
 * the sift happened to leave them, so the conditioned surface does not depend
 * on heap internals.
 */
class CellHeap {
  private readonly _cell: Int32Array;
  private readonly _key: Float64Array;
  private readonly _seq: Int32Array;
  private _size = 0;
  private _counter = 0;

  constructor(capacity: number) {
    this._cell = new Int32Array(capacity);
    this._key = new Float64Array(capacity);
    this._seq = new Int32Array(capacity);
  }

  get size(): number { return this._size; }

  push(cell: number, key: number): void {
    let i = this._size++;
    this._cell[i] = cell;
    this._key[i] = key;
    this._seq[i] = this._counter++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this._less(i, parent)) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  /** Remove and return the lowest cell. The caller checks `size` first. */
  pop(): number {
    const top = this._cell[0];
    const last = --this._size;
    this._cell[0] = this._cell[last];
    this._key[0] = this._key[last];
    this._seq[0] = this._seq[last];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let small = i;
      if (l < this._size && this._less(l, small)) small = l;
      if (r < this._size && this._less(r, small)) small = r;
      if (small === i) break;
      this._swap(i, small);
      i = small;
    }
    return top;
  }

  private _less(a: number, b: number): boolean {
    if (this._key[a] !== this._key[b]) return this._key[a] < this._key[b];
    return this._seq[a] < this._seq[b];
  }

  private _swap(a: number, b: number): void {
    const c = this._cell[a]; this._cell[a] = this._cell[b]; this._cell[b] = c;
    const k = this._key[a]; this._key[a] = this._key[b]; this._key[b] = k;
    const s = this._seq[a]; this._seq[a] = this._seq[b]; this._seq[b] = s;
  }
}

/**
 * Condition `grid` so that every valid cell drains to the grid boundary.
 *
 * Seeds are the valid cells on the grid boundary, and with `noData: 'outlet'`
 * also the valid cells touching a NoData cell. A region with no seed cannot be
 * conditioned, because there is nowhere for it to drain to; its cells keep
 * their elevations and are counted in `cellsUnreachable`.
 */
export function priorityFlood(
  grid: FlowGrid,
  options: PriorityFloodOptions = {},
): PriorityFloodResult {
  assertFlowGrid(grid);
  const epsilon = options.epsilon ?? 0;
  if (!(Number.isFinite(epsilon) && epsilon >= 0)) {
    throw new RangeError(`priorityFlood: epsilon must be a finite non-negative rise; got ${epsilon}`);
  }
  const noData = options.noData ?? 'wall';
  if (noData !== 'wall' && noData !== 'outlet') {
    throw new RangeError(`priorityFlood: noData must be 'wall' or 'outlet'; got ${String(noData)}`);
  }
  const gapsAreExits = noData === 'outlet';

  const { z: source, valid, cols, rows } = grid;
  const n = cols * rows;
  const z = new Float32Array(source); // the conditioned copy; source is untouched
  const closed = new Uint8Array(n);
  const heap = new CellHeap(n);

  const isEdgeSeed = (col: number, row: number): boolean => {
    if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) return true;
    if (!gapsAreExits) return false;
    // An interior cell: every neighbour is on the grid, so only a gap makes
    // it an exit.
    for (const [dx, dy] of D8_NEIGHBOURS) {
      if (valid[(row + dy) * cols + col + dx] !== 1) return true;
    }
    return false;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (valid[i] !== 1 || !isEdgeSeed(col, row)) continue;
      closed[i] = 1;
      heap.push(i, z[i]);
    }
  }

  let cellsRaised = 0;
  let maxFillDepth = 0;
  let fillDepthSum = 0;
  let epsilonAbsorbed = 0;

  while (heap.size > 0) {
    const c = heap.pop();
    const zc = z[c];
    const col = c % cols;
    const row = (c - col) / cols;

    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nb = nr * cols + nc;
      if (valid[nb] !== 1 || closed[nb] === 1) continue;

      closed[nb] = 1;
      const original = z[nb];
      // Reached from below: raise to just above the level it was reached at.
      if (original <= zc) {
        const target = zc + epsilon;
        z[nb] = target;
        const rise = z[nb] - original;
        if (rise > 0) {
          cellsRaised++;
          fillDepthSum += rise;
          if (rise > maxFillDepth) maxFillDepth = rise;
        }
        // The epsilon vanished into Float32: the cell is level with its
        // parent and the flat it was meant to break survives.
        if (epsilon > 0 && z[nb] <= zc) epsilonAbsorbed++;
      }
      heap.push(nb, z[nb]);
    }
  }

  let cellsUnreachable = 0;
  for (let i = 0; i < n; i++) {
    if (valid[i] === 1 && closed[i] !== 1) cellsUnreachable++;
  }

  return { z, cellsRaised, maxFillDepth, fillDepthSum, epsilonAbsorbed, cellsUnreachable };
}

/**
 * Cells the conditioning raised, as a mask.
 *
 * Kept separate from the flood so a caller that only wants the surface does
 * not pay for an array it will not read, and so the comparison is made
 * against the original rather than remembered during the pass.
 */
export function filledCells(grid: FlowGrid, conditioned: PriorityFloodResult): Uint8Array {
  const mask = new Uint8Array(grid.z.length);
  for (let i = 0; i < mask.length; i++) {
    if (grid.valid[i] === 1 && conditioned.z[i] > grid.z[i]) mask[i] = 1;
  }
  return mask;
}

export { CELL_NODATA };
