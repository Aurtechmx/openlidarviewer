/**
 * footprintClearance.ts — accounting for vehicle width by dilating blocked
 * cells, per §12.7 of the governing prompt.
 *
 * A route centreline threading a one-cell gap between two hard-blocked cells
 * is not a route a platform of nonzero width can actually take. The standard
 * remedy (used throughout mobile-robot configuration-space planning) is to
 * grow every obstacle by half the vehicle's width before planning a
 * zero-width path through what remains: a centreline through the dilated
 * space keeps the real vehicle's edges clear of the real obstacles.
 *
 * ── WHY THIS DILATES ONLY THE NODE-LEVEL HARD BLOCKS ────────────────────────
 * `traversabilityCost.ts` hard-blocks a NODE for reasons that do not depend
 * on the direction of travel (no data, outside ROI, low confidence,
 * ruggedness, obstruction) and hard-blocks an EDGE for reasons that do
 * (longitudinal grade, cross slope, step height). Only the node reasons
 * describe a place the vehicle's body cannot occupy at all; an edge that is
 * too steep in one heading says nothing about whether the cell itself is
 * physically clear, so dilating on edge reasons would block a cell for a
 * heading nobody is trying to use through it. Width clearance is therefore
 * computed from the node mask alone and applied as an ADDITIONAL node reason.
 *
 * ── THE FOOTPRINT MODEL ──────────────────────────────────────────────────────
 * A cell is the rectangle `cellMetresX × cellMetresY` around its centre, not a
 * point. "Unsupported" area is every node-blocked cell's rectangle PLUS
 * everything outside the grid: terrain nobody measured is not terrain a body
 * may overhang, so the survey edge clears like a NoData cell. The body is a
 * disc of radius ρ = vehicleWidth / 2 centred on the route centreline.
 *
 *   distance from a cell centre to a blocked cell offset (dc, dr) =
 *     hypot(max(|dc|·cx − cx/2, 0), max(|dr|·cy − cy/2, 0))
 *
 * i.e. the distance to the blocked RECTANGLE, not to its centre. Measuring to
 * the centre let a 1.2 m body pass a 1 m corridor (each wall centre is 1 m
 * away, the wall itself 0.5 m) and let any width route on a map with no
 * internal blocked cell.
 *
 * TOUCHING POLICY: a cell is refused when that distance is STRICTLY less than
 * ρ. A body exactly as wide as a corridor touches both walls and fits. The
 * comparison is on squared metres with a relative tolerance of 1e-12, so a
 * touching case that rounds a few ulps either way is still read as touching.
 *
 * Vehicle LENGTH is not used. §12.7 states width-only clearance is acceptable
 * for v0.7; swept-body orientation collision is not implemented.
 *
 * ── BOUNDED WORK ─────────────────────────────────────────────────────────────
 * The distance field is computed exactly by a separable transform: a row pass
 * finds, per cell, the nearest blocked column in each row (virtual border
 * columns included), and a column pass takes the lower envelope of parabolas
 * over rows (Felzenszwalb & Huttenlocher 2012), run twice with the row offset
 * shifted by ±½ cell so the rectangle (not centre) distance is exact. Work is
 * O(cols · rows) whatever the width; a width wider than the grid's own extent
 * short-circuits to "every cell refused".
 *
 * ── DIAGONAL MOVES ───────────────────────────────────────────────────────────
 * Node clearance alone is not enough for a diagonal move: its centreline
 * passes the corner shared by the two orthogonal cells bordering it, and its
 * swept disc can come closer to a blocked rectangle mid-move than at either
 * end. {@link diagonalSweepClear} refuses a diagonal whose bordering
 * orthogonal cell is unsupported (at any width, including zero), and for a
 * positive width checks the exact segment-to-rectangle distance of every
 * blocked cell whose nearest point could lie inside the move. Orthogonal
 * moves need no extra check: along an axis-aligned centre-to-centre segment
 * the distance to any grid-aligned rectangle (and to the survey edge) is
 * smallest at an endpoint, and both endpoints already cleared.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/** Relative tolerance on squared distances; see the touching policy above. */
const TOUCH_TOLERANCE = 1e-12;

/** True when a squared clearance is strictly inside a squared radius. */
const intrudes = (d2: number, r2: number): boolean => d2 < r2 * (1 - TOUCH_TOLERANCE);

/**
 * Lower envelope of parabolas `(p − (k + shift))² · scale2 + h[k]` over every
 * k with finite `h[k]`, evaluated at p = 0 … m − 1 (Felzenszwalb &
 * Huttenlocher's 1-D distance transform with the vertices offset by `shift`).
 */
function envelope(h: Float64Array, m: number, shift: number, scale2: number, out: Float64Array): void {
  const v = new Int32Array(m);
  const z = new Float64Array(m + 1);
  let k = -1;
  const f = (q: number): number => h[q] / scale2;
  for (let q = 0; q < m; q++) {
    if (!Number.isFinite(h[q])) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = Number.NEGATIVE_INFINITY; z[1] = Number.POSITIVE_INFINITY; continue; }
    for (;;) {
      const p = v[k];
      const s = ((f(q) + q * q) - (f(p) + p * p)) / (2 * q - 2 * p);
      if (s <= z[k] && k > 0) { k--; continue; }
      if (s <= z[k]) { v[0] = q; z[0] = Number.NEGATIVE_INFINITY; z[1] = Number.POSITIVE_INFINITY; k = 0; break; }
      k++; v[k] = q; z[k] = s; z[k + 1] = Number.POSITIVE_INFINITY;
      break;
    }
  }
  if (k < 0) { out.fill(Number.POSITIVE_INFINITY); return; }
  let j = 0;
  for (let p = 0; p < m; p++) {
    const x = p - shift; // envelope over unshifted vertices, evaluated at p − shift
    while (z[j + 1] < x) j++;
    const d = x - v[j];
    out[p] = d * d * scale2 + h[v[j]];
  }
}

/**
 * Squared metric distance from every cell centre to the nearest unsupported
 * rectangle (a cell with `blocked[i] === 1`, or anything outside the grid).
 * A blocked cell reads 0.
 */
export function unsupportedClearanceSquared(
  blocked: Uint8Array,
  cols: number,
  rows: number,
  cellMetresX: number,
  cellMetresY: number,
): Float64Array {
  const n = cols * rows;
  const g = new Float64Array(n);
  // Row pass: nearest blocked column in the same row, the virtual columns
  // −1 and `cols` counting as blocked.
  for (let r = 0; r < rows; r++) {
    const base = r * cols;
    let last = -1;
    for (let c = 0; c < cols; c++) {
      if (blocked[base + c] === 1) last = c;
      g[base + c] = c - last;
    }
    last = cols;
    for (let c = cols - 1; c >= 0; c--) {
      if (blocked[base + c] === 1) last = c;
      const k = Math.min(g[base + c], last - c);
      const gx = k === 0 ? 0 : (k - 0.5) * cellMetresX;
      g[base + c] = gx * gx;
    }
  }
  // Column pass. Row r′ < r contributes ((r − r′ − ½)·cy)² + g[r′]: a
  // parabola in r with its vertex at r′ + ½. Row r′ > r contributes
  // ((r′ − r − ½)·cy)², vertex r′ − ½. Each envelope over-estimates the rows
  // on the other side (and r′ = r itself), so taking the minimum of both
  // envelopes, the same-row term and the two virtual border rows is exact.
  const cy2 = cellMetresY * cellMetresY;
  const out = new Float64Array(n);
  const col = new Float64Array(rows);
  const below = new Float64Array(rows);
  const above = new Float64Array(rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) col[r] = g[r * cols + c];
    envelope(col, rows, 0.5, cy2, below);
    envelope(col, rows, -0.5, cy2, above);
    for (let r = 0; r < rows; r++) {
      const top = (r + 0.5) * cellMetresY;
      const bottom = (rows - r - 0.5) * cellMetresY;
      out[r * cols + c] = Math.min(col[r], below[r], above[r], top * top, bottom * bottom);
    }
  }
  return out;
}

/** `vehicleWidth / 2` when it is a positive finite number, else 0. */
export function footprintRadius(vehicleWidth: number): number {
  return Number.isFinite(vehicleWidth) && vehicleWidth > 0 ? vehicleWidth / 2 : 0;
}

/**
 * Refuse every cell whose `vehicleWidth / 2` disc would overlap unsupported
 * area (a `blocked` cell's rectangle, or outside the grid). Returns a NEW
 * mask; `blocked` is not mutated. A `vehicleWidth` of 0 (or non-finite)
 * returns a copy of `blocked` unchanged: a zero-width centreline has nothing
 * to clear beyond the cells themselves.
 */
export function dilateBlocked(
  blocked: Uint8Array,
  cols: number,
  rows: number,
  cellMetresX: number,
  cellMetresY: number,
  vehicleWidth: number,
): Uint8Array {
  const n = cols * rows;
  const out = new Uint8Array(n);
  const radiusM = footprintRadius(vehicleWidth);
  if (radiusM <= 0) {
    out.set(blocked);
    return out;
  }
  // No cell centre is farther than half the grid's extent from the survey
  // edge, so a wider disc fits nowhere: refuse everything without a scan.
  if (radiusM > (cols * cellMetresX) / 2 || radiusM > (rows * cellMetresY) / 2) {
    out.fill(1);
    return out;
  }
  const d2 = unsupportedClearanceSquared(blocked, cols, rows, cellMetresX, cellMetresY);
  const r2 = radiusM * radiusM;
  for (let i = 0; i < n; i++) out[i] = blocked[i] === 1 || intrudes(d2[i], r2) ? 1 : 0;
  return out;
}

/** Squared distance from point (px, py) to the rectangle [x0, x1] × [y0, y1]. */
function pointRect2(px: number, py: number, x0: number, x1: number, y0: number, y1: number): number {
  const dx = px < x0 ? x0 - px : px > x1 ? px - x1 : 0;
  const dy = py < y0 ? y0 - py : py > y1 ? py - y1 : 0;
  return dx * dx + dy * dy;
}

/** Squared distance from point (px, py) to the segment (0, 0)–(ex, ey). */
function pointSegment2(px: number, py: number, ex: number, ey: number): number {
  const len2 = ex * ex + ey * ey;
  let t = (px * ex + py * ey) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = px - t * ex;
  const dy = py - t * ey;
  return dx * dx + dy * dy;
}

/**
 * Scan one off-diagonal side of the move (0,0) → (ex, ey) in a local frame:
 * rectangles at local offset (j, −k), j ≥ 1, k ≥ 0, excluding (1, 0) (the
 * orthogonal cell, checked by index before this). Returns false at the first
 * unsupported rectangle the swept disc overlaps. `cellAt(j, k)` maps a local
 * offset to a grid index, or −1 outside the grid (the survey edge needs no
 * check here: distance to the outside of a rectangle is concave inside it,
 * so it is smallest at an endpoint, and both endpoints already cleared).
 */
function sideClear(
  ex: number,
  ey: number,
  r2: number,
  radiusM: number,
  maxJ: number,
  maxK: number,
  cellAt: (j: number, k: number) => number,
  unsupported: (index: number) => boolean,
): boolean {
  const len = Math.hypot(ex, ey);
  const len2 = len * len;
  // A rectangle at (j, −k) lies at least ex·ey·(j + k − 1) / len from the
  // move's line; past ρ it cannot intrude.
  const lineGap = (ex * ey) / len;
  const ratio = (ey * ey) / (ex * ex);
  for (let k = 0; k <= maxK; k++) {
    // The corner nearest the line, ((j − ½)·ex, (½ − k)·ey), projects inside
    // the move for j in [centre, centre + len²/ex²]. The rectangle's other
    // corners shift that band by at most one cell down (x1) or `ratio` cells
    // up (y0); the band is widened by both, plus one cell of margin. A corner
    // projecting outside the move is nearer an endpoint than any interior
    // point, and both endpoints already cleared.
    const centre = 0.5 + (k - 0.5) * ratio;
    const jLo = Math.max(1, Math.floor(centre) - 2);
    const jHi = Math.min(maxJ, Math.ceil(centre + len2 / (ex * ex) + ratio) + 1);
    if (lineGap * (jLo + k - 1) >= radiusM) break;
    for (let j = jLo; j <= jHi; j++) {
      if (j === 1 && k === 0) continue;
      if (lineGap * (j + k - 1) >= radiusM) break;
      const idx = cellAt(j, k);
      if (idx < 0 || !unsupported(idx)) continue;
      const x0 = (j - 0.5) * ex, x1 = (j + 0.5) * ex;
      const y0 = (-k - 0.5) * ey, y1 = (-k + 0.5) * ey;
      const d2 = Math.min(
        pointRect2(0, 0, x0, x1, y0, y1),
        pointRect2(ex, ey, x0, x1, y0, y1),
        pointSegment2(x0, y0, ex, ey),
        pointSegment2(x0, y1, ex, ey),
        pointSegment2(x1, y0, ex, ey),
        pointSegment2(x1, y1, ex, ey),
      );
      if (intrudes(d2, r2)) return false;
    }
  }
  return true;
}

/**
 * Whether the move from `fromIndex` by raster offset (dx, dy) keeps the
 * swept footprint off unsupported area, given that both endpoints already
 * cleared node eligibility. Always true for an orthogonal move (see the
 * module header). For a diagonal move: false when either orthogonal cell
 * bordering it is unsupported (any width), and for a positive width false
 * when the swept disc overlaps any unsupported rectangle mid-move.
 * `unsupported(i)` is the node-level mask BEFORE width clearance.
 */
export function diagonalSweepClear(
  unsupported: (index: number) => boolean,
  cols: number,
  rows: number,
  cellMetresX: number,
  cellMetresY: number,
  vehicleWidth: number,
  fromIndex: number,
  dx: number,
  dy: number,
): boolean {
  if (dx === 0 || dy === 0) return true;
  const row = Math.floor(fromIndex / cols);
  const col = fromIndex - row * cols;
  if (unsupported(row * cols + col + dx) || unsupported((row + dy) * cols + col)) return false;
  const radiusM = footprintRadius(vehicleWidth);
  if (radiusM <= 0) return true;
  const r2 = radiusM * radiusM;
  const inGrid = (r: number, c: number): number => (r < 0 || r >= rows || c < 0 || c >= cols ? -1 : r * cols + c);
  // Side A: columns further along dx, rows behind dy. Local (j, −k) → grid
  // (row − k·dy, col + j·dx).
  const sideA = sideClear(cellMetresX, cellMetresY, r2, radiusM, cols, rows,
    (j, k) => inGrid(row - k * dy, col + j * dx), unsupported);
  if (!sideA) return false;
  // Side B: the mirror, axes swapped. Local (j, −k) → grid (row + j·dy,
  // col − k·dx), with x and y cell sizes exchanged.
  return sideClear(cellMetresY, cellMetresX, r2, radiusM, rows, cols,
    (j, k) => inGrid(row + j * dy, col - k * dx), unsupported);
}
