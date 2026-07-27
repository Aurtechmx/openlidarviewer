/**
 * contourSurfaces.ts
 *
 * Analytic surfaces and geometric predicates for the contour-correctness
 * suite. Everything here is independent of the contour implementation: the
 * predicates re-derive membership, topology and displacement from the source
 * grid and from the emitted coordinates, so a shared bug in the generator
 * cannot make a check pass.
 *
 * Registration: a DTM value z[row*cols+col] is the elevation of the CELL, and
 * the cell centre sits at world (originH1 + (col + 0.5)·cell, originH2 +
 * (row + 0.5)·cell). Marching squares walks the lattice of cell centres, so
 * the traced domain is the rectangle [0.5·cell, (cols − 0.5)·cell] ×
 * [0.5·cell, (rows − 0.5)·cell] offset by the origin. Surface functions here
 * take GRID indices (col, row) so a fixture written against world coordinates
 * must subtract the half-cell itself.
 */

import type { DtmGrid } from '../../src/terrain/ground/cellConfidence';
import type { ContourSet, ContourSegment } from '../../src/terrain/contour/contoursAt';

export interface GridOptions {
  readonly cols: number;
  readonly rows: number;
  readonly cellSizeM?: number;
  readonly originH1?: number;
  readonly originH2?: number;
  readonly crs?: string | null;
  readonly verticalDatum?: string | null;
  readonly verticalUnitToMetres?: number | null;
  /** Confidence per cell; constant 100 unless a function is given. */
  readonly confidenceFn?: (col: number, row: number) => number;
  /** Coverage per cell; constant 2 (measured) unless a function is given. */
  readonly coverageFn?: (col: number, row: number) => number;
}

/** Build a DtmGrid whose cell values are `zfn(col, row)`. */
export function surfaceGrid(
  zfn: (col: number, row: number) => number,
  opts: GridOptions,
): DtmGrid {
  const { cols, rows } = opts;
  const n = cols * rows;
  const z = new Float32Array(n);
  const confidence = new Float32Array(n);
  const coverage = new Uint8Array(n);
  const counts = new Uint32Array(n).fill(1);
  const interpDistanceCells = new Float32Array(n);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      z[i] = zfn(col, row);
      confidence[i] = opts.confidenceFn ? opts.confidenceFn(col, row) : 100;
      coverage[i] = opts.coverageFn ? opts.coverageFn(col, row) : 2;
    }
  }
  return {
    z,
    confidence,
    coverage,
    counts,
    interpDistanceCells,
    cols,
    rows,
    cellSizeM: opts.cellSizeM ?? 1,
    originH1: opts.originH1 ?? 0,
    originH2: opts.originH2 ?? 0,
    crs: opts.crs === undefined ? 'EPSG:32610' : opts.crs,
    verticalDatum: opts.verticalDatum === undefined ? 'EPSG:5703' : opts.verticalDatum,
    verticalUnitToMetres: opts.verticalUnitToMetres ?? 1,
    coverageMode: 'full',
    sourcePointCount: n,
    analyzedPointCount: n,
    meanConfidence: 100,
    warnings: [],
  } as DtmGrid;
}

/** The rectangle marching squares can trace: the lattice of cell centres. */
export function tracedDomain(dtm: DtmGrid): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const h = dtm.cellSizeM;
  return {
    minX: dtm.originH1 + 0.5 * h,
    minY: dtm.originH2 + 0.5 * h,
    maxX: dtm.originH1 + (dtm.cols - 0.5) * h,
    maxY: dtm.originH2 + (dtm.rows - 0.5) * h,
  };
}

/**
 * Bilinear value of the source grid at a world point, evaluated independently
 * of the contour code. Returns NaN outside the traced domain or when any of
 * the four surrounding cells is uncovered or non-finite — the same cells the
 * generator refuses to trace through.
 */
export function bilinearAt(dtm: DtmGrid, x: number, y: number): number {
  const h = dtm.cellSizeM;
  const fx = (x - dtm.originH1) / h - 0.5;
  const fy = (y - dtm.originH2) / h - 0.5;
  const c0 = Math.floor(fx);
  const r0 = Math.floor(fy);
  // A point exactly on the far edge belongs to the last cell block.
  const col = Math.min(Math.max(c0, 0), dtm.cols - 2);
  const row = Math.min(Math.max(r0, 0), dtm.rows - 2);
  if (fx < -1e-9 || fy < -1e-9 || fx > dtm.cols - 1 + 1e-9 || fy > dtm.rows - 1 + 1e-9) {
    return Number.NaN;
  }
  const tx = fx - col;
  const ty = fy - row;
  const i00 = row * dtm.cols + col;
  const i10 = row * dtm.cols + col + 1;
  const i11 = (row + 1) * dtm.cols + col + 1;
  const i01 = (row + 1) * dtm.cols + col;
  for (const i of [i00, i10, i11, i01]) {
    if (dtm.coverage[i] === 0 || !Number.isFinite(dtm.z[i])) return Number.NaN;
  }
  const bottom = dtm.z[i00] + tx * (dtm.z[i10] - dtm.z[i00]);
  const top = dtm.z[i01] + tx * (dtm.z[i11] - dtm.z[i01]);
  return bottom + ty * (top - bottom);
}

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** Every segment of a contour set, tagged with its level value. */
export function allSegments(set: ContourSet): Array<ContourSegment & { value: number }> {
  const out: Array<ContourSegment & { value: number }> = [];
  for (const level of set.levels) {
    for (const s of level.segments) out.push({ ...s, value: level.value });
  }
  return out;
}

/** Every distinct segment endpoint of one level. */
export function levelVertices(set: ContourSet, value: number): Pt[] {
  const out: Pt[] = [];
  for (const level of set.levels) {
    if (level.value !== value) continue;
    for (const s of level.segments) {
      out.push({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
    }
  }
  return out;
}

/**
 * Endpoint-degree parity of one level's segment soup. A level set of a
 * continuous surface has no free ends inside the domain: every interior node
 * is entered as often as it is left, so its degree is even. Odd degree is
 * legal only where the curve leaves through the domain boundary (or through a
 * no-data edge, which the caller supplies as extra allowed points).
 *
 * `quantum` is the endpoint-matching grain; pass the same cell/1000 the
 * stitcher uses so the two agree on what "the same point" means.
 */
export function oddDegreeNodes(
  segments: ReadonlyArray<ContourSegment>,
  quantum: number,
): Pt[] {
  const degree = new Map<string, { pt: Pt; n: number }>();
  const bump = (x: number, y: number) => {
    const k = `${Math.round(x / quantum)}:${Math.round(y / quantum)}`;
    const e = degree.get(k);
    if (e) e.n += 1;
    else degree.set(k, { pt: { x, y }, n: 1 });
  };
  for (const s of segments) {
    bump(s.x1, s.y1);
    bump(s.x2, s.y2);
  }
  const out: Pt[] = [];
  for (const { pt, n } of degree.values()) if (n % 2 === 1) out.push(pt);
  return out;
}

/** Whether a point lies on the boundary of a rectangle, within `tol`. */
export function onRectBoundary(
  p: Pt,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
  tol: number,
): boolean {
  const nearX = Math.abs(p.x - rect.minX) <= tol || Math.abs(p.x - rect.maxX) <= tol;
  const nearY = Math.abs(p.y - rect.minY) <= tol || Math.abs(p.y - rect.maxY) <= tol;
  const inside =
    p.x >= rect.minX - tol &&
    p.x <= rect.maxX + tol &&
    p.y >= rect.minY - tol &&
    p.y <= rect.maxY + tol;
  return inside && (nearX || nearY);
}

/**
 * Proper segment intersection: the two segments cross at a point interior to
 * both. Shared endpoints and collinear touching are NOT reported — contours of
 * one level meet end-to-end by construction, and that is not a crossing.
 */
export function properlyIntersect(
  a1: Pt,
  a2: Pt,
  b1: Pt,
  b2: Pt,
  eps = 1e-12,
): boolean {
  const d = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = d(b1, b2, a1);
  const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1);
  const d4 = d(a1, a2, b2);
  if (Math.abs(d1) <= eps || Math.abs(d2) <= eps || Math.abs(d3) <= eps || Math.abs(d4) <= eps) {
    return false;
  }
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Count proper crossings between two segment lists. */
export function crossingCount(
  a: ReadonlyArray<ContourSegment>,
  b: ReadonlyArray<ContourSegment>,
): number {
  let n = 0;
  for (const s of a) {
    for (const t of b) {
      if (
        properlyIntersect(
          { x: s.x1, y: s.y1 },
          { x: s.x2, y: s.y2 },
          { x: t.x1, y: t.y1 },
          { x: t.x2, y: t.y2 },
        )
      ) {
        n += 1;
      }
    }
  }
  return n;
}

/** Proper self-intersections within one polyline (non-adjacent pairs only). */
export function selfIntersections(coords: ReadonlyArray<readonly [number, number]>): number {
  let n = 0;
  for (let i = 0; i + 1 < coords.length; i++) {
    for (let j = i + 2; j + 1 < coords.length; j++) {
      if (
        properlyIntersect(
          { x: coords[i][0], y: coords[i][1] },
          { x: coords[i + 1][0], y: coords[i + 1][1] },
          { x: coords[j][0], y: coords[j][1] },
          { x: coords[j + 1][0], y: coords[j + 1][1] },
        )
      ) {
        n += 1;
      }
    }
  }
  return n;
}

/** Even-odd point-in-ring test. The ring is treated as implicitly closed. */
export function pointInRing(p: Pt, ring: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > p.y !== yj > p.y;
    if (straddles && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from a point to a polyline (minimum over its segments). */
export function distanceToPolyline(
  p: readonly [number, number],
  line: ReadonlyArray<readonly [number, number]>,
): number {
  if (line.length === 0) return Number.POSITIVE_INFINITY;
  if (line.length === 1) return Math.hypot(p[0] - line[0][0], p[1] - line[0][1]);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < min) min = d;
  }
  return min;
}
