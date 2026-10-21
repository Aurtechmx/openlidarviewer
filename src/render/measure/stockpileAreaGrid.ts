/**
 * stockpileAreaGrid.ts — AREA-weighted stockpile volume (method
 * `olv.volume.stockpile-area-grid`).
 *
 * The legacy estimator (`volumeCutFill`) integrates V = A·mean(height over the
 * N points inside the footprint). That weights each POINT equally, so a denser
 * region of the cloud counts for more horizontal area than a sparse one — it is
 * unbiased only when point sampling is spatially uniform, which real scans are
 * not (density gradients, overlap, occlusion, missing patches). See the bias
 * characterised in `tests/volumeSyntheticTruth.test.ts`.
 *
 * This module integrates over horizontal AREA instead:
 *
 *   V_fill = Σ_c A_c · max(0, z_surf,c − z_base,c)
 *   V_cut  = Σ_c A_c · max(0, z_base,c − z_surf,c)
 *
 * where each cell `c` of a regular horizontal grid contributes its polygon-clipped
 * area A_c and a robust (median) surface height from the points that fall in it.
 * Every cell counts once, regardless of how many points sampled it, so a density
 * difference between cells no longer weights the result. Within a cell it can
 * still bias it: the median is the area-average height only when the points
 * are spread evenly over the cell or the surface is flat inside it
 * (tests/stockpileWithinCellSampling.test.ts). Cells with too little support are NOT
 * interpolated to zero — they are recorded as unobserved and reduce the reported
 * coverage, so a footprint with a hole cannot masquerade as a full measurement.
 *
 * Pure, deterministic, no DOM. Operates in the source linear unit of the input
 * coordinates; `linearUnitToMetres` converts the reported volume/area to
 * metres/m³ so a foot-unit and a metre representation of the same pile agree.
 *
 * SCOPE: this is the analytically-verified integration core. Uncertainty is
 * reported as an explicit, deliberately INCOMPLETE model (a surface-spread term
 * only) rather than a validated interval — see {@link StockpileAreaGridResult}.
 */

import { anchoredShoelace } from './polygonHygiene';
import { methodRef, methodTag } from '../../science/methodRegistry';

/**
 * The method tag stamped on every result, DERIVED from METHOD_REGISTRY rather
 * than written out. The registry moved this estimator to v2 (concave-footprint
 * cell exclusion, tilted base evaluated at each clipped cell centroid) while
 * three literals here still read `@1`, so a v2 figure carried v1 provenance,
 * which the registry entry states does not mean the same thing. Deriving it
 * means the next version bump reaches the results instead of stopping at the
 * registry.
 */
const METHOD: StockpileAreaGridMethod = methodTag(
  methodRef('olv.volume.stockpile-area-grid'),
) as StockpileAreaGridMethod;

/** The registered id with whatever version the registry currently declares. */
export type StockpileAreaGridMethod = `olv.volume.stockpile-area-grid@${number}`;

export interface AreaGridPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Points packed as interleaved x,y,z (`xyz.length >= 3·count`). Lets a caller
 * with millions of points avoid one JS object per point.
 */
export interface PackedAreaGridPoints {
  readonly xyz: Float64Array;
  readonly count: number;
}

/** A 2D footprint vertex in the same frame as the points. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** The base surface the pile sits on. */
export type StockpileBase =
  /** A single base elevation for the whole footprint. */
  | { readonly kind: 'constant'; readonly zM: number }
  /** A tilted plane z = a·x + b·y + c (coefficients in the source frame). */
  | { readonly kind: 'plane'; readonly a: number; readonly b: number; readonly c: number };

export interface StockpileAreaGridInput {
  /** Cloud points inside or near the footprint, projected to (x, y) + height z. */
  readonly points: ReadonlyArray<AreaGridPoint> | PackedAreaGridPoints;
  /** The stockpile footprint, in placement order, same 2D frame as the points. */
  readonly polygon: ReadonlyArray<Vec2>;
  /** The base surface (constant elevation or a fitted plane). */
  readonly base: StockpileBase;
  /**
   * Grid cell size in the source unit. When omitted, derived from the point
   * spacing (see {@link deriveCellSize}), which is deterministic and never taken
   * from viewport/zoom state.
   */
  readonly cellSizeM?: number;
  /** Minimum points in a cell for its surface to be trusted. Default 1. */
  readonly minSupportPerCell?: number;
  /** Metres per source linear unit, for the reported figures. Default 1. */
  readonly linearUnitToMetres?: number;
  /** Optional deterministic bounds on the derived cell size, in source units. */
  readonly minCellSizeM?: number;
  readonly maxCellSizeM?: number;
  /** Max cells across the grid before it is coarsened, so a huge footprint at a
   *  fine resolution cannot allocate without bound. Default 1e6. */
  readonly maxCells?: number;
  /**
   * The caller already kept only points inside `polygon` (as `volumeCutFill`
   * does), so the per-point polygon test can be skipped. Default false.
   */
  readonly pointsInsideFootprint?: boolean;
  /**
   * Fill cells without support by interpolating the covered cell surfaces
   * (inverse-distance weighting over the nearest covered cells), but only
   * where the cell centre lies inside the convex extent of the covered cell
   * centres. Cells outside that extent are never extrapolated: they are
   * excluded and their area reported. Default false.
   */
  readonly interpolateGaps?: boolean;
  /**
   * With `interpolateGaps`: when the share of the footprint that would be
   * interpolated exceeds this fraction, the interpolated heights are not
   * computed (the caller withholds such a volume anyway). The interpolated
   * and excluded shares are still reported; fill/cut then cover observed
   * cells only. Default: no limit.
   */
  readonly maxInterpolatedFraction?: number;
}

/** Per-cell record kept for coverage accounting and diagnostics. */
export interface StockpileCell {
  readonly ix: number;
  readonly iy: number;
  /** Polygon-clipped horizontal area of the cell, source-unit². */
  readonly areaSrc: number;
  /** Robust (median) surface height in the cell, source unit; NaN when unsupported. */
  readonly surfaceZ: number;
  /** Points that fell in the cell. */
  readonly support: number;
  /** Local surface spread (NMAD of the cell heights), source unit; 0 when <2 points. */
  readonly spread: number;
}

export interface StockpileAreaGridResult {
  /** Method id + version, for provenance. */
  readonly method: StockpileAreaGridMethod;
  /** Fill (above base) volume in m³, over SUPPORTED area only. */
  readonly fillM3: number;
  /** Cut (below base) volume in m³, over supported area only. */
  readonly cutM3: number;
  /** Net = fill − cut, m³. */
  readonly netM3: number;
  /** Resolved cell size (source unit) and whether it was derived or given. */
  readonly cellSizeM: number;
  readonly cellSizeDerived: boolean;
  /** Total footprint area, m². */
  readonly polygonAreaM2: number;
  /** Area with sufficient support, m². */
  readonly supportedAreaM2: number;
  /** Area observed with no/low support, m² (footprint minus supported). */
  readonly unobservedAreaM2: number;
  /** supportedArea / polygonArea, 0..1. */
  readonly supportFraction: number;
  /**
   * Supported area whose surface rests on a SINGLE return, m².
   *
   * Such a cell has no estimable spread — `nmad` answers 0 below two values,
   * and that 0 means "not measurable", not "no scatter". It therefore adds
   * area and volume while adding nothing to {@link surfaceTermM3}. Reported so
   * a caller can say how much of the figure stands on one point each.
   */
  readonly singleReturnAreaM2: number;
  /** singleReturnArea / supportedArea, 0..1. */
  readonly singleReturnFraction: number;
  /**
   * Coverage verdict from the support fraction:
   *   'measured'  — high coverage, the headline volume stands;
   *   'preview'   — moderate gaps, treat as low-confidence;
   *   'refused'   — severe gaps, no headline volume should be shown.
   */
  readonly coverage: 'measured' | 'preview' | 'refused';
  /**
   * Uncertainty is an explicit INCOMPLETE model: `surfaceTermM3` propagates the
   * per-cell surface spread only. It does NOT include a base-surface term or a
   * validated coverage-gap term, so it is a lower bound, not a total 1σ. Stated
   * this way rather than reported as a neat but unjustified interval.
   */
  readonly uncertaintyModel: 'incomplete';
  readonly surfaceTermM3: number;
  readonly cells: readonly StockpileCell[];
  /** Footprint area whose surface was interpolated, m² (0 unless `interpolateGaps`). */
  readonly interpolatedAreaM2: number;
  /** interpolatedArea / polygonArea, 0..1. */
  readonly interpolatedFraction: number;
  /**
   * Unsupported footprint area left out of the volume, m²: every gap when
   * interpolation is off, otherwise only gaps outside the covered extent.
   */
  readonly excludedAreaM2: number;
  /** excludedArea / polygonArea, 0..1. */
  readonly excludedFraction: number;
}

const DEFAULT_MIN_CELL = 0.05;
const DEFAULT_MAX_CELL = 50;
const DEFAULT_MAX_CELLS = 1_000_000;
const SPACING_MULTIPLIER = 2.5;
/** Coverage thresholds on the supported-area fraction. */
const MEASURED_MIN = 0.9;
const PREVIEW_MIN = 0.6;

/** Absolute polygon area (shoelace), source-unit². */
function polygonArea(poly: ReadonlyArray<Vec2>): number {
  const n = poly.length;
  if (n < 3) return 0;
  return Math.abs(anchoredShoelace(n, (i) => poly[i].x, (i) => poly[i].y));
}

/**
 * A defensible cell size from the point spacing: mean nearest-neighbour spacing
 * is approximated as sqrt(footprintArea / N) (exact for a uniform grid of N
 * points over the area), scaled up so a cell holds a few points, then clamped.
 * Deterministic and unit-aware; never derived from viewport state.
 */
export function deriveCellSize(
  polygonAreaSrc: number,
  pointCount: number,
  minCell = DEFAULT_MIN_CELL,
  maxCell = DEFAULT_MAX_CELL,
): number {
  if (!(polygonAreaSrc > 0) || pointCount < 1) return maxCell;
  const spacing = Math.sqrt(polygonAreaSrc / pointCount);
  return Math.max(minCell, Math.min(maxCell, spacing * SPACING_MULTIPLIER));
}

/** Median of a numeric array (mutates a copy). Empty → NaN. */
function median(values: Float64Array): number {
  if (values.length === 0) return Number.NaN;
  const s = Float64Array.from(values).sort();
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** NMAD (1.4826 × median absolute deviation). <2 values → 0. */
function nmad(values: Float64Array, med: number): number {
  if (values.length < 2) return 0;
  const dev = values.map((v) => Math.abs(v - med));
  return 1.4826 * median(dev);
}

/** Sutherland–Hodgman clip of `subject` against one axis-aligned half-plane. */
function clipHalfPlane(
  subject: ReadonlyArray<Vec2>,
  inside: (p: Vec2) => boolean,
  intersect: (a: Vec2, b: Vec2) => Vec2,
): Vec2[] {
  const out: Vec2[] = [];
  const n = subject.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const cur = subject[i];
    const prev = subject[(i + n - 1) % n];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

/**
 * The area of `poly` clipped to the axis-aligned cell rectangle
 * [xmin,xmax]×[ymin,ymax], via Sutherland–Hodgman against the four edges. The
 * rectangle is the CONVEX clip window, so an arbitrary (even concave) footprint
 * clips correctly. Returns the clipped area in source-unit².
 */
function clipCellPolygon(
  poly: ReadonlyArray<Vec2>,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): Vec2[] {
  let p: Vec2[] = [...poly];
  const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  });
  // x >= xmin
  p = clipHalfPlane(p, (q) => q.x >= xmin, (a, b) => lerp(a, b, (xmin - a.x) / (b.x - a.x)));
  // x <= xmax
  p = clipHalfPlane(p, (q) => q.x <= xmax, (a, b) => lerp(a, b, (xmax - a.x) / (b.x - a.x)));
  // y >= ymin
  p = clipHalfPlane(p, (q) => q.y >= ymin, (a, b) => lerp(a, b, (ymin - a.y) / (b.y - a.y)));
  // y <= ymax
  p = clipHalfPlane(p, (q) => q.y <= ymax, (a, b) => lerp(a, b, (ymax - a.y) / (b.y - a.y)));
  return p;
}

/**
 * The area of `poly` clipped to the axis-aligned cell rectangle
 * [xmin,xmax]×[ymin,ymax], via Sutherland–Hodgman against the four edges. The
 * rectangle is the CONVEX clip window, so an arbitrary (even concave) footprint
 * clips correctly. Returns the clipped area in source-unit².
 */
export function clippedCellArea(
  poly: ReadonlyArray<Vec2>,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): number {
  return polygonArea(clipCellPolygon(poly, xmin, ymin, xmax, ymax));
}

/**
 * Centroid of a simple polygon (signed-area weighted formula). Falls back to
 * the plain vertex average for a degenerate (near-zero-area, e.g. collinear)
 * polygon, where the area-weighted formula divides by ~0.
 */
function polygonCentroid(poly: ReadonlyArray<Vec2>): Vec2 {
  const n = poly.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return poly[0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cross = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += cross;
    cx += (poly[j].x + poly[i].x) * cross;
    cy += (poly[j].y + poly[i].y) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    let sx = 0, sy = 0;
    for (const v of poly) { sx += v.x; sy += v.y; }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

/**
 * Point-in-polygon test (ray-crossing / even-odd rule). Boundary-touching
 * points may resolve either way, which is immaterial here — they belong to
 * whichever adjacent cell binning is consistent for the bbox pre-filter.
 */
function pointInPolygon(poly: ReadonlyArray<Vec2>, x: number, y: number): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersects = (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Flag every grid cell a footprint edge can pass through. Each edge is walked
 * in quarter-cell steps and the cell under each step plus its eight neighbours
 * is flagged, so the marking is conservative: a flagged cell may be interior
 * (it is then clipped exactly anyway), an unflagged cell is never crossed.
 */
function markBoundaryCells(
  poly: ReadonlyArray<Vec2>,
  xmin: number,
  ymin: number,
  cell: number,
  nx: number,
  ny: number,
): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const mark = (x: number, y: number): void => {
    const ix = Math.floor((x - xmin) / cell);
    const iy = Math.floor((y - ymin) / cell);
    for (let dy = -1; dy <= 1; dy++) {
      const yy = iy + dy;
      if (yy < 0 || yy >= ny) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = ix + dx;
        if (xx >= 0 && xx < nx) out[yy * nx + xx] = 1;
      }
    }
  };
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.max(1, Math.ceil(len / (cell * 0.25)));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      mark(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }
  return out;
}

/** Convex hull (monotone chain), counter-clockwise, no collinear points. */
function convexHull(pts: ReadonlyArray<Vec2>): Vec2[] {
  if (pts.length < 3) return [...pts];
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Vec2, a: Vec2, b: Vec2): number => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: Vec2[] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Point inside (or on) a counter-clockwise convex polygon. */
function insideConvex(hull: ReadonlyArray<Vec2>, x: number, y: number): boolean {
  const n = hull.length;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < -1e-12) return false;
  }
  return true;
}

/** The eight grid directions searched by {@link idwFill}. */
const OCTANT_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
];

/**
 * Chebyshev distance (in cells) up to which a gap is filled by the exact
 * square-ring search; deeper gaps use the eight-direction search. The ring
 * search costs O(r) per gap here (two ring perimeters), so the cap bounds it
 * by a constant and keeps the whole fill O(nx·ny).
 */
const RING_SEARCH_MAX = 8;

/**
 * Inverse-distance-weighted surface for every unsupported cell of an `nx×ny`
 * grid whose covered cells hold a finite `surf` value (NaN elsewhere). Cells
 * are addressed by integer (ix, iy); d is the Euclidean distance between cell
 * centres in cell units and every weight is w = 1/d². Estimator
 * (olv.volume.stockpile-area-grid v4), with r(g) the Chebyshev distance from
 * gap g to the nearest covered cell (exact, by multi-source 8-connected BFS):
 *
 *   • r(g) ≤ RING_SEARCH_MAX (near a covered cell — almost every gap in a
 *     real scan): S(g) = every covered cell at Chebyshev distance r(g) or
 *     r(g)+1 from g, i.e. the nearest square ring holding any covered cell
 *     plus one more, so a single neighbour never decides a cell alone.
 *   • r(g) > RING_SEARCH_MAX (deep inside a large void): S(g) = along each of
 *     the 8 grid directions (±x, ±y, both diagonals) the first covered cell
 *     met walking outward from g, plus the BFS-nearest covered cell when it
 *     is not on one of those rays (ties broken by the fixed BFS order), so
 *     S(g) is never empty. This is an octant search: it brackets the void
 *     from every side instead of enumerating O(r²) ring cells.
 *
 *   ẑ(g) = Σ_{c∈S(g)} z_c / d²(g,c)  /  Σ_{c∈S(g)} 1 / d²(g,c)
 *
 * Every term is an observed surface; the caller fills only cells inside the
 * convex extent of the covered centres (no extrapolation) and never zero-fills.
 * Cost O(nx·ny): one BFS, eight linear sweeps that carry "the last covered
 * cell seen", and a constant-bounded ring sum. Widening rings for every gap
 * would cost O(K·R²) for a void of K cells and radius R.
 */
function idwFill(surf: Float64Array, nx: number, ny: number): Float64Array {
  const n = nx * ny;
  const out = new Float64Array(n).fill(Number.NaN);
  // Nearest covered cell and Chebyshev distance by multi-source BFS.
  const src = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (Number.isFinite(surf[i])) { src[i] = i; queue[tail++] = i; }
  while (head < tail) {
    const i = queue[head++];
    const ix = i % nx, iy = (i / nx) | 0;
    for (let oy = -1; oy <= 1; oy++) {
      const jy = iy + oy;
      if (jy < 0 || jy >= ny) continue;
      for (let ox = -1; ox <= 1; ox++) {
        const jx = ix + ox;
        if ((ox === 0 && oy === 0) || jx < 0 || jx >= nx) continue;
        const j = jy * nx + jx;
        if (src[j] >= 0) continue;
        src[j] = src[i];
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }
  }

  // Near gaps: the exact two-ring search, bounded by RING_SEARCH_MAX.
  let deep = false;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(surf[i]) || src[i] < 0) continue;
    const r0 = dist[i];
    if (r0 > RING_SEARCH_MAX) { deep = true; continue; }
    const gx = i % nx, gy = (i / nx) | 0;
    let wSum = 0, zSum = 0;
    for (let r = r0; r <= r0 + 1; r++) {
      for (let jy = gy - r; jy <= gy + r; jy++) {
        if (jy < 0 || jy >= ny) continue;
        const edge = jy === gy - r || jy === gy + r;
        for (let jx = gx - r; jx <= gx + r; jx += edge ? 1 : 2 * r) {
          if (jx < 0 || jx >= nx) continue;
          const z = surf[jy * nx + jx];
          if (!Number.isFinite(z)) continue;
          const w = 1 / ((jx - gx) ** 2 + (jy - gy) ** 2);
          wSum += w;
          zSum += w * z;
        }
      }
    }
    if (wSum > 0) out[i] = zSum / wSum;
  }
  if (!deep) return out;

  // Deep gaps: eight-direction (octant) search.
  const wSum = new Float64Array(n);
  const zSum = new Float64Array(n);
  const near = new Int32Array(n);
  const isDeep = (i: number): boolean => src[i] >= 0 && dist[i] > RING_SEARCH_MAX && !Number.isFinite(surf[i]);
  const addTerm = (i: number, j: number): void => {
    const dx = (i % nx) - (j % nx);
    const dy = ((i / nx) | 0) - ((j / nx) | 0);
    const w = 1 / (dx * dx + dy * dy);
    wSum[i] += w;
    zSum[i] += w * surf[j];
  };
  for (const [dx, dy] of OCTANT_DIRS) {
    // near[i] = first covered cell strictly beyond i in direction (dx, dy).
    const y0 = dy > 0 ? ny - 1 : 0, y1 = dy > 0 ? -1 : ny, ys = dy > 0 ? -1 : 1;
    const x0 = dx > 0 ? nx - 1 : 0, x1 = dx > 0 ? -1 : nx, xs = dx > 0 ? -1 : 1;
    for (let iy = y0; iy !== y1; iy += ys) {
      for (let ix = x0; ix !== x1; ix += xs) {
        const jx = ix + dx, jy = iy + dy;
        let v = -1;
        if (jx >= 0 && jx < nx && jy >= 0 && jy < ny) {
          const j = jy * nx + jx;
          v = Number.isFinite(surf[j]) ? j : near[j];
        }
        const i = iy * nx + ix;
        near[i] = v;
        if (v >= 0 && isDeep(i)) addTerm(i, v);
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (!isDeep(i)) continue;
    // The BFS-nearest cell lies on a ray from i only when its offset is axial
    // or diagonal, and then it is the first covered cell on that ray.
    const s = src[i];
    const dx = Math.abs((i % nx) - (s % nx));
    const dy = Math.abs(((i / nx) | 0) - ((s / nx) | 0));
    if (!(dx === 0 || dy === 0 || dx === dy)) addTerm(i, s);
    if (wSum[i] > 0) out[i] = zSum[i] / wSum[i];
  }
  return out;
}

function baseZ(base: StockpileBase, x: number, y: number): number {
  return base.kind === 'constant' ? base.zM : base.a * x + base.b * y + base.c;
}

/**
 * Integrate the stockpile volume by area-weighted cells. See the module header.
 */
export function stockpileAreaGrid(input: StockpileAreaGridInput): StockpileAreaGridResult {
  const unit = input.linearUnitToMetres && input.linearUnitToMetres > 0 ? input.linearUnitToMetres : 1;
  const minSupport = Math.max(1, Math.floor(input.minSupportPerCell ?? 1));
  const minCell = input.minCellSizeM ?? DEFAULT_MIN_CELL;
  const maxCell = input.maxCellSizeM ?? DEFAULT_MAX_CELL;
  const maxCells = input.maxCells ?? DEFAULT_MAX_CELLS;
  const polyAreaSrc = polygonArea(input.polygon);

  // Footprint bounding box.
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const v of input.polygon) {
    if (v.x < xmin) xmin = v.x;
    if (v.y < ymin) ymin = v.y;
    if (v.x > xmax) xmax = v.x;
    if (v.y > ymax) ymax = v.y;
  }
  const emptyResult = (): StockpileAreaGridResult => ({
    method: METHOD,
    fillM3: 0, cutM3: 0, netM3: 0,
    cellSizeM: input.cellSizeM ?? maxCell, cellSizeDerived: input.cellSizeM == null,
    polygonAreaM2: polyAreaSrc * unit * unit,
    supportedAreaM2: 0, unobservedAreaM2: polyAreaSrc * unit * unit, supportFraction: 0,
    singleReturnAreaM2: 0, singleReturnFraction: 0,
    coverage: 'refused', uncertaintyModel: 'incomplete', surfaceTermM3: 0, cells: [],
    interpolatedAreaM2: 0, interpolatedFraction: 0,
    excludedAreaM2: polyAreaSrc * unit * unit, excludedFraction: polyAreaSrc > 0 ? 1 : 0,
  });
  if (!(polyAreaSrc > 0) || !Number.isFinite(xmin)) return emptyResult();

  // Uniform read access to either point representation.
  const packed = 'xyz' in input.points ? input.points : null;
  const objs = packed ? null : (input.points as ReadonlyArray<AreaGridPoint>);
  const pointCount = packed ? packed.count : objs!.length;
  const px = (i: number): number => (packed ? packed.xyz[i * 3] : objs![i].x);
  const py = (i: number): number => (packed ? packed.xyz[i * 3 + 1] : objs![i].y);
  const pz = (i: number): number => (packed ? packed.xyz[i * 3 + 2] : objs![i].z);
  let cell = input.cellSizeM ?? deriveCellSize(polyAreaSrc, pointCount, minCell, maxCell);
  const cellDerived = input.cellSizeM == null;
  // A caller-supplied cell size of zero is not nullish, so it survived the
  // `??` above and then made the coarsening loop below multiply zero by two
  // forever. A size that is not a positive finite number describes no grid.
  if (!(cell > 0) || !Number.isFinite(cell)) return emptyResult();
  // Coarsen deterministically if the grid would exceed the cell budget.
  const spanX = xmax - xmin;
  const spanY = ymax - ymin;
  const cellsAt = (c: number): number => (Math.ceil(spanX / c) + 1) * (Math.ceil(spanY / c) + 1);
  // The budget is a memory bound and `maxCell` is a resolution preference, so
  // the budget wins. Guarding the loop with `cell < maxCell` defeated it in
  // exactly the case it exists for: `deriveCellSize` already clamps to
  // `maxCell`, so on a large footprint the loop never ran and the grid
  // allocated the full `nx*ny` — 16 million cells on a 200 km square, on the
  // main thread. Coarsening past the preferred maximum is the lesser answer.
  while (cellsAt(cell) > maxCells) cell *= 2;

  const nx = Math.max(1, Math.ceil(spanX / cell));
  const ny = Math.max(1, Math.ceil(spanY / cell));

  // Bin point heights into cells by counting sort: one cell index per point,
  // then every cell's heights contiguous in one Float64Array. No per-cell or
  // per-point JS objects, so memory is ~12 bytes per point.
  const pointCell = new Int32Array(pointCount);
  const cellStart = new Int32Array(nx * ny + 1);
  for (let i = 0; i < pointCount; i++) {
    pointCell[i] = -1;
    const x = px(i), y = py(i);
    if (x < xmin || x > xmax || y < ymin || y > ymax) continue;
    // The bounding-box test above is a cheap pre-filter only; a concave
    // footprint can have bbox-inside points that sit outside the actual
    // polygon (e.g. in the notch of an L-shape), which would otherwise
    // corrupt the surface of whichever cell they land in.
    if (!input.pointsInsideFootprint && !pointInPolygon(input.polygon, x, y)) continue;
    const ix = Math.min(nx - 1, Math.floor((x - xmin) / cell));
    const iy = Math.min(ny - 1, Math.floor((y - ymin) / cell));
    const k = iy * nx + ix;
    pointCell[i] = k;
    cellStart[k + 1]++;
  }
  for (let k = 0; k < nx * ny; k++) cellStart[k + 1] += cellStart[k];
  const binned = new Float64Array(cellStart[nx * ny]);
  {
    const cursor = cellStart.slice(0, nx * ny);
    for (let i = 0; i < pointCount; i++) {
      const k = pointCell[i];
      if (k >= 0) binned[cursor[k]++] = pz(i);
    }
  }
  const heightsOf = (k: number): Float64Array => binned.subarray(cellStart[k], cellStart[k + 1]);

  const cells: StockpileCell[] = [];
  /** Unsupported cells inside the footprint, with their clipped centroid. */
  const gaps: Array<{ ix: number; iy: number; areaSrc: number; cx: number; cy: number }> = [];
  let fillSrc = 0;
  let cutSrc = 0;
  let supportedAreaSrc = 0;
  let singleReturnAreaSrc = 0;
  let surfaceVarM6 = 0; // Σ (A_c·σ_c)² in metre units, for the surface term.

  // Cells a footprint edge can touch are clipped exactly; every other cell is
  // wholly inside or wholly outside, decided by its centre. Clipping every
  // cell against a many-vertex lasso was O(cells x vertices) with allocation.
  const boundary = markBoundaryCells(input.polygon, xmin, ymin, cell, nx, ny);

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cx0 = xmin + ix * cell;
      const cy0 = ymin + iy * cell;
      const cx1 = Math.min(cx0 + cell, xmax);
      const cy1 = Math.min(cy0 + cell, ymax);
      let clipped: ReadonlyArray<Vec2>;
      let areaSrc: number;
      if (boundary[iy * nx + ix] === 1) {
        clipped = clipCellPolygon(input.polygon, cx0, cy0, cx1, cy1);
        areaSrc = polygonArea(clipped);
      } else if (pointInPolygon(input.polygon, (cx0 + cx1) / 2, (cy0 + cy1) / 2)) {
        clipped = [{ x: cx0, y: cy0 }, { x: cx1, y: cy0 }, { x: cx1, y: cy1 }, { x: cx0, y: cy1 }];
        areaSrc = (cx1 - cx0) * (cy1 - cy0);
      } else {
        continue;
      }
      if (areaSrc <= 0) continue; // cell outside the footprint
      const hs = heightsOf(iy * nx + ix);
      if (hs.length < minSupport) {
        // Observed-but-unsupported: recorded, NOT interpolated to zero.
        cells.push({ ix, iy, areaSrc, surfaceZ: Number.NaN, support: hs.length, spread: 0 });
        const c = polygonCentroid(clipped);
        gaps.push({ ix, iy, areaSrc, cx: c.x, cy: c.y });
        continue;
      }
      const med = median(hs);
      const spread = nmad(hs, med);
      // A linear base plane's mean over a region equals the plane evaluated
      // at the region's centroid. For a boundary cell the clipped polygon
      // (not the full grid-cell square) IS the region actually inside the
      // footprint, so the base must be sampled at ITS centroid — the plain
      // cell-centre is only correct for a full interior cell, where the two
      // coincide.
      const { x: bcx, y: bcy } = polygonCentroid(clipped);
      const bz = baseZ(input.base, bcx, bcy);
      const dz = med - bz;
      if (dz >= 0) fillSrc += areaSrc * dz;
      else cutSrc += areaSrc * -dz;
      supportedAreaSrc += areaSrc;
      // A cell holding ONE return has no spread to estimate: `nmad` answers 0
      // for fewer than two values, and 0 is not "no scatter", it is "not
      // measurable". Such a cell takes that single z as its surface, claims
      // the whole cell's area at that height, and contributes exactly nothing
      // to the surface term — so one bird or powerline return can add real
      // volume with no uncertainty attached to it at all. Nothing about the
      // answer changes here: the volume, the support fraction and the coverage
      // verdict are exactly what they were. What is added is the ACCOUNTING —
      // how much of the supported area rests on one return each — so a caller
      // can say it. Demoting such a footprint was tried and reverted: a
      // thinly sampled half of a pile is a density difference between cells,
      // which this method exists to be invariant to, and a test said so.
      if (hs.length < 2) singleReturnAreaSrc += areaSrc;
      // Surface-term variance: (A_c[m²]·σ_c[m])², σ_c = spread/√support. That is
      // the standard-error form of a MEAN applied to a cell MEDIAN (a median's is
      // about √(π/2) ≈ 1.25× larger for normal noise), so the band is an
      // uncalibrated surface-spread diagnostic; repro M3 measures its coverage.
      const aM2 = areaSrc * unit * unit;
      const sigmaM = (spread * unit) / Math.sqrt(hs.length);
      surfaceVarM6 += (aM2 * sigmaM) * (aM2 * sigmaM);
      cells.push({ ix, iy, areaSrc, surfaceZ: med, support: hs.length, spread });
    }
  }

  // Gap filling. Interpolated cells add volume but never support: the
  // coverage verdict and the support fraction stay statements about what was
  // observed, and the interpolated share is reported beside them.
  let interpolatedAreaSrc = 0;
  let excludedAreaSrc = 0;
  if (input.interpolateGaps && gaps.length > 0) {
    const surf = new Float64Array(nx * ny).fill(Number.NaN);
    const centres: Vec2[] = [];
    for (const c of cells) {
      if (Number.isFinite(c.surfaceZ)) {
        surf[c.iy * nx + c.ix] = c.surfaceZ;
        centres.push({ x: xmin + (c.ix + 0.5) * cell, y: ymin + (c.iy + 0.5) * cell });
      }
    }
    const hull = convexHull(centres);
    // Pass 1 (cheap): which gaps lie inside the convex extent of the covered
    // cell centres. Only those may be filled; the rest are excluded.
    const fillable: number[] = [];
    let fillableAreaSrc = 0;
    for (let k = 0; k < gaps.length; k++) {
      const g = gaps[k];
      const gx = xmin + (g.ix + 0.5) * cell;
      const gy = ymin + (g.iy + 0.5) * cell;
      if (hull.length < 3 || !insideConvex(hull, gx, gy)) {
        excludedAreaSrc += g.areaSrc;
      } else {
        fillable.push(k);
        fillableAreaSrc += g.areaSrc;
      }
    }
    interpolatedAreaSrc = fillableAreaSrc;
    const limit = input.maxInterpolatedFraction;
    // A result whose interpolated share exceeds the caller's withhold limit is
    // withheld whatever the interpolated heights are, so they are not
    // computed: the shares are reported, the volume covers observed cells only.
    const skip = limit != null && polyAreaSrc > 0 && fillableAreaSrc / polyAreaSrc > limit;
    if (!skip && fillable.length > 0) {
      const est = idwFill(surf, nx, ny);
      for (const k of fillable) {
        const g = gaps[k];
        const z = est[g.iy * nx + g.ix];
        const dz = z - baseZ(input.base, g.cx, g.cy);
        if (dz >= 0) fillSrc += g.areaSrc * dz;
        else cutSrc += g.areaSrc * -dz;
      }
    }
  } else {
    for (const g of gaps) excludedAreaSrc += g.areaSrc;
  }

  const polygonAreaM2 = polyAreaSrc * unit * unit;
  const supportedAreaM2 = supportedAreaSrc * unit * unit;
  const singleReturnAreaM2 = singleReturnAreaSrc * unit * unit;
  const singleReturnFraction = supportedAreaM2 > 0 ? Math.min(1, singleReturnAreaM2 / supportedAreaM2) : 0;
  const supportFraction = polygonAreaM2 > 0 ? Math.min(1, supportedAreaM2 / polygonAreaM2) : 0;

  // Coverage stays a statement about AREA OBSERVED, deliberately. Demoting a
  // sparse-but-complete footprint would contradict the property this method
  // exists for: a density difference between cells must not move the answer,
  // and a thinly sampled half of a pile is exactly that difference. What the single-return
  // share affects is the UNCERTAINTY, which is reported separately and is
  // already declared incomplete.
  const coverage: StockpileAreaGridResult['coverage'] =
    supportFraction >= MEASURED_MIN ? 'measured' : supportFraction >= PREVIEW_MIN ? 'preview' : 'refused';
  const unitVol = unit * unit * unit;

  return {
    method: METHOD,
    fillM3: fillSrc * unitVol,
    cutM3: cutSrc * unitVol,
    netM3: (fillSrc - cutSrc) * unitVol,
    cellSizeM: cell,
    cellSizeDerived: cellDerived,
    polygonAreaM2,
    supportedAreaM2,
    unobservedAreaM2: Math.max(0, polygonAreaM2 - supportedAreaM2),
    supportFraction,
    singleReturnAreaM2,
    singleReturnFraction,
    coverage,
    uncertaintyModel: 'incomplete',
    surfaceTermM3: Math.sqrt(surfaceVarM6),
    cells,
    interpolatedAreaM2: interpolatedAreaSrc * unit * unit,
    interpolatedFraction: polyAreaSrc > 0 ? Math.min(1, interpolatedAreaSrc / polyAreaSrc) : 0,
    excludedAreaM2: excludedAreaSrc * unit * unit,
    excludedFraction: polyAreaSrc > 0 ? Math.min(1, excludedAreaSrc / polyAreaSrc) : 0,
  };
}
