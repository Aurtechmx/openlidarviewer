/**
 * profileHitTest.ts
 *
 * Pointer hit-testing for the 2D profile cross-section view.
 *
 * A section can hold every return inside the corridor, and the pointer moves
 * far more often than the section changes. Scanning the displayed set on each
 * pointer move makes hover cost scale with the point count, so the projected
 * positions are bucketed once into a uniform screen grid and a query touches
 * only the cells its pixel radius can reach.
 *
 * The grid is a counting-sort layout in typed arrays: one pass counts the
 * points per cell, a prefix sum turns those counts into cell starts, and a
 * second pass writes each point into its cell's span. There is no per-point
 * object and no keyed map, so building is one allocation per array rather
 * than one per point, and a cell's members are a contiguous run.
 *
 * Screen placement is supplied by the caller, either as an affine chart
 * transform or as a function. Nothing here reads a canvas, a DOM node or a
 * renderer, so the same index serves a canvas chart, an offscreen render and
 * a test with no browser at all.
 *
 * A point that projects to a non-finite coordinate, or outside the canvas
 * rectangle, is left out of the index entirely. It is not clamped to an edge
 * cell and cannot be returned by a query, because a hover has to name a point
 * the viewer can actually see.
 */

/**
 * The section fields a hit-test index reads.
 *
 * `ProfileSectionPoints` satisfies this structurally. Naming only the two
 * series that carry screen placement keeps the index independent of which
 * optional attribute channels a section happens to carry.
 */
export interface ProfileSectionPlacement {
  readonly count: number;
  readonly chainage: Float32Array;
  readonly height: Float64Array;
}

/**
 * Chart placement as an affine map.
 *
 * Screen x grows with chainage; screen y grows downward while height grows
 * upward, so height carries a sign flip:
 *
 *   x = originXPx + (chainage - chainageAtOrigin) * pxPerChainage
 *   y = originYPx - (height   - heightAtOrigin)   * pxPerHeight
 *
 * Separate scales for the two axes are what vertical exaggeration is.
 */
export interface ProfileAffineProjection {
  readonly chainageAtOrigin: number;
  readonly heightAtOrigin: number;
  readonly originXPx: number;
  readonly originYPx: number;
  readonly pxPerChainage: number;
  readonly pxPerHeight: number;
}

/**
 * Chart placement as a function, for any mapping an affine one cannot state.
 *
 * The result is written into `out` as `[x, y]`. One `out` is reused for the
 * whole build, so an implementation must write both slots and must not retain
 * the array.
 */
export type ProfileProjectionFn = (chainage: number, height: number, out: Float64Array) => void;

export type ProfileScreenProjection = ProfileAffineProjection | ProfileProjectionFn;

/** Counters a query fills in, so hover cost can be asserted rather than assumed. */
export interface ProfileHitTestStats {
  /** Points whose screen distance was computed. */
  candidatesTested: number;
  /** Grid cells whose span was walked. */
  cellsVisited: number;
}

/** A zeroed stats record, meant to be allocated once and reused per query. */
export function createProfileHitTestStats(): ProfileHitTestStats {
  return { candidatesTested: 0, cellsVisited: 0 };
}

/**
 * Displayed points bucketed by screen cell.
 *
 * `cellStart` has one entry per cell plus a terminator: the members of cell
 * `c` are `itemX/itemY/itemId` over `[cellStart[c], cellStart[c + 1])`.
 * Positions are stored in cell order rather than in the caller's order, so a
 * cell's members are read without an indirection.
 */
export interface ProfileHitTestIndex {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly cellSizePx: number;
  readonly cols: number;
  readonly rows: number;
  /** Displayed points that projected onto the canvas and are queryable. */
  readonly liveCount: number;
  /** Displayed points left out: non-finite projection, or off the canvas. */
  readonly skippedCount: number;
  readonly cellStart: Uint32Array;
  readonly itemX: Float64Array;
  readonly itemY: Float64Array;
  /** Point identity: the index into the section, not the displayed slot. */
  readonly itemId: Uint32Array;
}

export interface ProfileHitTestBuildOptions {
  readonly section: ProfileSectionPlacement;
  /** Indices into the section, in any order. */
  readonly displayed: Uint32Array;
  readonly projection: ProfileScreenProjection;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Grid pitch. Around the largest hover radius in use works well. */
  readonly cellSizePx?: number;
}

/**
 * Grid pitch when the caller states none.
 *
 * Hover radii sit in the 4 to 12 px range, so a 16 px cell keeps a query to a
 * 2x2 or 3x3 neighbourhood while leaving the cell count small enough that the
 * prefix sum stays cheap on a large canvas.
 */
const DEFAULT_CELL_SIZE_PX = 16;

/**
 * Ceiling on the number of cells.
 *
 * The grid is dense, so its cost is set by the canvas size rather than by the
 * point count. A canvas far larger than a viewport would otherwise allocate an
 * arbitrarily large prefix-sum array; the pitch doubles until the count fits.
 */
const MAX_CELLS = 1 << 20;

function projectAffine(
  p: ProfileAffineProjection,
  chainage: number,
  height: number,
  out: Float64Array,
): void {
  out[0] = p.originXPx + (chainage - p.chainageAtOrigin) * p.pxPerChainage;
  out[1] = p.originYPx - (height - p.heightAtOrigin) * p.pxPerHeight;
}

function positiveOrZero(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Bucket the displayed points by screen cell.
 *
 * One projection pass per point, one prefix sum over the cells, one placement
 * pass per point. Storage is typed arrays sized up front from the displayed
 * count and the cell count.
 */
export function buildProfileHitTestIndex(
  options: ProfileHitTestBuildOptions,
): ProfileHitTestIndex {
  const { section, displayed, projection } = options;
  const widthPx = positiveOrZero(options.widthPx);
  const heightPx = positiveOrZero(options.heightPx);

  let cellSizePx = options.cellSizePx ?? DEFAULT_CELL_SIZE_PX;
  if (!Number.isFinite(cellSizePx) || cellSizePx <= 0) cellSizePx = DEFAULT_CELL_SIZE_PX;
  let cols = Math.max(1, Math.ceil(widthPx / cellSizePx));
  let rows = Math.max(1, Math.ceil(heightPx / cellSizePx));
  while (cols * rows > MAX_CELLS) {
    cellSizePx *= 2;
    cols = Math.max(1, Math.ceil(widthPx / cellSizePx));
    rows = Math.max(1, Math.ceil(heightPx / cellSizePx));
  }

  const cellCount = cols * rows;
  const n = displayed.length;
  const screenX = new Float64Array(n);
  const screenY = new Float64Array(n);
  const cellOf = new Int32Array(n);
  const counts = new Uint32Array(cellCount);
  const out = new Float64Array(2);
  const isFn = typeof projection === 'function';

  let live = 0;
  for (let k = 0; k < n; k++) {
    cellOf[k] = -1;
    const id = displayed[k]!;
    if (id >= section.count) continue;
    const chainage = section.chainage[id]!;
    const height = section.height[id]!;
    if (isFn) projection(chainage, height, out);
    else projectAffine(projection, chainage, height, out);
    const x = out[0]!;
    const y = out[1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > widthPx || y < 0 || y > heightPx) continue;
    // A point exactly on the far edge floors to one column past the last, so
    // it joins the last column rather than falling out of the grid.
    let cx = Math.floor(x / cellSizePx);
    if (cx >= cols) cx = cols - 1;
    let cy = Math.floor(y / cellSizePx);
    if (cy >= rows) cy = rows - 1;
    const cell = cy * cols + cx;
    cellOf[k] = cell;
    screenX[k] = x;
    screenY[k] = y;
    counts[cell]!++;
    live++;
  }

  const cellStart = new Uint32Array(cellCount + 1);
  let running = 0;
  for (let c = 0; c < cellCount; c++) {
    running += counts[c]!;
    cellStart[c + 1] = running;
  }

  const cursor = new Uint32Array(cellCount);
  cursor.set(cellStart.subarray(0, cellCount));

  const itemX = new Float64Array(live);
  const itemY = new Float64Array(live);
  const itemId = new Uint32Array(live);
  for (let k = 0; k < n; k++) {
    const cell = cellOf[k]!;
    if (cell < 0) continue;
    const at = cursor[cell]!++;
    itemX[at] = screenX[k]!;
    itemY[at] = screenY[k]!;
    itemId[at] = displayed[k]!;
  }

  return {
    widthPx,
    heightPx,
    cellSizePx,
    cols,
    rows,
    liveCount: live,
    skippedCount: n - live,
    cellStart,
    itemX,
    itemY,
    itemId,
  };
}

/**
 * Nearest displayed point to a screen position, within a pixel radius.
 *
 * Returns the point's index into the section, or `null` when no displayed
 * point lies within the radius. A point exactly on the radius counts as
 * inside.
 *
 * Ties resolve to the smaller section index. Screen distance alone leaves
 * coincident and mirrored points ambiguous, and an ambiguous winner would
 * change with the order the displayed set happened to arrive in, so the same
 * pointer position would not always report the same point.
 *
 * `stats`, when supplied, is overwritten with what this query touched.
 */
export function queryProfileHitTest(
  index: ProfileHitTestIndex,
  xPx: number,
  yPx: number,
  radiusPx: number,
  stats?: ProfileHitTestStats,
): number | null {
  if (stats) {
    stats.candidatesTested = 0;
    stats.cellsVisited = 0;
  }
  if (!Number.isFinite(xPx) || !Number.isFinite(yPx)) return null;
  if (!Number.isFinite(radiusPx) || radiusPx < 0) return null;
  if (index.liveCount === 0) return null;

  // Every live point is inside the canvas rectangle, so a circle that clears
  // the rectangle on any axis cannot reach one.
  if (xPx + radiusPx < 0 || xPx - radiusPx > index.widthPx) return null;
  if (yPx + radiusPx < 0 || yPx - radiusPx > index.heightPx) return null;

  const { cellSizePx, cols, rows, cellStart, itemX, itemY, itemId } = index;
  const lastCol = cols - 1;
  const lastRow = rows - 1;
  let c0 = Math.floor((xPx - radiusPx) / cellSizePx);
  let c1 = Math.floor((xPx + radiusPx) / cellSizePx);
  let r0 = Math.floor((yPx - radiusPx) / cellSizePx);
  let r1 = Math.floor((yPx + radiusPx) / cellSizePx);
  if (c0 < 0) c0 = 0;
  if (c0 > lastCol) c0 = lastCol;
  if (c1 > lastCol) c1 = lastCol;
  if (r0 < 0) r0 = 0;
  if (r0 > lastRow) r0 = lastRow;
  if (r1 > lastRow) r1 = lastRow;

  const r2 = radiusPx * radiusPx;
  let bestId = -1;
  let best2 = Infinity;
  let tested = 0;
  let visited = 0;

  for (let cy = r0; cy <= r1; cy++) {
    const rowBase = cy * cols;
    for (let cx = c0; cx <= c1; cx++) {
      const cell = rowBase + cx;
      const from = cellStart[cell]!;
      const to = cellStart[cell + 1]!;
      visited++;
      for (let i = from; i < to; i++) {
        const dx = itemX[i]! - xPx;
        const dy = itemY[i]! - yPx;
        const d2 = dx * dx + dy * dy;
        tested++;
        if (d2 > r2) continue;
        const id = itemId[i]!;
        if (d2 < best2 || (d2 === best2 && id < bestId)) {
          best2 = d2;
          bestId = id;
        }
      }
    }
  }

  if (stats) {
    stats.candidatesTested = tested;
    stats.cellsVisited = visited;
  }
  return bestId < 0 ? null : bestId;
}
