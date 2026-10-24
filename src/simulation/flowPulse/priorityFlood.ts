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
 * ── THE EPSILON, AND WHY THE SURFACE IS FLOAT64 ─────────────────────────────
 * Filling to exactly the spill level leaves a plateau, and a plateau has no
 * descent, so D8 would report flats across every filled depression. The
 * standard remedy raises each filled cell a hair above the cell it was
 * reached from, which gives a deterministic path out. Barnes, Lehman and
 * Mulla take the smallest representable step for it (nextafter), and
 * `'float64-step'` is that step.
 *
 * The rises chain. A cell k cells into a filled flat sits k steps above its
 * spill level, so the far end of a long flat is the highest part of it. If
 * that climb passes the height of a competing exit that is only slightly
 * higher than the true spill point, D8 drains the far end over the wrong
 * exit. On a Float32 surface one step is 6.1e-5 m at 600 m and 2.4e-4 m at
 * 3000 m, so a few hundred cells climb centimetres and that happens on real
 * lakes. The conditioned copy is therefore Float64. A Float64 step is 2^-29
 * of a Float32 step at the same height, so a chain shorter than 2^29 cells
 * stays below the next Float32 value above its spill level. A chain never
 * holds more cells than the grid, every DTM the runner reads is Float32, and
 * the runner refuses a grid above its cell budget (4,000,000 by default), so
 * no input height above a spill level can be overtaken and the flood's
 * lowest-spill answer survives routing.
 *
 * The flood itself is ordered by the spill level without the epsilon, and
 * cells at one level leave the queue in the order they joined it, first in,
 * first out, as the plain "pit" queue of Barnes, Lehman and Mulla's
 * Priority-Flood+ε drains. Which exit a depression reaches therefore never
 * depends on how far an epsilon chain has climbed, whatever rise was asked
 * for.
 *
 * A fixed rise in the vertical unit is still accepted. It chains the same
 * way, and on a long flat it can climb past a nearby higher exit, which the
 * step cannot. The arithmetic runs in Float64, and a rise too small to change
 * the value it is added to (a fixed rise below the Float64 spacing at that
 * height) is counted in `epsilonAbsorbed`, so a result whose surface is still
 * flat in places says so rather than leaving a reader to assume it drains.
 *
 * ── NODATA IS A WALL, AS ROUTING READS IT ───────────────────────────────────
 * D8 routes nothing into an invalid cell, so the flood seeds only at the edge
 * of the mapped surface: the grid boundary and the rim of NoData that reaches
 * it, which lies outside the survey (see {@link outsideSurface}). Seeding the
 * rim of every enclosed gap as well would call a survey hole a
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
import { assertFlowGrid, D8_NEIGHBOURS, outsideSurface, type FlowGrid } from './flowTypes';

/**
 * How far above the cell it was reached from a filled cell is placed: one
 * Float64 step, or a fixed rise in the vertical unit. See
 * {@link PriorityFloodOptions.epsilon}.
 */
export type FillEpsilon = number | 'float64-step';

/** A conditioned surface, and what conditioning it cost. */
export interface PriorityFloodResult {
  /**
   * The conditioned elevations, in Float64 so the rises that give a filled
   * flat its descent stay far below the spacing of the Float32 input. The
   * input grid is untouched.
   */
  readonly z: Float64Array;
  /**
   * Cells that lie in a depression: their original elevation is strictly
   * below the spill level they were reached at. A cell on a flat, level with
   * its spill parent, is lifted by the epsilon gradient only and is not
   * counted here; see `flatCellsResolved`.
   */
  readonly cellsRaised: number;
  /**
   * The deepest depression fill: spill level minus original elevation, in the
   * grid's vertical unit. The epsilon gradient applied on top is excluded.
   */
  readonly maxFillDepth: number;
  /**
   * Cells that were level with (not below) their spill level and rose only
   * by the epsilon gradient that gives a flat a direction to drain.
   */
  readonly flatCellsResolved: number;
  /**
   * 1 where a cell lies in a depression (original height strictly below the
   * spill level it was reached from), 0 elsewhere. Flats are 0.
   */
  readonly depressionMask: Uint8Array;
  /**
   * Per cell, the spill level the flood reached it at, without the epsilon
   * gradient: the original height outside depressions, the level water would
   * have to reach to spill out inside one. Invalid or unreachable cells hold
   * their input value.
   */
  readonly spillLevel: Float64Array;
  /**
   * Sum of the depression fill depths (spill level minus original, epsilon
   * excluded), in cell·metres of the vertical unit. A volume proxy
   * only: multiplying by cell area gives a filled volume under the
   * assumption that each cell's rise is uniform across it.
   */
  readonly fillDepthSum: number;
  /**
   * Cells whose rise could not be represented: the raised value equals the
   * one it was added to, so the cell did not rise above the cell it was
   * reached from. A fixed rise below the Float64 spacing at that height does
   * this; the step does not at any finite height. Non-zero means part of the
   * surface is still flat after conditioning.
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
   * How far above the cell it was reached from a filled cell is placed.
   * `'float64-step'` places it on the next Float64 value above, the smallest
   * rise the conditioned surface can hold (Barnes, Lehman & Mulla 2014 take
   * it with nextafter). The rises add up along a flat, one per cell, so the
   * far end of a long flat sits highest; with the Float64 step that climb
   * stays below the next Float32 value above the spill level for any chain
   * shorter than 2^29 cells, so over a Float32 DTM it cannot lift a flat
   * above ground it should spill over. A number is a fixed rise in the
   * vertical unit; it adds up the same way, and on a long flat it can climb
   * past a nearby exit that is only slightly higher than the true one. Zero
   * fills to the exact spill level and leaves plateaux, which is a
   * legitimate choice when the caller wants fill depths rather than a
   * drainable surface, and is the default here.
   */
  readonly epsilon?: FillEpsilon;
  /** How a NoData cell is read. Defaults to `wall`. */
  readonly noData?: NoDataReading;
}

/**
 * A binary heap ordered by spill level, then by insertion order.
 *
 * The key is the level a cell was reached at without the epsilon, so the
 * order the flood advances in never depends on how far an epsilon chain has
 * climbed. The second key makes the cells at one level leave in the order
 * they joined, first in, first out within the level, as Barnes, Lehman and
 * Mulla's pit queue does. It is also what makes the result reproducible: two
 * cells at the same level are ordered by when they entered rather than by
 * where the sift left them.
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
 * Seeds are the valid cells on the grid boundary or touching NoData outside
 * the surface, and with `noData: 'outlet'` also the valid cells touching any
 * NoData cell. A region with no seed cannot be
 * conditioned, because there is nowhere for it to drain to; its cells keep
 * their elevations and are counted in `cellsUnreachable`.
 */
export function priorityFlood(
  grid: FlowGrid,
  options: PriorityFloodOptions = {},
): PriorityFloodResult {
  assertFlowGrid(grid);
  const epsilon = options.epsilon ?? 0;
  const step = epsilon === 'float64-step';
  if (!step && !(typeof epsilon === 'number' && Number.isFinite(epsilon) && epsilon >= 0)) {
    // A record written before the surface became Float64 names the old step.
    const renamed = String(epsilon) === 'float32-step' ? ' (\'float32-step\' was replaced by \'float64-step\')' : '';
    throw new RangeError(
      `priorityFlood: epsilon must be 'float64-step' or a finite non-negative rise; got ${String(epsilon)}${renamed}`,
    );
  }
  const rise = (zc: number): number => (step ? nextFloat64Up(zc) : zc + (epsilon as number));
  const rises = step || (epsilon as number) > 0;
  const noData = options.noData ?? 'wall';
  if (noData !== 'wall' && noData !== 'outlet') {
    throw new RangeError(`priorityFlood: noData must be 'wall' or 'outlet'; got ${String(noData)}`);
  }
  const gapsAreExits = noData === 'outlet';

  const { z: source, valid, cols, rows } = grid;
  const n = cols * rows;
  const z = new Float64Array(source); // the conditioned copy; source is untouched
  const closed = new Uint8Array(n);
  const heap = new CellHeap(n);

  // The spill level each cell was reached at, without the epsilon gradient,
  // per Barnes, Lehman & Mulla (2014): a cell is in a depression only when
  // its ORIGINAL height is strictly below this level. It is also the key the
  // flood is ordered by.
  const spill = new Float64Array(source);

  const outside = outsideSurface(grid);
  const isEdgeSeed = (col: number, row: number): boolean => {
    if (col === 0 || row === 0 || col === cols - 1 || row === rows - 1) return true;
    // An interior cell: every neighbour is on the grid, so only a gap makes
    // it an exit: one outside the surface always, an enclosed one when asked.
    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nb = (row + dy) * cols + col + dx;
      if (valid[nb] !== 1 && (gapsAreExits || outside[nb] === 1)) return true;
    }
    return false;
  };

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (valid[i] !== 1 || !isEdgeSeed(col, row)) continue;
      closed[i] = 1;
      heap.push(i, spill[i]);
    }
  }

  const depressionMask = new Uint8Array(n);
  let flatCellsResolved = 0;
  let cellsRaised = 0;
  let maxFillDepth = 0;
  let fillDepthSum = 0;
  let epsilonAbsorbed = 0;

  while (heap.size > 0) {
    const c = heap.pop();
    const zc = z[c];
    const level = spill[c];
    const col = c % cols;
    const row = (c - col) / cols;

    for (const [dx, dy] of D8_NEIGHBOURS) {
      const nc = col + dx;
      const nr = row + dy;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nb = nr * cols + nc;
      if (valid[nb] !== 1 || closed[nb] === 1) continue;

      closed[nb] = 1;
      const original = source[nb];
      if (original < level) {
        // In a depression: the fill depth is the spill level minus the
        // original height, not inflated by the epsilon chain.
        depressionMask[nb] = 1;
        spill[nb] = level;
        const depth = level - original;
        cellsRaised++;
        fillDepthSum += depth;
        if (depth > maxFillDepth) maxFillDepth = depth;
      }
      // Not above the cell it was reached from: raise it just above that
      // cell so D8 has a descent (flats included). Compared with the raised
      // height, not the spill level, so a cell a fixed rise has climbed past
      // still drains back down the way the flood came.
      if (original <= zc) {
        z[nb] = rise(zc);
        if (depressionMask[nb] !== 1 && z[nb] > original) flatCellsResolved++;
        // The rise vanished into the spacing of Float64 at this height: the
        // cell is level with its parent and the flat it was meant to break
        // survives.
        if (rises && z[nb] <= zc) epsilonAbsorbed++;
      }
      heap.push(nb, spill[nb]);
    }
  }

  let cellsUnreachable = 0;
  for (let i = 0; i < n; i++) {
    if (valid[i] === 1 && closed[i] !== 1) cellsUnreachable++;
  }

  return {
    z, cellsRaised, maxFillDepth, fillDepthSum, epsilonAbsorbed, cellsUnreachable,
    flatCellsResolved, depressionMask, spillLevel: spill,
  };
}

const F64 = new DataView(new ArrayBuffer(8));

/**
 * The next Float64 value above `x`. Moving the bit pattern by one is the
 * step: up for a positive value, down (toward zero) for a negative one, from
 * either zero to the smallest positive subnormal, and from -Infinity to the
 * most negative finite value. NaN and +Infinity have nothing above them and
 * come back unchanged. The 64-bit pattern is handled as two 32-bit words,
 * carrying or borrowing between them, so no BigInt is involved.
 */
export function nextFloat64Up(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  F64.setFloat64(0, x); // big-endian: the high word first
  let hi = F64.getUint32(0);
  let lo = F64.getUint32(4);
  if (x > 0) {
    lo = (lo + 1) >>> 0;
    if (lo === 0) hi = (hi + 1) >>> 0;
  } else {
    if (lo === 0) hi = (hi - 1) >>> 0;
    lo = (lo - 1) >>> 0;
  }
  F64.setUint32(0, hi);
  F64.setUint32(4, lo);
  return F64.getFloat64(0);
}

/**
 * Cells in a depression, as a mask: original height strictly below the spill
 * level the flood reached them from. Cells lifted only by the epsilon
 * gradient across a flat are excluded, so a level plateau is not a
 * depression (Barnes, Lehman & Mulla 2014).
 */
export function filledCells(grid: FlowGrid, conditioned: PriorityFloodResult): Uint8Array {
  const mask = new Uint8Array(grid.z.length);
  for (let i = 0; i < mask.length; i++) {
    if (grid.valid[i] === 1 && conditioned.depressionMask[i] === 1) mask[i] = 1;
  }
  return mask;
}

export { CELL_NODATA };
