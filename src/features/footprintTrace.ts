/**
 * footprintTrace.ts — turn a footprint's occupancy cells into a clean polygon:
 * trace the rectilinear boundary, simplify it, and orthogonalise it ONLY when the
 * directional evidence is strong.
 *
 *  - traceOccupancyBoundary walks the outer edge of the occupied cells and
 *    returns the exact rectilinear ring in world coordinates.
 *  - simplifyRing removes vertices that lie on a straight run (Douglas–Peucker),
 *    collapsing a cell staircase toward its true corners.
 *  - orthogonaliseRing snaps near-axis edges to the footprint's dominant
 *    orientation, but leaves the ring untouched when no single orientation
 *    dominates — a curved or irregular outline is not forced into a rectangle.
 *
 * A footprint polygon is a DERIVED candidate, not a surveyed building outline.
 * Pure and deterministic.
 */

export interface Pt2 { readonly x: number; readonly y: number }

/**
 * Trace the outer boundary of a set of occupied cells as a closed ring of world
 * corner vertices (first vertex not repeated at the end). Assumes one simple
 * component without holes.
 */
export function traceOccupancyBoundary(
  cells: ReadonlyArray<readonly [number, number]>,
  cellSize: number,
  originX: number,
  originY: number,
): Pt2[] {
  const occ = new Set(cells.map(([cx, cy]) => `${cx}:${cy}`));
  const has = (cx: number, cy: number): boolean => occ.has(`${cx}:${cy}`);
  // Boundary edges: for each occupied cell, a side with no occupied neighbour
  // across it is a boundary edge. Encode each edge by its two corner points.
  const corner = (cx: number, cy: number): string => `${cx}:${cy}`;
  const edges = new Map<string, string[]>(); // cornerKey -> connected cornerKeys
  const link = (a: string, b: string): void => {
    (edges.get(a) ?? edges.set(a, []).get(a)!).push(b);
    (edges.get(b) ?? edges.set(b, []).get(b)!).push(a);
  };
  for (const [cx, cy] of cells) {
    if (!has(cx, cy - 1)) link(corner(cx, cy), corner(cx + 1, cy));       // bottom
    if (!has(cx, cy + 1)) link(corner(cx, cy + 1), corner(cx + 1, cy + 1)); // top
    if (!has(cx - 1, cy)) link(corner(cx, cy), corner(cx, cy + 1));         // left
    if (!has(cx + 1, cy)) link(corner(cx + 1, cy), corner(cx + 1, cy + 1)); // right
  }
  if (edges.size === 0) return [];
  // Walk the ring: start at the lexicographically smallest corner.
  const start = [...edges.keys()].sort()[0];
  const ring: string[] = [start];
  const used = new Set<string>();
  let cur = start;
  let prev = '';
  for (let guard = 0; guard < edges.size * 2 + 4; guard++) {
    const nbrs = edges.get(cur)!;
    let next = '';
    for (const n of nbrs) {
      const ek = cur < n ? `${cur}|${n}` : `${n}|${cur}`;
      if (n !== prev && !used.has(ek)) { next = n; used.add(ek); break; }
    }
    if (next === '' || next === start) break;
    ring.push(next);
    prev = cur;
    cur = next;
  }
  return ring.map((k) => {
    const [cx, cy] = k.split(':').map(Number);
    return { x: originX + cx * cellSize, y: originY + cy * cellSize };
  });
}

/** Douglas–Peucker simplification of a CLOSED ring (tolerance in metres). */
export function simplifyRing(ring: readonly Pt2[], toleranceM: number): Pt2[] {
  if (ring.length <= 4) return dropCollinear(ring, 1e-9);
  // Open the ring at the two farthest-apart vertices, simplify the two chains.
  let iA = 0, iB = 0, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = (ring[i].x - ring[0].x) ** 2 + (ring[i].y - ring[0].y) ** 2;
    if (d > best) { best = d; iB = i; }
  }
  const chain1 = ring.slice(iA, iB + 1);
  const chain2 = ring.slice(iB).concat(ring[iA]);
  const s1 = dp(chain1, toleranceM);
  const s2 = dp(chain2, toleranceM);
  const merged = s1.concat(s2.slice(1, -1));
  return dropCollinear(merged, 1e-9);
}

/**
 * Snap near-axis edges to the ring's dominant orientation. If no orientation
 * carries a strong share of the perimeter, the ring is returned unchanged.
 */
export function orthogonaliseRing(ring: readonly Pt2[], angleTolDeg = 12, dominanceFloor = 0.6): Pt2[] {
  if (ring.length < 4) return [...ring];
  // Dominant orientation from edge lengths, folded to [0, 90).
  const buckets = new Float64Array(90);
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    let deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    deg = ((deg % 90) + 90) % 90;
    buckets[Math.round(deg) % 90] += len;
    total += len;
  }
  if (total <= 0) return [...ring];
  let theta = 0, peak = -1;
  for (let d = 0; d < 90; d++) if (buckets[d] > peak) { peak = buckets[d]; theta = d; }
  // Strong-evidence gate: the dominant orientation (± tolerance) must cover a
  // majority of the perimeter, else leave the outline as measured.
  let near = 0;
  for (let d = 0; d < 90; d++) {
    const diff = Math.min(Math.abs(d - theta), 90 - Math.abs(d - theta));
    if (diff <= angleTolDeg) near += buckets[d];
  }
  if (near / total < dominanceFloor) return [...ring];
  // Rotate into the dominant frame, snap near-axis edges, rotate back.
  const rad = (theta * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rot = ring.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  for (let i = 0; i < rot.length; i++) {
    const a = rot[i], b = rot[(i + 1) % rot.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const nearH = Math.min(Math.abs(ang), Math.abs(Math.abs(ang) - 180)) <= angleTolDeg;
    const nearV = Math.abs(Math.abs(ang) - 90) <= angleTolDeg;
    if (nearH) { const y = (a.y + b.y) / 2; rot[i] = { x: a.x, y }; rot[(i + 1) % rot.length] = { x: b.x, y }; }
    else if (nearV) { const x = (a.x + b.x) / 2; rot[i] = { x, y: a.y }; rot[(i + 1) % rot.length] = { x, y: b.y }; }
  }
  return rot.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
}

// ── helpers ──────────────────────────────────────────────────────────────────
function dp(pts: readonly Pt2[], tol: number): Pt2[] {
  if (pts.length < 3) return [...pts];
  let maxD = -1, idx = 0;
  const a = pts[0], b = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tol) {
    const left = dp(pts.slice(0, idx + 1), tol);
    const right = dp(pts.slice(idx), tol);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function perpDist(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}
function dropCollinear(ring: readonly Pt2[], tol: number): Pt2[] {
  const n = ring.length;
  if (n < 3) return [...ring];
  const out: Pt2[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n], b = ring[i], c = ring[(i + 1) % n];
    if (perpDist(b, a, c) > tol) out.push(b);
  }
  return out.length >= 3 ? out : [...ring];
}
