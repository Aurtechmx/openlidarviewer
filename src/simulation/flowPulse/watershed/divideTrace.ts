/**
 * divideTrace.ts — the divide of a catchment mask as closed rings in metres.
 *
 * A catchment mask is a set of grid cells. Its divide is the line round the
 * outside of those cells, and the NoData cells the mask encloses are holes in
 * it. This module follows the cell edges to get that line, then simplifies it.
 *
 * Tracing. Every cell side that faces a cell outside the mask becomes a
 * directed edge with the mask on its left, so the outer boundary runs
 * anticlockwise and an inner boundary runs clockwise. Edges are chained into
 * closed loops. Mask cells that touch only at a corner count as joined
 * (8-connected mask, 4-connected background): where two loops could be
 * followed at such a vertex, the trace takes the right-hand turn, so the loop
 * runs through the shared vertex instead of splitting there. A hole is traced
 * the other way round, as its own 4-connected group of cells, so its ring
 * follows the same edges as the mask's inner boundary.
 *
 * Coordinates. x grows east by `cellMetresX` per column and y grows north by
 * `cellMetresY` per row. The origin is the south-west corner of cell 0, and
 * row 0 is the southern row. A ring is a flat `Float64Array` of x, y pairs,
 * closed: its last pair repeats its first.
 *
 * Staircase length. The edge of a cell mask is axis-aligned, so a diagonal
 * boundary is traced as a staircase about √2 longer than the line it follows.
 * `rawPerimeterM` is that staircase length. The simplified ring is cut with
 * Douglas-Peucker at a tolerance of one cell by default, which removes the
 * staircase on a straight diagonal, and `perimeterM` is its length. The
 * simplified length is the one to quote as a perimeter; the raw length shows
 * how much the grid inflated it. Because the ring is anchored at its first
 * vertex and the vertex farthest from it, a corner that lies within one
 * tolerance of the chord between two anchors is cut, so the simplified length
 * can differ from the true outline by about one cell.
 *
 * Holes. A hole is a 4-connected group of NoData cells (`valid === 0`) that
 * lies inside the outer ring, so data (the mask, or another catchment's cells)
 * surrounds it. Valid cells that the mask leaves out, such as a neighbouring
 * catchment inside the ring, are not holes. NoData that reaches the outside of
 * the ring through a notch is not enclosed and is not a hole either.
 * `enclosedHoleCells` counts only NoData hole cells. A hole too small to keep
 * three distinct vertices after simplification is returned as its raw ring, so
 * it still draws as an area.
 *
 * Several pieces. A mask from D8 routing is one connected catchment. If the
 * mask has several 8-connected pieces, only the largest is traced as `outer`
 * (the first found wins a tie) and the other pieces are ignored. This is a
 * guard, not a feature.
 *
 * Pure: no DOM. Reads the grid and the mask; changes neither.
 */

import type { FlowGrid } from '../flowTypes';

/** x0,y0,x1,y1,... in grid metres. Closed: the first pair equals the last. */
export type Ring = Float64Array;

export interface TracedDivide {
  /** Simplified, anticlockwise. Empty when the mask has no cells. */
  readonly outer: Ring;
  /** Simplified, clockwise: data-enclosed NoData inside the outer ring. */
  readonly holes: readonly Ring[];
  /** Staircase length of the outer ring, in metres. */
  readonly rawPerimeterM: number;
  /** Length of the simplified outer ring, in metres. */
  readonly perimeterM: number;
  /** NoData cells inside the holes. */
  readonly enclosedHoleCells: number;
  /** The simplified outer ring has fewer than 3 distinct vertices. */
  readonly degenerate: boolean;
}

// ---------------------------------------------------------------------------
// Douglas-Peucker
// ---------------------------------------------------------------------------

/** Distance from point (px, py) to the segment (ax, ay)-(bx, by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Marks in `keep` the vertices of the chain a..b that Douglas-Peucker retains. */
function simplifyChain(xy: Float64Array, a: number, b: number, tol: number, keep: Uint8Array): void {
  const stack: number[] = [a, b];
  while (stack.length > 0) {
    const hi = stack.pop() as number;
    const lo = stack.pop() as number;
    if (hi - lo < 2) continue;
    let far = -1;
    let farDist = tol;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(xy[2 * i], xy[2 * i + 1], xy[2 * lo], xy[2 * lo + 1], xy[2 * hi], xy[2 * hi + 1]);
      if (d > farDist) { farDist = d; far = i; }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push(lo, far, far, hi);
  }
}

/**
 * Douglas-Peucker simplification. A vertex is dropped when it lies within
 * `toleranceM` of the chord that replaces it.
 *
 * An open polyline keeps its two end vertices. A closed ring (first pair equals
 * last, at least three distinct vertices) has no natural ends, so it keeps its
 * first vertex and the vertex farthest from it as fixed anchors and simplifies
 * the two halves between them. The result is closed and begins at the same
 * vertex as the input.
 */
export function douglasPeucker(ring: Ring, toleranceM: number): Ring {
  const n = ring.length / 2;
  if (n < 3) return ring.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const closed = ring[0] === ring[2 * (n - 1)] && ring[1] === ring[2 * (n - 1) + 1];
  if (closed) {
    if (n < 4) return ring.slice();
    let anchor = -1;
    let anchorDist = 0;
    for (let i = 1; i < n - 1; i++) {
      const d = Math.hypot(ring[2 * i] - ring[0], ring[2 * i + 1] - ring[1]);
      if (d > anchorDist) { anchorDist = d; anchor = i; }
    }
    if (anchor < 0) return ring.slice();
    keep[anchor] = 1;
    simplifyChain(ring, 0, anchor, toleranceM, keep);
    simplifyChain(ring, anchor, n - 1, toleranceM, keep);
  } else {
    simplifyChain(ring, 0, n - 1, toleranceM, keep);
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += keep[i];
  const out = new Float64Array(count * 2);
  let w = 0;
  for (let i = 0; i < n; i++) {
    if (keep[i] === 0) continue;
    out[w++] = ring[2 * i];
    out[w++] = ring[2 * i + 1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Boundary tracing on a padded local grid
// ---------------------------------------------------------------------------

/** East, north, west, south, as steps in vertex space. */
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;

interface Loop {
  /** Corner vertices only, in local vertex coordinates, not repeated at the end. */
  readonly xy: Int32Array;
  /** Twice the signed area in cell units: positive for an anticlockwise loop. */
  readonly area2: number;
}

/**
 * Every boundary loop of the cells set in `member`, a `w × h` array whose outer
 * ring of cells is empty. Vertex (x, y) is the south-west corner of cell (x, y).
 * Loops come out in the order of their first edge, scanning row by row from the
 * south, so the result does not depend on iteration order elsewhere.
 *
 * `eight` sets how cells that touch at a corner join. True joins them (the
 * trace turns right at such a vertex, so one loop runs through it); false does
 * not (it turns left, so each side gets its own loop). The mask uses true and a
 * NoData hole, which is 4-connected, uses false.
 */
function traceLoops(member: Uint8Array, w: number, h: number, eight: boolean): Loop[] {
  const turns = eight ? [3, 0, 1] : [1, 0, 3];
  const vw = w + 1;
  const out = new Uint8Array(vw * (h + 1));
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      if (member[y * w + x] === 0) continue;
      if (member[(y - 1) * w + x] === 0) out[y * vw + x] |= 1; // south side, runs east
      if (member[y * w + x + 1] === 0) out[y * vw + x + 1] |= 2; // east side, runs north
      if (member[(y + 1) * w + x] === 0) out[(y + 1) * vw + x + 1] |= 4; // north side, runs west
      if (member[y * w + x - 1] === 0) out[(y + 1) * vw + x] |= 8; // west side, runs south
    }
  }

  const loops: Loop[] = [];
  for (let v0 = 0; v0 < out.length; v0++) {
    while (out[v0] !== 0) {
      const d0 = 31 - Math.clz32(out[v0] & -out[v0]);
      out[v0] &= ~(1 << d0);
      const px: number[] = [];
      const py: number[] = [];
      const dirs: number[] = [];
      let v = v0;
      let d = d0;
      for (;;) {
        px.push(v % vw);
        py.push((v - (v % vw)) / vw);
        dirs.push(d);
        v += DX[d] + DY[d] * vw;
        // At a vertex with two ways on, prefer the turn that keeps the cells joined or apart.
        const open = out[v] | (v === v0 ? 1 << d0 : 0);
        let next = -1;
        for (const turn of turns) {
          const cand = (d + turn) & 3;
          if (open & (1 << cand)) { next = cand; break; }
        }
        if (v === v0 && next === d0) break;
        out[v] &= ~(1 << next);
        d = next;
      }
      // Keep only the vertices where the direction changes.
      const m = dirs.length;
      const cx: number[] = [];
      const cy: number[] = [];
      for (let i = 0; i < m; i++) {
        if (dirs[i] === dirs[(i + m - 1) % m]) continue;
        cx.push(px[i]);
        cy.push(py[i]);
      }
      let area2 = 0;
      for (let i = 0; i < cx.length; i++) {
        const j = (i + 1) % cx.length;
        area2 += cx[i] * cy[j] - cx[j] * cy[i];
      }
      const xy = new Int32Array(cx.length * 2);
      for (let i = 0; i < cx.length; i++) { xy[2 * i] = cx[i]; xy[2 * i + 1] = cy[i]; }
      loops.push({ xy, area2 });
    }
  }
  return loops;
}

/** The anticlockwise loop that encloses the most area: a piece's outer boundary. */
function outerLoop(loops: readonly Loop[]): Loop | null {
  let best: Loop | null = null;
  for (const loop of loops) if (loop.area2 > 0 && (best === null || loop.area2 > best.area2)) best = loop;
  return best;
}

/** A closed metre ring from a loop, shifted by (ox, oy) vertices, optionally reversed. */
function ringFromLoop(
  loop: Loop, ox: number, oy: number, cellMetresX: number, cellMetresY: number, reverse: boolean,
): Ring {
  const m = loop.xy.length / 2;
  const ring = new Float64Array((m + 1) * 2);
  for (let k = 0; k < m; k++) {
    const i = reverse ? (m - k) % m : k;
    ring[2 * k] = (loop.xy[2 * i] + ox) * cellMetresX;
    ring[2 * k + 1] = (loop.xy[2 * i + 1] + oy) * cellMetresY;
  }
  ring[2 * m] = ring[0];
  ring[2 * m + 1] = ring[1];
  return ring;
}

function ringLength(ring: Ring): number {
  let len = 0;
  for (let i = 2; i < ring.length; i += 2) len += Math.hypot(ring[i] - ring[i - 2], ring[i + 1] - ring[i - 1]);
  return len;
}

/** Number of distinct vertices in a closed ring. */
function distinctVertices(ring: Ring): number {
  const seen = new Set<string>();
  for (let i = 0; i < ring.length - 2; i += 2) seen.add(`${ring[i]},${ring[i + 1]}`);
  return seen.size;
}

// ---------------------------------------------------------------------------
// Pieces and holes
// ---------------------------------------------------------------------------

/** Cell indices of the largest 8-connected piece of the mask, or null when the mask is empty. */
function largestPiece(mask: Uint8Array, cols: number, rows: number): Int32Array | null {
  const seen = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  let best: Int32Array | null = null;
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    const cells: number[] = [];
    let top = 0;
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      cells.push(i);
      const c = i % cols;
      const r = (i - c) / cols;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols || (dc === 0 && dr === 0)) continue;
          const j = rr * cols + cc;
          if (mask[j] === 0 || seen[j] === 1) continue;
          seen[j] = 1;
          stack[top++] = j;
        }
      }
    }
    if (best === null || cells.length > best.length) best = Int32Array.from(cells);
  }
  return best;
}

/** A set of cells copied into a local array with one empty cell of padding on every side. */
interface Crop {
  readonly member: Uint8Array;
  readonly w: number;
  readonly h: number;
  /** Column and row of the grid cell that sits at local (1, 1). */
  readonly col0: number;
  readonly row0: number;
}

function cropOf(cells: ArrayLike<number>, cols: number): Crop {
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k] % cols;
    const r = (cells[k] - c) / cols;
    if (c < c0) c0 = c;
    if (c > c1) c1 = c;
    if (r < r0) r0 = r;
    if (r > r1) r1 = r;
  }
  const w = c1 - c0 + 3;
  const h = r1 - r0 + 3;
  const member = new Uint8Array(w * h);
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k] % cols;
    const r = (cells[k] - c) / cols;
    member[(r - r0 + 1) * w + (c - c0 + 1)] = 1;
  }
  return { member, w, h, col0: c0, row0: r0 };
}

/** Local cells of the crop that the outside cannot reach without crossing the piece (4-connected). */
function enclosedCells(crop: Crop): Uint8Array {
  const { member, w, h } = crop;
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  stack[top++] = 0;
  outside[0] = 1;
  while (top > 0) {
    const i = stack[--top];
    const x = i % w;
    const y = (i - x) / w;
    const next = [
      x > 0 ? i - 1 : -1,
      x < w - 1 ? i + 1 : -1,
      y > 0 ? i - w : -1,
      y < h - 1 ? i + w : -1,
    ];
    for (const j of next) {
      if (j < 0 || member[j] === 1 || outside[j] === 1) continue;
      outside[j] = 1;
      stack[top++] = j;
    }
  }
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < inside.length; i++) inside[i] = member[i] === 0 && outside[i] === 0 ? 1 : 0;
  return inside;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const EMPTY_DIVIDE: TracedDivide = {
  outer: new Float64Array(0),
  holes: [],
  rawPerimeterM: 0,
  perimeterM: 0,
  enclosedHoleCells: 0,
  degenerate: true,
};

/**
 * Trace the divide of `mask` on `grid`: the simplified outer ring, the NoData
 * holes it encloses, and the staircase and simplified perimeters.
 *
 * `toleranceM` is the Douglas-Peucker tolerance; the default is one cell,
 * `min(cellMetresX, cellMetresY)`.
 */
export function traceDivide(grid: FlowGrid, mask: Uint8Array, toleranceM?: number): TracedDivide {
  const { cols, rows, cellMetresX, cellMetresY, valid } = grid;
  if (mask.length !== cols * rows) {
    throw new RangeError(`traceDivide: mask (${mask.length}) must be cols×rows (${cols * rows})`);
  }
  const tol = toleranceM ?? Math.min(cellMetresX, cellMetresY);

  const piece = largestPiece(mask, cols, rows);
  if (piece === null) return EMPTY_DIVIDE;

  const crop = cropOf(piece, cols);
  const outerTrace = outerLoop(traceLoops(crop.member, crop.w, crop.h, true));
  if (outerTrace === null) return EMPTY_DIVIDE;
  // Local vertex (x, y) sits at grid vertex (x + col0 - 1, y + row0 - 1).
  const ox = crop.col0 - 1;
  const oy = crop.row0 - 1;
  const rawOuter = ringFromLoop(outerTrace, ox, oy, cellMetresX, cellMetresY, false);
  const outer = douglasPeucker(rawOuter, tol);

  // Holes: 4-connected NoData groups among the cells the outer ring encloses.
  const inside = enclosedCells(crop);
  const holeSeen = new Uint8Array(inside.length);
  const holes: Ring[] = [];
  let enclosedHoleCells = 0;
  const stack = new Int32Array(inside.length);
  for (let start = 0; start < inside.length; start++) {
    if (inside[start] === 0 || holeSeen[start] === 1) continue;
    const lx = start % crop.w;
    const ly = (start - lx) / crop.w;
    if (valid[(ly + oy) * cols + (lx + ox)] !== 0) continue;
    // Flood this NoData group.
    const cells: number[] = [];
    let top = 0;
    stack[top++] = start;
    holeSeen[start] = 1;
    while (top > 0) {
      const i = stack[--top];
      const x = i % crop.w;
      const y = (i - x) / crop.w;
      cells.push((y + oy) * cols + (x + ox));
      for (const j of [i - 1, i + 1, i - crop.w, i + crop.w]) {
        if (inside[j] === 0 || holeSeen[j] === 1) continue;
        const jx = j % crop.w;
        const jy = (j - jx) / crop.w;
        if (valid[(jy + oy) * cols + (jx + ox)] !== 0) continue;
        holeSeen[j] = 1;
        stack[top++] = j;
      }
    }
    enclosedHoleCells += cells.length;
    const holeCrop = cropOf(cells, cols);
    const holeLoop = outerLoop(traceLoops(holeCrop.member, holeCrop.w, holeCrop.h, false));
    if (holeLoop === null) continue;
    const rawHole = ringFromLoop(holeLoop, holeCrop.col0 - 1, holeCrop.row0 - 1, cellMetresX, cellMetresY, true);
    const simplified = douglasPeucker(rawHole, tol);
    holes.push(distinctVertices(simplified) >= 3 ? simplified : rawHole);
  }

  return {
    outer,
    holes,
    rawPerimeterM: ringLength(rawOuter),
    perimeterM: ringLength(outer),
    enclosedHoleCells,
    degenerate: distinctVertices(outer) < 3,
  };
}
