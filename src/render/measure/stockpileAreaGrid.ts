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
 * gradient no longer biases the result. Cells with too little support are NOT
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

/** A point already projected to the horizontal plane: map x/y plus height z. */
export interface AreaGridPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
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
  readonly points: ReadonlyArray<AreaGridPoint>;
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
  readonly method: 'olv.volume.stockpile-area-grid@1';
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
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  }
  return Math.abs(s) * 0.5;
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
function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** NMAD (1.4826 × median absolute deviation). <2 values → 0. */
function nmad(values: number[], med: number): number {
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
export function clippedCellArea(
  poly: ReadonlyArray<Vec2>,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): number {
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
  return polygonArea(p);
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
    method: 'olv.volume.stockpile-area-grid@1',
    fillM3: 0, cutM3: 0, netM3: 0,
    cellSizeM: input.cellSizeM ?? maxCell, cellSizeDerived: input.cellSizeM == null,
    polygonAreaM2: polyAreaSrc * unit * unit,
    supportedAreaM2: 0, unobservedAreaM2: polyAreaSrc * unit * unit, supportFraction: 0,
    coverage: 'refused', uncertaintyModel: 'incomplete', surfaceTermM3: 0, cells: [],
  });
  if (!(polyAreaSrc > 0) || !Number.isFinite(xmin)) return emptyResult();

  let cell = input.cellSizeM ?? deriveCellSize(polyAreaSrc, input.points.length, minCell, maxCell);
  const cellDerived = input.cellSizeM == null;
  // Coarsen deterministically if the grid would exceed the cell budget.
  const spanX = xmax - xmin;
  const spanY = ymax - ymin;
  const cellsAt = (c: number): number => (Math.ceil(spanX / c) + 1) * (Math.ceil(spanY / c) + 1);
  while (cell < maxCell && cellsAt(cell) > maxCells) cell *= 2;

  const nx = Math.max(1, Math.ceil(spanX / cell));
  const ny = Math.max(1, Math.ceil(spanY / cell));

  // Bin point heights into cells.
  const heights: number[][] = Array.from({ length: nx * ny }, () => []);
  for (const p of input.points) {
    if (p.x < xmin || p.x > xmax || p.y < ymin || p.y > ymax) continue;
    const ix = Math.min(nx - 1, Math.floor((p.x - xmin) / cell));
    const iy = Math.min(ny - 1, Math.floor((p.y - ymin) / cell));
    heights[iy * nx + ix].push(p.z);
  }

  const cells: StockpileCell[] = [];
  let fillSrc = 0;
  let cutSrc = 0;
  let supportedAreaSrc = 0;
  let surfaceVarM6 = 0; // Σ (A_c·σ_c)² in metre units, for the surface term.

  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const cx0 = xmin + ix * cell;
      const cy0 = ymin + iy * cell;
      const areaSrc = clippedCellArea(input.polygon, cx0, cy0, Math.min(cx0 + cell, xmax), Math.min(cy0 + cell, ymax));
      if (areaSrc <= 0) continue; // cell outside the footprint
      const hs = heights[iy * nx + ix];
      if (hs.length < minSupport) {
        // Observed-but-unsupported: recorded, NOT interpolated to zero.
        cells.push({ ix, iy, areaSrc, surfaceZ: Number.NaN, support: hs.length, spread: 0 });
        continue;
      }
      const med = median(hs);
      const spread = nmad(hs, med);
      const bz = baseZ(input.base, cx0 + cell / 2, cy0 + cell / 2);
      const dz = med - bz;
      if (dz >= 0) fillSrc += areaSrc * dz;
      else cutSrc += areaSrc * -dz;
      supportedAreaSrc += areaSrc;
      // Surface-term variance: (A_c[m²]·σ_c[m])², σ_c = spread/√support (SEM).
      const aM2 = areaSrc * unit * unit;
      const sigmaM = (spread * unit) / Math.sqrt(hs.length);
      surfaceVarM6 += (aM2 * sigmaM) * (aM2 * sigmaM);
      cells.push({ ix, iy, areaSrc, surfaceZ: med, support: hs.length, spread });
    }
  }

  const polygonAreaM2 = polyAreaSrc * unit * unit;
  const supportedAreaM2 = supportedAreaSrc * unit * unit;
  const supportFraction = polygonAreaM2 > 0 ? Math.min(1, supportedAreaM2 / polygonAreaM2) : 0;
  const coverage: StockpileAreaGridResult['coverage'] =
    supportFraction >= MEASURED_MIN ? 'measured' : supportFraction >= PREVIEW_MIN ? 'preview' : 'refused';
  const unitVol = unit * unit * unit;

  return {
    method: 'olv.volume.stockpile-area-grid@1',
    fillM3: fillSrc * unitVol,
    cutM3: cutSrc * unitVol,
    netM3: (fillSrc - cutSrc) * unitVol,
    cellSizeM: cell,
    cellSizeDerived: cellDerived,
    polygonAreaM2,
    supportedAreaM2,
    unobservedAreaM2: Math.max(0, polygonAreaM2 - supportedAreaM2),
    supportFraction,
    coverage,
    uncertaintyModel: 'incomplete',
    surfaceTermM3: Math.sqrt(surfaceVarM6),
    cells,
  };
}
