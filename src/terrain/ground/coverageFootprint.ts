/**
 * coverageFootprint.ts
 *
 * Pure-data leaf — which cells of a DTM grid lie inside the data's coverage,
 * so the void fill never gives a height to ground no return came near.
 *
 * WHY. The void fill reaches up to its search radius (24 cells geodesic, 32
 * IDW) from ANY measured cell, in every direction. Inside a survey that closes
 * holes under trees and buildings, which is its job. Outside a survey it grows
 * a fringe of invented ground around the whole data edge: on a narrow diagonal
 * strip in a square bounding box the fringe can hold more cells than the strip,
 * and contours, flow routing and access costs then treat it as terrain.
 *
 * RULE. A cell is in coverage when it is
 *   1. measured (at least one ground return), or
 *   2. inside the morphological CLOSING of the measured cells by a disc of
 *      radius `radiusCells`: equivalently, no empty disc of that radius fits
 *      over the cell anywhere inside the grid. Gaps, bays and speckle narrower
 *      than the disc's diameter are bridged; a straight or convex data edge is
 *      never grown outward, whatever its orientation; or
 *   3. part of a void region the measured cells ENCLOSE (4-connected, not
 *      touching the grid border). A hole wholly surrounded by data is
 *      bracketed on every side, so it is an interpolation, not an
 *      extrapolation, whatever its size; the fill's own radius still bounds it.
 * Everything else is outside the footprint: the fill leaves it NaN and the
 * grid marks it as no data.
 *
 * Distances are Euclidean in CELLS (exact, not a chamfer approximation). The
 * area beyond the grid border is unknown rather than empty, so it never erodes
 * the footprint: a cell between the data and the border is kept when it is
 * within the radius of data and no empty disc inside the grid covers it.
 *
 * No DOM, no three.js, no I/O. Deterministic.
 */

/**
 * Footprint mask (1 = in coverage) over a row-major `cols × rows` grid.
 * `hadData[i] === 1` marks measured cells. `radiusCells` is the closing disc
 * radius, clamped to [1, 254].
 */
export function coverageFootprint(
  hadData: Uint8Array,
  cols: number,
  rows: number,
  radiusCells: number,
): Uint8Array {
  const n = cols * rows;
  const out = new Uint8Array(n);
  if (n === 0) return out;
  const radius = Math.min(254, Math.max(1, Math.floor(radiusCells)));

  // Closing = erosion of the dilation. Erosion by a disc is the complement of
  // the dilation of the complement, so both halves are one dilation routine.
  const dilated = dilateDisc(hadData, cols, rows, radius);
  const outsideDilated = new Uint8Array(n);
  for (let i = 0; i < n; i++) outsideDilated[i] = dilated[i] === 1 ? 0 : 1;
  const eroding = dilateDisc(outsideDilated, cols, rows, radius);
  for (let i = 0; i < n; i++) {
    out[i] = hadData[i] === 1 || eroding[i] === 0 ? 1 : 0;
  }

  // Enclosed holes: whatever outside-footprint cell the grid border cannot
  // reach (4-connected) is surrounded by coverage.
  const open = borderConnected(out, cols, rows);
  for (let i = 0; i < n; i++) if (out[i] === 0 && open[i] === 0) out[i] = 1;
  return out;
}

/**
 * No-data cells OUTSIDE the surveyed area (1 = outside): cells with coverage 0
 * that reach the grid border through other coverage-0 cells (4-connected). A
 * no-data cell the data surrounds is a gap inside the survey and stays 0.
 *
 * For a grid built with a footprint this is exactly the cells outside it: the
 * footprint is the measured cells, their closing (every cell of which lies
 * within the fill's radius, so it is filled) and the voids they enclose. Read
 * from `coverage` alone, it needs nothing stored beside the grid.
 */
export function outsideCoverageMask(coverage: Uint8Array, cols: number, rows: number): Uint8Array {
  return borderConnected(coverage, cols, rows);
}

/** Cells with `mask[i] === 0` that reach the grid border through such cells (4-connected). */
function borderConnected(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const n = cols * rows;
  const open = new Uint8Array(n);
  if (n === 0) return open;
  const stack: number[] = [];
  const seed = (i: number): void => {
    if (mask[i] === 0 && open[i] === 0) { open[i] = 1; stack.push(i); }
  };
  for (let c = 0; c < cols; c++) { seed(c); seed((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { seed(r * cols); seed(r * cols + cols - 1); }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const c = i % cols;
    if (c > 0) seed(i - 1);
    if (c < cols - 1) seed(i + 1);
    if (i >= cols) seed(i - cols);
    if (i < n - cols) seed(i + cols);
  }
  return open;
}

/**
 * Cells within Euclidean distance `radius` (in cells) of a set cell. Exact:
 * a per-row horizontal distance (capped at radius + 1), then for each cell the
 * minimum over the rows within reach of dx² + dy². O(cells × (2·radius + 1)).
 */
function dilateDisc(mask: Uint8Array, cols: number, rows: number, radius: number): Uint8Array {
  const n = cols * rows;
  const cap = radius + 1;
  const h = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let d = cap;
    for (let c = 0; c < cols; c++) {
      d = mask[base + c] === 1 ? 0 : Math.min(cap, d + 1);
      h[base + c] = d;
    }
    d = cap;
    for (let c = cols - 1; c >= 0; c--) {
      d = mask[base + c] === 1 ? 0 : Math.min(cap, d + 1);
      if (d < h[base + c]) h[base + c] = d;
    }
  }
  const r2 = radius * radius;
  const out = new Uint8Array(n);
  for (let r = 0; r < rows; r++) {
    const lo = Math.max(0, r - radius);
    const hi = Math.min(rows - 1, r + radius);
    for (let c = 0; c < cols; c++) {
      for (let rr = lo; rr <= hi; rr++) {
        const dx = h[rr * cols + c];
        if (dx > radius) continue;
        const dy = rr - r;
        if (dx * dx + dy * dy <= r2) { out[r * cols + c] = 1; break; }
      }
    }
  }
  return out;
}
