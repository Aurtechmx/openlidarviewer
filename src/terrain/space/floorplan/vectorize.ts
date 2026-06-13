/**
 * vectorize.ts
 *
 * Stage 3 of the floor-plan extraction pipeline: turn the binary wall mask
 * into clean vector wall outlines.
 *
 *   1. BOUNDARY TRACE — every closed boundary loop of the mask (outer
 *      outlines AND holes) is walked along cell edges with a left-hand rule
 *      (marching-squares-equivalent on a binary grid). Outer loops come out
 *      counter-clockwise and holes clockwise, so a single nonzero-winding
 *      fill renders wall strips with their holes punched — in SVG and
 *      pdf-lib alike.
 *   2. DOUGLAS-PEUCKER — the raw loops are grid staircases; simplification
 *      at ~1 cell of tolerance recovers straight runs and true diagonals
 *      without inventing geometry beyond the raster's own resolution.
 *   3. DOMINANT-AXIS SNAP (optional, Manhattan-world) — most rooms have two
 *      perpendicular wall directions. When the length-weighted angle
 *      histogram is clearly bimodal at ~90°, segments within a small
 *      tolerance of either axis are snapped onto it, giving crisp parallel
 *      walls. When the histogram is NOT bimodal (round / irregular spaces)
 *      snapping stays OFF — no fabricated right angles.
 *
 * Pure data, deterministic. No DOM.
 */

import type { OccupancyGrid } from './occupancyGrid';

/** A closed ring of plan points, metres. Not explicitly re-closed (last ≠ first). */
export type Ring = ReadonlyArray<readonly [number, number]>;

/**
 * Trace every closed boundary loop of the mask. Points are CELL-CORNER
 * world coordinates (metres). The walk keeps filled cells on its LEFT, so
 * outer boundaries are CCW and hole boundaries CW (y-up frame) — exactly
 * what nonzero-winding fills expect.
 */
export function traceMaskBoundaries(grid: OccupancyGrid): Ring[] {
  const { mask, cols, rows, cellX, cellY, originX, originY } = grid;
  const filled = (c: number, r: number): boolean =>
    c >= 0 && c < cols && r >= 0 && r < rows && mask[r * cols + c] === 1;
  // Directed-edge visited set, keyed by (corner, direction). Each directed
  // boundary edge belongs to exactly one loop, so marking edges (not cells)
  // lets the enumeration find every loop exactly once.
  const cw = cols + 1;
  const visited = new Uint8Array(cw * (rows + 1) * 4);
  const key = (cx: number, cy: number, d: number): number => (cy * cw + cx) * 4 + d;

  const rings: Ring[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Every boundary loop contains at least one "bottom" edge (a filled
      // cell with an empty cell below), walkable in +x — enumerate those.
      if (!filled(c, r) || filled(c, r - 1) || visited[key(c, r, 0)]) continue;
      const ring = walkLoop(filled, visited, key, c, r, cols, rows);
      if (ring.length >= 4) {
        rings.push(
          ring.map(([cx, cy]) => [originX + cx * cellX, originY + cy * cellY] as const),
        );
      }
    }
  }
  return rings;
}

/** Left-hand-rule loop walk from the bottom edge of cell (sc, sr). */
function walkLoop(
  filled: (c: number, r: number) => boolean,
  visited: Uint8Array,
  key: (cx: number, cy: number, d: number) => number,
  sc: number,
  sr: number,
  cols: number,
  rows: number,
): Array<[number, number]> {
  // Directions: 0=+x, 1=+y, 2=-x, 3=-y (corner grid).
  const ring: Array<[number, number]> = [];
  let cx = sc, cy = sr, dir = 0;
  visited[key(cx, cy, 0)] = 1;
  ring.push([cx, cy]);
  cx++;
  const maxSteps = 4 * (cols + 1) * (rows + 1) + 8;
  for (let steps = 0; steps < maxSteps; steps++) {
    const bl = filled(cx - 1, cy - 1);
    const br = filled(cx, cy - 1);
    const tl = filled(cx - 1, cy);
    const tr = filled(cx, cy);
    // Turn preference left → straight → right → back keeps the region on the
    // left and resolves diagonal pinch-points deterministically.
    const tryDirs = [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
    let nd = -1;
    for (const d of tryDirs) {
      let leftFilled = false, rightFilled = false;
      if (d === 0) { leftFilled = tr; rightFilled = br; }
      else if (d === 1) { leftFilled = tl; rightFilled = tr; }
      else if (d === 2) { leftFilled = bl; rightFilled = tl; }
      else { leftFilled = br; rightFilled = bl; }
      if (leftFilled && !rightFilled) { nd = d; break; }
    }
    if (nd < 0) break; // cannot happen on a well-formed mask; honest bail-out
    if (cx === sc && cy === sr && nd === 0) break; // about to re-walk the start edge
    visited[key(cx, cy, nd)] = 1;
    ring.push([cx, cy]);
    if (nd === 0) cx++; else if (nd === 1) cy++; else if (nd === 2) cx--; else cy--;
    dir = nd;
  }
  return ring;
}

/** Signed area of a ring (positive = CCW in a y-up frame). */
export function ringSignedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Perpendicular distance from point p to the segment a–b. */
function segDist(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Douglas-Peucker on an OPEN chain (endpoints kept) — exported for the wall
 * graph's edge straightener (wallGraph.ts), which simplifies skeleton PATHS
 * (node → node, open) rather than closed rings. Same machinery as
 * {@link simplifyRing}, minus the ring anchoring.
 */
export function simplifyChain(pts: Ring, epsilon: number): Array<readonly [number, number]> {
  return dpChain(pts, epsilon);
}

/** Douglas-Peucker on an OPEN chain (endpoints kept), iterative stack. */
function dpChain(pts: Ring, epsilon: number): Array<readonly [number, number]> {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    let worst = -1, worstD = epsilon;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(pts[i], pts[lo], pts[hi]);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/**
 * Douglas-Peucker for a CLOSED ring: anchor at vertex 0 and the vertex
 * farthest from it (two stable anchors), simplify the two chains between
 * them, and rejoin. Rings smaller than 4 points pass through unchanged.
 */
export function simplifyRing(ring: Ring, epsilon: number): Ring {
  const n = ring.length;
  if (n < 4 || !(epsilon > 0)) return ring;
  let far = 1, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) { farD = d; far = i; }
  }
  const chainA = dpChain(ring.slice(0, far + 1), epsilon);
  const chainB = dpChain([...ring.slice(far), ring[0]], epsilon);
  // Drop the shared anchors when rejoining (chainA ends at `far`, chainB
  // starts at `far` and ends back at vertex 0).
  return [...chainA, ...chainB.slice(1, -1)];
}

export interface DominantAxes {
  /** Direction of the stronger wall axis, radians in [0, π). */
  readonly thetaRad: number;
  /** Length-weighted share of segments within tolerance of the two axes. */
  readonly coverage: number;
}

/**
 * Dominant-axis snap control — the single switch the extraction pipeline
 * reads (a UI control is deferred; change the constant to experiment):
 *
 *   'auto'   — (default) snap ONLY when the wall-direction histogram is
 *              clearly bimodal at ~90° ({@link detectDominantAxes}' gates).
 *              Round / irregular spaces get NO fabricated right angles.
 *   'off'    — never snap; walls render exactly as traced from the raster.
 *   'strong' — snap whenever ANY dominant direction peak exists, even when
 *              the bimodal gates fail (the strongest single axis is used and
 *              a perpendicular partner is assumed). May fabricate right
 *              angles on genuinely non-rectilinear plans — intended for
 *              known rectilinear buildings whose scans are too noisy for the
 *              auto gates.
 */
export type SnapMode = 'auto' | 'off' | 'strong';
export const SNAP_MODE: SnapMode = 'auto';

/** How {@link resolveSnapAxes} arrived at its axes (threaded into the sheet's
 * honesty footer — a forced snap must say so). */
export interface SnapResolution {
  /** The snap axes to use, or null = leave directions as traced. */
  readonly axes: DominantAxes | null;
  /** True when 'strong' mode forced axes the auto gates had rejected. */
  readonly forced: boolean;
  /** The mode that produced this resolution. */
  readonly mode: SnapMode;
}

/** Histogram bin width (degrees) for the wall-direction search. */
const ANGLE_BIN_DEG = 5;
/** Default snap tolerance (degrees) — segments this close to an axis snap. */
export const SNAP_TOL_DEG = 7;
/** Minimum combined two-axis coverage for the Manhattan assumption. */
const MIN_AXES_COVERAGE = 0.55;
/** Minimum coverage of each individual peak. */
const MIN_PEAK_COVERAGE = 0.15;
/** How far from exactly perpendicular the two peaks may be (degrees). */
const PERP_TOL_DEG = 12;

/** Circular distance between two angles, period 180° (radians in [0, π)). */
const circDist = (a: number, b: number): number => {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
};

/** Length-weighted segment direction angles of a ring set (period π).
 * Returns null when the set is degenerate (no length / < 4 segments). */
function collectSegmentAngles(
  rings: ReadonlyArray<Ring>,
): { angles: number[]; weights: number[]; totalW: number } | null {
  const angles: number[] = [];
  const weights: number[] = [];
  let totalW = 0;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i];
      const [x2, y2] = ring[(i + 1) % ring.length];
      const dx = x2 - x1, dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (len <= 0) continue;
      let ang = Math.atan2(dy, dx);
      if (ang < 0) ang += Math.PI;
      if (ang >= Math.PI) ang -= Math.PI;
      angles.push(ang);
      weights.push(len);
      totalW += len;
    }
  }
  if (totalW <= 0 || angles.length < 4) return null;
  return { angles, weights, totalW };
}

/**
 * Find the two dominant, PERPENDICULAR wall directions from a length-weighted
 * angle histogram of the ring segments. Returns null when the histogram is
 * not clearly bimodal at ~90° — the caller must then skip axis snapping (no
 * Manhattan-world assumption for round / irregular spaces).
 */
export function detectDominantAxes(rings: ReadonlyArray<Ring>, tolDeg = SNAP_TOL_DEG): DominantAxes | null {
  const segs = collectSegmentAngles(rings);
  if (!segs) return null;
  const { angles, weights, totalW } = segs;

  const bins = Math.round(180 / ANGLE_BIN_DEG);
  const hist = new Float64Array(bins);
  for (let i = 0; i < angles.length; i++) {
    let bi = Math.floor((angles[i] / Math.PI) * bins);
    if (bi >= bins) bi = bins - 1;
    hist[bi] += weights[i];
  }
  const tol = (tolDeg * Math.PI) / 180;

  /** Refine a peak: length-weighted circular mean (period π) near `centre`. */
  const refine = (centre: number): { theta: number; coverage: number } => {
    let s = 0, c = 0;
    for (let i = 0; i < angles.length; i++) {
      if (circDist(angles[i], centre) > tol) continue;
      // Angle doubling maps the π-periodic angles onto the full circle so a
      // plain vector mean is valid across the 0/π wrap.
      s += weights[i] * Math.sin(2 * angles[i]);
      c += weights[i] * Math.cos(2 * angles[i]);
    }
    let theta = 0.5 * Math.atan2(s, c);
    if (theta < 0) theta += Math.PI;
    let cov = 0;
    for (let i = 0; i < angles.length; i++) if (circDist(angles[i], theta) <= tol) cov += weights[i];
    return { theta, coverage: cov / totalW };
  };

  // Strongest bin → first axis.
  let bestBin = 0;
  for (let i = 1; i < bins; i++) if (hist[i] > hist[bestBin]) bestBin = i;
  const peakA = refine(((bestBin + 0.5) / bins) * Math.PI);

  // Strongest bin clearly away from the first axis → second axis candidate.
  let secondBin = -1;
  for (let i = 0; i < bins; i++) {
    const centre = ((i + 0.5) / bins) * Math.PI;
    if (circDist(centre, peakA.theta) <= 2 * tol) continue;
    if (secondBin < 0 || hist[i] > hist[secondBin]) secondBin = i;
  }
  if (secondBin < 0) return null;
  const peakB = refine(((secondBin + 0.5) / bins) * Math.PI);

  // Manhattan gate: both peaks real, perpendicular, and jointly dominant.
  const perpErr = Math.abs(circDist(peakA.theta, peakB.theta) - Math.PI / 2);
  if (perpErr > (PERP_TOL_DEG * Math.PI) / 180) return null;
  if (peakA.coverage < MIN_PEAK_COVERAGE || peakB.coverage < MIN_PEAK_COVERAGE) return null;
  const coverage = peakA.coverage + peakB.coverage;
  if (coverage < MIN_AXES_COVERAGE) return null;

  const theta = peakA.coverage >= peakB.coverage ? peakA.theta : peakB.theta;
  return { thetaRad: theta, coverage };
}

/**
 * Resolve the snap axes for a ring set under a {@link SnapMode}:
 *
 *   'off'    — null (never snap);
 *   'auto'   — {@link detectDominantAxes} (gated; null on non-Manhattan);
 *   'strong' — the auto result when the gates pass, else the strongest
 *              single direction peak (length-weighted circular mean of the
 *              best histogram bin's neighbourhood) FORCED as the snap axis —
 *              `forced: true` so the sheet footer can say so honestly.
 *
 * Degenerate ring sets resolve to null in every mode.
 */
export function resolveSnapAxes(
  rings: ReadonlyArray<Ring>,
  mode: SnapMode = SNAP_MODE,
  tolDeg = SNAP_TOL_DEG,
): SnapResolution {
  if (mode === 'off') return { axes: null, forced: false, mode };
  const auto = detectDominantAxes(rings, tolDeg);
  if (auto || mode !== 'strong') return { axes: auto, forced: false, mode };
  const segs = collectSegmentAngles(rings);
  if (!segs) return { axes: null, forced: false, mode };
  const { angles, weights, totalW } = segs;
  const bins = Math.round(180 / ANGLE_BIN_DEG);
  const hist = new Float64Array(bins);
  for (let i = 0; i < angles.length; i++) {
    let bi = Math.floor((angles[i] / Math.PI) * bins);
    if (bi >= bins) bi = bins - 1;
    hist[bi] += weights[i];
  }
  let bestBin = 0;
  for (let i = 1; i < bins; i++) if (hist[i] > hist[bestBin]) bestBin = i;
  // Length-weighted circular mean (period π, angle doubling) near the peak.
  const tol = (tolDeg * Math.PI) / 180;
  const centre = ((bestBin + 0.5) / bins) * Math.PI;
  let s = 0, c = 0;
  for (let i = 0; i < angles.length; i++) {
    if (circDist(angles[i], centre) > tol) continue;
    s += weights[i] * Math.sin(2 * angles[i]);
    c += weights[i] * Math.cos(2 * angles[i]);
  }
  if (s === 0 && c === 0) return { axes: null, forced: false, mode };
  let theta = 0.5 * Math.atan2(s, c);
  if (theta < 0) theta += Math.PI;
  let cov = 0;
  for (let i = 0; i < angles.length; i++) if (circDist(angles[i], theta) <= tol) cov += weights[i];
  return { axes: { thetaRad: theta, coverage: cov / totalW }, forced: true, mode };
}

/**
 * Snap a ring's near-axis segments onto the dominant axes: rotate into the
 * axis frame, classify each segment as horizontal / vertical / other (within
 * `tolDeg`), pin h-segments to their mean y and v-segments to their mean x
 * (shared corners take x from the v-side and y from the h-side — crisp
 * right-angle corners), then rotate back. 'Other' segments are untouched, so
 * a genuine diagonal wall survives snapping.
 */
export function snapRingToAxes(ring: Ring, thetaRad: number, tolDeg = SNAP_TOL_DEG): Ring {
  const n = ring.length;
  if (n < 3) return ring;
  const cosT = Math.cos(-thetaRad), sinT = Math.sin(-thetaRad);
  const pts: Array<[number, number]> = ring.map(([x, y]) => [
    x * cosT - y * sinT,
    x * sinT + y * cosT,
  ]);
  const tol = (tolDeg * Math.PI) / 180;

  // Per-segment class + snap target (mean coordinate along the pinned axis).
  const cls = new Array<'h' | 'v' | 'o'>(n);
  const target = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    let ang = Math.atan2(y2 - y1, x2 - x1);
    if (ang < 0) ang += Math.PI;
    if (ang >= Math.PI) ang -= Math.PI;
    const dH = Math.min(ang, Math.PI - ang); // distance to horizontal
    const dV = Math.abs(ang - Math.PI / 2); // distance to vertical
    if (dH <= tol) { cls[i] = 'h'; target[i] = (y1 + y2) / 2; }
    else if (dV <= tol) { cls[i] = 'v'; target[i] = (x1 + x2) / 2; }
    else { cls[i] = 'o'; target[i] = 0; }
  }

  const out: Array<readonly [number, number]> = [];
  const cosB = Math.cos(thetaRad), sinB = Math.sin(thetaRad);
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n;
    let [x, y] = pts[i];
    // x is constrained by adjacent vertical segments, y by horizontal ones;
    // both adjacent → average (collinear runs converge to a shared line).
    if (cls[prev] === 'v' && cls[i] === 'v') x = (target[prev] + target[i]) / 2;
    else if (cls[prev] === 'v') x = target[prev];
    else if (cls[i] === 'v') x = target[i];
    if (cls[prev] === 'h' && cls[i] === 'h') y = (target[prev] + target[i]) / 2;
    else if (cls[prev] === 'h') y = target[prev];
    else if (cls[i] === 'h') y = target[i];
    out.push([x * cosB - y * sinB, x * sinB + y * cosB]);
  }
  return dedupeRing(out);
}

/** Remove consecutive (near-)duplicate vertices a snap can leave behind. */
export function dedupeRing(ring: Ring, epsilon = 1e-9): Ring {
  const out: Array<readonly [number, number]> = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > epsilon) out.push(p);
  }
  while (
    out.length > 1 &&
    Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= epsilon
  ) {
    out.pop();
  }
  return out;
}
