/**
 * contourSheetModel.ts: what a styled contour sheet draws besides the contour
 * lines, worked out once so the PDF and the SVG draw the same thing. Pure: no
 * pdf-lib and no DOM.
 *
 * The input is the analysed terrain grid in the contour model's own frame.
 * From it this module derives:
 *
 * - the footprint: every cell with ground (measured or filled), plus the
 *   cells without ground that the footprint encloses. Cells without ground
 *   that connect to the grid edge are outside the scan and stay blank;
 * - holes: enclosed cells without ground, which the sheet hatches;
 * - the footprint outline as rings in the grid frame;
 * - the relief raster at sheet resolution, transparent outside the footprint
 *   and hatched in holes;
 * - the highest and lowest measured ground, the elevation histogram and the
 *   measured and filled shares of the cells drawn.
 */
import { downsampleGrid, multiLightHillshade, reliefExaggeration, type ReliefGrid } from './relief';
import { tintAt, type SheetRgb, type SheetTokens } from './tokens';
import type { ContourLineKind } from '../../terrain/contour/contourFeatureModel';

/** The analysed terrain grid a styled sheet draws under its contours. */
export interface SheetReliefInput {
  readonly cols: number;
  readonly rows: number;
  /** Cell size in the grid's horizontal unit (the contour model's unit). */
  readonly cellSize: number;
  /** Lower-left corner of cell (0, 0), in the contour model's frame. */
  readonly originX: number;
  readonly originY: number;
  /** Elevation per cell, row 0 the southern row. Read only where coverage > 0. */
  readonly z: ArrayLike<number>;
  /** 0 no ground, 1 filled from nearby measured ground, 2 measured. */
  readonly coverage: ArrayLike<number>;
}

/** Cell states the sheet distinguishes. */
export const CELL_OUTSIDE = 0;
export const CELL_HOLE = 1;
export const CELL_FILLED = 2;
export const CELL_MEASURED = 3;

export interface SpotHeight {
  /** Cell centre in the grid frame. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ContourSheetRelief {
  /** Extent of the footprint in the grid frame. Null when no cell has ground. */
  readonly extent: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } | null;
  /** Footprint outline rings, closed, in the grid frame. */
  readonly outline: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
  /** Elevation range over cells with ground. */
  readonly zMin: number;
  readonly zMax: number;
  /** Highest and lowest MEASURED ground. Null when nothing was measured. */
  readonly highest: SpotHeight | null;
  readonly lowest: SpotHeight | null;
  /** Cell counts inside the footprint. */
  readonly measuredCells: number;
  readonly filledCells: number;
  readonly holeCells: number;
  /** Elevation histogram over cells with ground, `bins` equal bins from zMin to zMax. */
  readonly histogram: readonly number[];
  readonly hasHoles: boolean;
}

/** Classify every cell: outside, hole, filled or measured. */
export function classifyCells(g: SheetReliefInput): Uint8Array {
  const { cols, rows } = g;
  const n = cols * rows;
  const state = new Uint8Array(n);
  // Flood the no-ground cells that reach the grid edge: those are outside.
  const outside = new Uint8Array(n);
  const stack: number[] = [];
  const empty = (i: number): boolean => !(g.coverage[i]! > 0) || !Number.isFinite(g.z[i]!);
  const seed = (i: number): void => {
    if (!outside[i] && empty(i)) { outside[i] = 1; stack.push(i); }
  };
  for (let c = 0; c < cols; c++) { seed(c); seed((rows - 1) * cols + c); }
  for (let r = 0; r < rows; r++) { seed(r * cols); seed(r * cols + cols - 1); }
  while (stack.length > 0) {
    const i = stack.pop()!;
    const c = i % cols, r = (i - c) / cols;
    if (c > 0) seed(i - 1);
    if (c < cols - 1) seed(i + 1);
    if (r > 0) seed(i - cols);
    if (r < rows - 1) seed(i + cols);
  }
  for (let i = 0; i < n; i++) {
    if (outside[i]) state[i] = CELL_OUTSIDE;
    else if (empty(i)) state[i] = CELL_HOLE;
    else state[i] = g.coverage[i] === 2 ? CELL_MEASURED : CELL_FILLED;
  }
  return state;
}

/**
 * The footprint's outline as closed rings in the grid frame, traced along cell
 * edges between footprint and outside cells. Holes are inside the footprint,
 * so they get no outline of their own; the hatch marks them.
 */
export function footprintOutline(g: SheetReliefInput, state: Uint8Array): Array<Array<[number, number]>> {
  const { cols, rows, cellSize: s, originX: ox, originY: oy } = g;
  const inside = (c: number, r: number): boolean => c >= 0 && r >= 0 && c < cols && r < rows && state[r * cols + c] !== CELL_OUTSIDE;
  // Directed edges with the footprint on the left, keyed by start vertex.
  const next = new Map<number, number[]>();
  const key = (vx: number, vy: number): number => vy * (cols + 1) + vx;
  const add = (ax: number, ay: number, bx: number, by: number): void => {
    const k = key(ax, ay);
    const list = next.get(k);
    if (list) list.push(key(bx, by)); else next.set(k, [key(bx, by)]);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!inside(c, r)) continue;
      if (!inside(c, r - 1)) add(c, r, c + 1, r); // south edge, eastwards
      if (!inside(c + 1, r)) add(c + 1, r, c + 1, r + 1); // east edge, northwards
      if (!inside(c, r + 1)) add(c + 1, r + 1, c, r + 1); // north edge, westwards
      if (!inside(c - 1, r)) add(c, r + 1, c, r); // west edge, southwards
    }
  }
  const rings: Array<Array<[number, number]>> = [];
  const starts = [...next.keys()].sort((a, b) => a - b);
  for (const start of starts) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const ring: Array<[number, number]> = [];
      let k = start;
      for (let guard = 0; guard < 4 * (cols + 1) * (rows + 1); guard++) {
        const vx = k % (cols + 1), vy = (k - vx) / (cols + 1);
        ring.push([ox + vx * s, oy + vy * s]);
        const list = next.get(k);
        if (!list || list.length === 0) break;
        k = list.shift()!;
        if (k === start) break;
      }
      rings.push(simplifyRing(dropCollinear(ring), 0.6 * s));
    }
  }
  return rings;
}

/**
 * Douglas-Peucker on a closed ring. The cell-edge trace is a staircase; a
 * tolerance under one cell turns it into the footprint's shape without moving
 * the line more than that from the cells it bounds.
 */
export function simplifyRing(ring: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (ring.length < 5 || !(tol > 0)) return ring;
  // Split at the vertex farthest from the first, so both halves are open polylines.
  let far = 0, best = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = (ring[i]![0] - ring[0]![0]) ** 2 + (ring[i]![1] - ring[0]![1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  const a = dp(ring.slice(0, far + 1), tol);
  const b = dp([...ring.slice(far), ring[0]!], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : ring;
}

function dp(pts: Array<[number, number]>, tol: number): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!;
    const [x0, y0] = pts[i0]!, [x1, y1] = pts[i1]!;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    let maxD = -1, at = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const d = Math.abs(dy * (pts[i]![0] - x0) - dx * (pts[i]![1] - y0)) / len;
      if (d > maxD) { maxD = d; at = i; }
    }
    if (maxD > tol && at > 0) {
      keep[at] = 1;
      stack.push([i0, at], [at, i1]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Removes vertices that lie on the straight line between their neighbours. */
function dropCollinear(ring: Array<[number, number]>): Array<[number, number]> {
  if (ring.length < 4) return ring;
  const out: Array<[number, number]> = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]!, b = ring[i]!, c = ring[(i + 1) % n]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-12) out.push(b);
  }
  return out.length >= 3 ? out : ring;
}

/** Everything the sheet draws from the grid except the raster. */
export function contourSheetRelief(g: SheetReliefInput, bins = 40): ContourSheetRelief {
  const state = classifyCells(g);
  const { cols, rows, cellSize: s, originX: ox, originY: oy } = g;
  let zMin = Infinity, zMax = -Infinity;
  let measuredCells = 0, filledCells = 0, holeCells = 0;
  let hi: SpotHeight | null = null, lo: SpotHeight | null = null;
  let minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const st = state[i]!;
      if (st === CELL_OUTSIDE) continue;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      if (st === CELL_HOLE) { holeCells++; continue; }
      const z = g.z[i]!;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
      if (st === CELL_FILLED) { filledCells++; continue; }
      measuredCells++;
      const p = { x: ox + (c + 0.5) * s, y: oy + (r + 0.5) * s, z };
      if (!hi || z > hi.z) hi = p;
      if (!lo || z < lo.z) lo = p;
    }
  }
  const histogram = new Array<number>(bins).fill(0);
  if (zMax > zMin) {
    for (let i = 0; i < cols * rows; i++) {
      const st = state[i]!;
      if (st !== CELL_FILLED && st !== CELL_MEASURED) continue;
      const b = Math.min(bins - 1, Math.floor(((g.z[i]! - zMin) / (zMax - zMin)) * bins));
      histogram[b]!++;
    }
  } else if (measuredCells + filledCells > 0) histogram[0] = measuredCells + filledCells;
  const extent = Number.isFinite(minC)
    ? { minX: ox + minC * s, minY: oy + minR * s, maxX: ox + (maxC + 1) * s, maxY: oy + (maxR + 1) * s }
    : null;
  return {
    extent,
    outline: footprintOutline(g, state),
    zMin: Number.isFinite(zMin) ? zMin : Number.NaN,
    zMax: Number.isFinite(zMax) ? zMax : Number.NaN,
    highest: hi,
    lowest: lo,
    measuredCells,
    filledCells,
    holeCells,
    histogram,
    hasHoles: holeCells > 0,
  };
}

export interface SheetRaster {
  readonly width: number;
  readonly height: number;
  /** RGBA, row 0 at the top (north). Transparent outside the footprint. */
  readonly rgba: Uint8Array;
}

/** Longest side of the embedded relief raster, pixels. Keeps a sheet PDF to a few megabytes. */
export const MAX_RASTER_SIDE = 2000;

/** Spacing of the hatch lines drawn in holes, raster pixels. */
const HATCH_SPACING = 7;

/**
 * The relief raster for `area` (a rectangle in the grid frame), `width` by
 * `height` pixels. Shade and elevation are interpolated bilinearly between
 * cells with ground, so the relief does not show the grid's blocks when the
 * raster is finer than the grid. Holes are drawn as the style's no-data colour
 * with diagonal hatch lines; outside cells are transparent.
 */
export function contourSheetRaster(
  g: SheetReliefInput,
  tokens: SheetTokens,
  area: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number },
  width: number,
  height: number,
  zRange?: readonly [number, number],
): SheetRaster {
  const W = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(width)));
  const H = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(height)));
  const sx = (area.maxX - area.minX) / W, sy = (area.maxY - area.minY) / H;
  return reliefRaster(g, tokens, W, H, (px, py) => [area.minX + (px + 0.5) * sx, area.maxY - (py + 0.5) * sy], zRange);
}

/**
 * A relief raster along a line: pixel column u runs from `u0` to `u1` along
 * the unit direction `dir` from `origin`, and pixel row v from `v1` (top) down
 * to `v0` across it, `perp` being `dir` turned a quarter turn anticlockwise.
 * Used for the profile sheet's plan strip, which is drawn along the profile.
 */
export function stripSheetRaster(
  g: SheetReliefInput,
  tokens: SheetTokens,
  origin: readonly [number, number],
  dir: readonly [number, number],
  u: readonly [number, number],
  v: readonly [number, number],
  width: number,
  height: number,
): SheetRaster {
  const W = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(width)));
  const H = Math.max(1, Math.min(MAX_RASTER_SIDE, Math.round(height)));
  const perp: readonly [number, number] = [-dir[1], dir[0]];
  const su = (u[1] - u[0]) / W, sv = (v[1] - v[0]) / H;
  return reliefRaster(g, tokens, W, H, (px, py) => {
    const uu = u[0] + (px + 0.5) * su, vv = v[1] - (py + 0.5) * sv;
    return [origin[0] + uu * dir[0] + vv * perp[0], origin[1] + uu * dir[1] + vv * perp[1]];
  });
}

function reliefRaster(
  g: SheetReliefInput,
  tokens: SheetTokens,
  W: number,
  H: number,
  at: (px: number, py: number) => readonly [number, number],
  zRange?: readonly [number, number],
): SheetRaster {
  const state = classifyCells(g);
  // Shade on a grid no finer than twice the raster, so a large grid stays quick.
  const base: ReliefGrid = {
    cols: g.cols, rows: g.rows, cellX: g.cellSize, cellY: g.cellSize, z: g.z,
    valid: Uint8Array.from(state, (s) => (s === CELL_FILLED || s === CELL_MEASURED ? 1 : 0)),
  };
  const shadeGrid = downsampleGrid(base, 2 * Math.max(W, H));
  const f = Math.round(shadeGrid.cellX / g.cellSize) || 1;
  const shade = multiLightHillshade(shadeGrid, undefined, reliefExaggeration(shadeGrid));
  let lo = zRange?.[0] ?? Infinity, hi = zRange?.[1] ?? -Infinity;
  if (!zRange) {
    for (let i = 0; i < g.cols * g.rows; i++) {
      const st = state[i]!;
      if (st !== CELL_FILLED && st !== CELL_MEASURED) continue;
      const z = g.z[i]!;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  const span = hi > lo ? hi - lo : 1;
  const sc = shadeGrid.cols, sr = shadeGrid.rows;
  const sValid = shadeGrid.valid!;
  /** Bilinear sample of `arr` on the shade grid at fractional cell coords (u, v); NaN when no neighbour has ground. */
  const sample = (arr: ArrayLike<number>, u: number, v: number): number => {
    const c0 = Math.floor(u - 0.5), r0 = Math.floor(v - 0.5);
    const fx = u - 0.5 - c0, fy = v - 0.5 - r0;
    let sum = 0, wsum = 0;
    for (let dr = 0; dr <= 1; dr++) {
      for (let dc = 0; dc <= 1; dc++) {
        const c = c0 + dc, r = r0 + dr;
        if (c < 0 || r < 0 || c >= sc || r >= sr) continue;
        const i = r * sc + c;
        if (!sValid[i]) continue;
        const w = (dc ? fx : 1 - fx) * (dr ? fy : 1 - fy);
        sum += w * arr[i]!;
        wsum += w;
      }
    }
    return wsum > 1e-9 ? sum / wsum : Number.NaN;
  };
  const rgba = new Uint8Array(W * H * 4);
  const k = tokens.shadeHi - tokens.shadeLo;
  const a = tokens.tintAlpha;
  const nodata = tokens.nodata, hatch = tokens.hatch;
  const put = (o: number, c: SheetRgb): void => {
    rgba[o] = Math.round(c[0] * 255); rgba[o + 1] = Math.round(c[1] * 255); rgba[o + 2] = Math.round(c[2] * 255); rgba[o + 3] = 255;
  };
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const [wx, wy] = at(px, py);
      const gr = (wy - g.originY) / g.cellSize;
      const gc = (wx - g.originX) / g.cellSize;
      const c = Math.floor(gc), r = Math.floor(gr);
      if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
      const st = state[r * g.cols + c]!;
      if (st === CELL_OUTSIDE) continue;
      const o = (py * W + px) * 4;
      if (st === CELL_HOLE) {
        put(o, (px + py) % HATCH_SPACING === 0 ? hatch : nodata);
        continue;
      }
      const s = sample(shade, gc / f, gr / f);
      const z = sample(shadeGrid.z, gc / f, gr / f);
      const grey = tokens.shadeLo + k * Math.min(1, Math.max(0, Number.isFinite(s) ? s : 1));
      const tint = a > 0 && Number.isFinite(z) ? tintAt(tokens, (z - lo) / span) : null;
      const rgb: SheetRgb = tint
        ? [grey * (1 - a) + tint[0] * a, grey * (1 - a) + tint[1] * a, grey * (1 - a) + tint[2] * a]
        : [grey, grey, grey];
      put(o, [Math.min(1, Math.max(0, rgb[0])), Math.min(1, Math.max(0, rgb[1])), Math.min(1, Math.max(0, rgb[2]))]);
    }
  }
  return { width: W, height: H, rgba };
}

/**
 * Raster size for a map frame `wPt` by `hPt` points at `dpi`, capped at
 * {@link MAX_RASTER_SIDE} on the longer side with the aspect kept.
 */
export function rasterSizeFor(wPt: number, hPt: number, dpi = 150): { width: number; height: number } {
  let w = Math.max(1, Math.round((wPt / 72) * dpi));
  let h = Math.max(1, Math.round((hPt / 72) * dpi));
  const k = Math.max(w, h) / MAX_RASTER_SIDE;
  if (k > 1) { w = Math.max(1, Math.round(w / k)); h = Math.max(1, Math.round(h / k)); }
  return { width: w, height: h };
}

/** How one contour run is drawn in a styled sheet. Shared by the map and the legend. */
export interface StyledContourStroke {
  readonly color: SheetRgb;
  readonly width: number;
  readonly dash: readonly number[] | null;
  readonly opacity: number;
}

/**
 * Stroke for a contour by index flag and line kind. Measured ground is solid;
 * sparse measured ground is solid and lighter; contour over filled cells is
 * dashed; a low-confidence gap is dotted and faint. Index lines are heavier,
 * so the kinds read in greyscale as well as in colour.
 */
export function styledContourStroke(t: SheetTokens, isIndex: boolean, kind: ContourLineKind): StyledContourStroke {
  const color = isIndex ? t.index : t.minor;
  const width = isIndex ? t.weight.index : t.weight.minor;
  if (kind === 'measured') return { color, width, dash: null, opacity: 1 };
  if (kind === 'sparse') return { color, width: width * 0.85, dash: null, opacity: 0.7 };
  if (kind === 'interpolated') return { color, width: width * 0.9, dash: t.filledDash.map((d) => d * (isIndex ? 1.6 : 1)), opacity: 0.85 };
  return { color, width: width * 0.8, dash: [0.6, 1.8], opacity: 0.6 };
}
