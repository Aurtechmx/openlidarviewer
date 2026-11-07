/**
 * mapPage.ts: the site map (every watershed, the flow network and the studied
 * catchments) and the per-catchment map of the watershed report.
 *
 * The map follows the contour map sheet's conventions (mapSheetPdf.ts): a
 * framed map with edge ticks and coordinate labels, a scale bar whose unit
 * comes from `scaleBarUnit`, an orientation mark that says "local grid up"
 * rather than north when no coordinate system is known, and a legend box.
 *
 * Layers, bottom to top: a warm-grey hillshade raster (NoData white,
 * interpolated ground stippled, watershed fills on the site map, ground
 * outside the catchment washed out on the catchment map), divides in ink
 * dash-dot, the flow network in water blue widening by Strahler order with
 * flow arrows, hollows hatched in terracotta, outlets as terracotta rings and,
 * on the site map, the studied catchments outlined in ink with their labels.
 *
 * The model does not carry the raster, so the caller passes the flow grid,
 * the DTM coverage and the filled-cell mask in `MapLayers`. Geometry is in
 * grid metres from the south-west corner of cell 0, row 0 being the southern
 * row, as divideTrace.ts uses.
 *
 * Deterministic: the same inputs draw the same operations in the same order.
 * Belongs to the report's lazy chunk.
 */
import {
  clip, closePath, endPath, lineTo, moveTo, popGraphicsState, pushGraphicsState, rectangle, rgb,
} from 'pdf-lib';
import type { PDFDocument, PDFPage, RGB } from 'pdf-lib';
import type { FlowGrid } from '../../simulation/flowPulse/flowTypes';
import { hillshade } from '../../simulation/flowPulse/flowHillshade';
import { depressionMembers, type DepressionEntry } from '../../simulation/flowPulse/depressionInventory';
import { douglasPeucker, traceDivide, type Ring } from '../../simulation/flowPulse/watershed/divideTrace';
import type { FlowNetwork } from '../../simulation/flowPulse/watershed/flowNetwork';
import type { WatershedPartition } from '../../simulation/flowPulse/watershed/watershedPartition';
import type {
  CatchmentSection, ReportLanguage, WatershedReportModel,
} from '../../simulation/flowPulse/watershed/watershedReportModel';
import { formatNumber, t } from '../../simulation/flowPulse/watershed/watershedStrings';
import { scaleBarUnit } from '../../render/measure/scaleBar';
import { PALETTE, drawRuns, heading, newPage, widthOf } from './pageKit';
import type { PageCursor } from './pageKit';
import type { ReportFonts } from './reportFonts';
import { decimalsFor, fitSize, niceFloor, niceStep, strokePath, svgPolyline, wrapText } from './charts';

export interface MapLayers {
  readonly partition?: WatershedPartition;
  readonly sections: readonly CatchmentSection[];
  readonly network: FlowNetwork;
  readonly focus?: CatchmentSection;
  /** The run's flow grid: heights for the hillshade and the cell size in metres. */
  readonly grid: FlowGrid;
  /** DTM coverage per cell (0 none, 1 interpolated, 2 measured), for the stipple. */
  readonly coverage: Uint8Array;
  /** The run's filled-cell mask, to draw each hollow's extent; without it a hollow is drawn as a disc of its area. */
  readonly filled?: Uint8Array | null;
  /**
   * Bottom of the map block on the page, in points. When set, the map and its
   * collar fit between the cursor and this line, and the page is never changed.
   */
  readonly bottomY?: number;
  /** The catchment's display name for the heading ("C1 · name"); the label when not given. */
  readonly focusTitle?: string;
}

/** Line width of a studied catchment's outline on the site map. */
export const STUDIED_OUTLINE_WIDTH = 2;
/** Divide line: ink, 1.4 pt, dash-dot. */
export const DIVIDE_DASH: readonly number[] = [7, 2.5, 1.5, 2.5];
const DIVIDE_WIDTH = 1.4;
/** Flow-line width by Strahler order 1, 2, 3, 4 and above. */
const ORDER_WIDTH = [0.6, 1.1, 1.8, 2.4] as const;
const orderWidth = (o: number) => ORDER_WIDTH[Math.max(0, Math.min(3, o - 1))]!;
/** Flow arrows every 40 mm along order 2 and above. */
const ARROW_SPACING_PT = (40 / 25.4) * 72;
const OUTLET_RADIUS = 4;
const MAX_RASTER_PX = 1600;
const FILL_OPACITY = 0.35;
const MAX_HOLLOWS = 60;

const hex = (h: number): RGB => rgb(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const WATER_DEEP = hex(0x10384d);
const WHITE = rgb(1, 1, 1);
const SHADE_LIGHT = [0xe9, 0xe3, 0xd6] as const;
const SHADE_DARK = [0x8d, 0x84, 0x71] as const;
/** Eight muted watershed fills; minor watersheds are grey. */
const FILLS: readonly (readonly [number, number, number])[] = [
  [0x5f, 0x93, 0xa8], [0x93, 0xa8, 0x5f], [0xc4, 0x96, 0x52], [0xa8, 0x76, 0x96],
  [0x6f, 0xa3, 0x8a], [0xc0, 0x7a, 0x62], [0x84, 0x8a, 0xc0], [0xa8, 0xa0, 0x52],
];
const MINOR_FILL = [0xa3, 0xa3, 0xa3] as const;

type Pt = [number, number];

// --- Geometry helpers -------------------------------------------------------

/** Cell window [c0, c1) x [r0, r1). */
interface Win { c0: number; c1: number; r0: number; r1: number }

/** Two rounds of Chaikin corner cutting; open lines keep their ends. */
function chaikin(pts: readonly Pt[], closed: boolean, rounds = 2): Pt[] {
  let cur: Pt[] = pts.map((p) => [p[0], p[1]]);
  for (let k = 0; k < rounds; k++) {
    if (cur.length < 3) return cur;
    const out: Pt[] = [];
    const n = cur.length;
    const segs = n - 1;
    if (!closed) out.push(cur[0]!);
    for (let i = 0; i < segs; i++) {
      const a = cur[i]!;
      const b = cur[i + 1]!;
      const q: Pt = [0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]];
      const r: Pt = [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]];
      if (!closed && i === 0) out.push(r);
      else if (!closed && i === segs - 1) out.push(q);
      else out.push(q, r);
    }
    if (!closed) out.push(cur[n - 1]!);
    else out.push([out[0]![0], out[0]![1]]);
    cur = out;
  }
  return cur;
}

/**
 * Chaikin smoothing after splitting every segment into pieces no longer than
 * `maxPiece`. Corner cutting scales with segment length, so without the split
 * a long simplified edge would lose up to a quarter of its length at each
 * corner and the line would leave the cells it bounds. With it the drawn line
 * stays within half a piece of the original.
 */
export function smoothLine(pts: readonly (readonly [number, number])[], closed: boolean, maxPiece: number): [number, number][] {
  const dense: Pt[] = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!;
    dense.push([a[0], a[1]]);
    const b = pts[k + 1];
    if (!b) break;
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxPiece);
    for (let j = 1; j < n; j++) dense.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return chaikin(dense, closed);
}

function ringPoints(ring: Ring): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < ring.length; i += 2) pts.push([ring[i]!, ring[i + 1]!]);
  return pts;
}

/** Shared edges between labelled watersheds, chained into polylines in grid metres. */
function partitionDivides(grid: FlowGrid, part: WatershedPartition, win: Win): Pt[][] {
  const { cols, rows, cellMetresX: sx, cellMetresY: sy } = grid;
  const minor = new Set(part.watersheds.filter((w) => w.minor).map((w) => w.id));
  const lab = part.label;
  const keep = (a: number, b: number) => a > 0 && b > 0 && a !== b && !minor.has(a) && !minor.has(b);
  const VW = cols + 1;
  const adj = new Map<number, number[]>();
  const edges: [number, number][] = [];
  const add = (u: number, v: number) => {
    const id = edges.length;
    edges.push([u, v]);
    (adj.get(u) ?? adj.set(u, []).get(u)!).push(id);
    (adj.get(v) ?? adj.set(v, []).get(v)!).push(id);
  };
  for (let r = Math.max(0, win.r0 - 1); r < Math.min(rows, win.r1 + 1); r++) {
    for (let c = Math.max(0, win.c0 - 1); c < Math.min(cols, win.c1 + 1); c++) {
      const i = r * cols + c;
      if (c + 1 < cols && keep(lab[i]!, lab[i + 1]!)) add(r * VW + c + 1, (r + 1) * VW + c + 1);
      if (r + 1 < rows && keep(lab[i]!, lab[i + cols]!)) add((r + 1) * VW + c, (r + 1) * VW + c + 1);
    }
  }
  const used = new Uint8Array(edges.length);
  const lines: Pt[][] = [];
  const vxy = (v: number): Pt => [(v % VW) * sx, Math.floor(v / VW) * sy];
  const walk = (start: number, first: number) => {
    const pts: Pt[] = [vxy(start)];
    let v = start;
    let e = first;
    for (;;) {
      used[e] = 1;
      const [a, b] = edges[e]!;
      v = a === v ? b : a;
      pts.push(vxy(v));
      const nexts = adj.get(v)!;
      if (nexts.length !== 2) break;
      const ne = nexts[0] === e ? nexts[1]! : nexts[0]!;
      if (used[ne]) break;
      e = ne;
    }
    lines.push(pts);
  };
  const verts = [...adj.keys()].sort((a, b) => a - b);
  for (const v of verts) {
    const es = adj.get(v)!;
    if (es.length === 2) continue;
    for (const e of es) if (!used[e]) walk(v, e);
  }
  for (const v of verts) for (const e of adj.get(v)!) if (!used[e]) walk(v, e);
  const tol = Math.min(sx, sy);
  return lines.map((pts) => {
    const flat = new Float64Array(pts.length * 2);
    pts.forEach((p, k) => { flat[2 * k] = p[0]; flat[2 * k + 1] = p[1]; });
    const closed = pts.length > 3 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1];
    return smoothLine(ringPoints(douglasPeucker(flat, tol)), closed, tol);
  });
}

function cellCentre(grid: FlowGrid, i: number): Pt {
  return [((i % grid.cols) + 0.5) * grid.cellMetresX, (Math.floor(i / grid.cols) + 0.5) * grid.cellMetresY];
}

function windowOf(grid: FlowGrid, inside: (i: number) => boolean): Win {
  let c0 = grid.cols, c1 = -1, r0 = grid.rows, r1 = -1;
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      if (!inside(r * grid.cols + c)) continue;
      if (c < c0) c0 = c;
      if (c > c1) c1 = c;
      if (r < r0) r0 = r;
      if (r > r1) r1 = r;
    }
  }
  if (c1 < 0) return { c0: 0, c1: grid.cols, r0: 0, r1: grid.rows };
  return { c0, c1: c1 + 1, r0, r1: r1 + 1 };
}

/** Grows the window about its centre towards `aspect` (width / height in metres), within the grid. */
function growToAspect(grid: FlowGrid, w: Win, aspect: number): Win {
  const { cellMetresX: sx, cellMetresY: sy } = grid;
  let { c0, c1, r0, r1 } = w;
  const wm = (c1 - c0) * sx;
  const hm = (r1 - r0) * sy;
  if (wm / hm < aspect) {
    const need = Math.round((hm * aspect) / sx) - (c1 - c0);
    c0 -= Math.floor(need / 2); c1 += Math.ceil(need / 2);
    if (c0 < 0) { c1 -= c0; c0 = 0; }
    if (c1 > grid.cols) { c0 -= c1 - grid.cols; c1 = grid.cols; }
    c0 = Math.max(0, c0);
  } else {
    const need = Math.round((wm / aspect) / sy) - (r1 - r0);
    r0 -= Math.floor(need / 2); r1 += Math.ceil(need / 2);
    if (r0 < 0) { r1 -= r0; r0 = 0; }
    if (r1 > grid.rows) { r0 -= r1 - grid.rows; r1 = grid.rows; }
    r0 = Math.max(0, r0);
  }
  return { c0, c1, r0, r1 };
}

// --- Raster -----------------------------------------------------------------

function buildRaster(
  grid: FlowGrid, coverage: Uint8Array, win: Win, pxW: number, pxH: number,
  part: WatershedPartition | undefined, focusMask: Uint8Array | null,
): Uint8Array {
  const { cols, valid } = grid;
  const shade = hillshade(grid);
  const minor = new Set(part ? part.watersheds.filter((w) => w.minor).map((w) => w.id) : []);
  // Stretch the shade between the 2nd and 98th percentiles of the window, so
  // gentle ground still reads as relief.
  const sample: number[] = [];
  for (let r = win.r0; r < win.r1; r++) for (let c = win.c0; c < win.c1; c++) if (valid[r * cols + c]) sample.push(shade[r * cols + c]!);
  sample.sort((a, b) => a - b);
  const lo = sample.length ? sample[Math.floor(sample.length * 0.02)]! : 0;
  const hi = sample.length ? sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.98))]! : 1;
  const span = hi - lo > 1e-6 ? hi - lo : 1;
  const out = new Uint8Array(pxW * pxH * 4);
  const wc = win.c1 - win.c0;
  const wr = win.r1 - win.r0;

  for (let py = 0; py < pxH; py++) {
    // Image row 0 is the northern edge.
    const gy = win.r0 + ((pxH - py - 0.5) / pxH) * wr;
    const nr = Math.min(win.r1 - 1, Math.floor(gy));
    for (let px = 0; px < pxW; px++) {
      const gx = win.c0 + ((px + 0.5) / pxW) * wc;
      const nc = Math.min(win.c1 - 1, Math.floor(gx));
      const i = nr * cols + nc;
      const o = (py * pxW + px) * 4;
      out[o + 3] = 255;
      // Bilinear over the four nearest cells: shade, fill and the catchment
      // wash over valid cells only, and validity itself, so edges are smooth.
      const fx = gx - 0.5, fy = gy - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const ax = fx - x0, ay = fy - y0;
      let vw = 0, sAcc = 0, fR = 0, fG = 0, fB = 0, fW = 0, inW = 0;
      for (let q = 0; q < 4; q++) {
        const w = (q & 1 ? ax : 1 - ax) * (q & 2 ? ay : 1 - ay);
        if (w <= 0) continue;
        const cc = Math.max(win.c0, Math.min(win.c1 - 1, x0 + (q & 1)));
        const rr = Math.max(win.r0, Math.min(win.r1 - 1, y0 + (q >> 1)));
        const j = rr * cols + cc;
        if (!valid[j]) continue;
        vw += w;
        sAcc += shade[j]! * w;
        if (part) {
          const id = part.label[j]!;
          if (id > 0) {
            const f = minor.has(id) ? MINOR_FILL : FILLS[(id - 1) % FILLS.length]!;
            fR += f[0] * w; fG += f[1] * w; fB += f[2] * w; fW += w;
          }
        }
        if (focusMask && focusMask[j] === 1) inW += w;
      }
      const alpha = Math.max(0, Math.min(1, (vw - 0.25) / 0.5));
      if (alpha === 0) { out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; continue; }
      const sv = sAcc / vw;
      const k = Math.max(0, Math.min(1, 0.08 + 0.9 * (sv - lo) / span));
      let R = SHADE_DARK[0] + (SHADE_LIGHT[0] - SHADE_DARK[0]) * k;
      let G = SHADE_DARK[1] + (SHADE_LIGHT[1] - SHADE_DARK[1]) * k;
      let B = SHADE_DARK[2] + (SHADE_LIGHT[2] - SHADE_DARK[2]) * k;
      if (fW > 0) {
        const op = FILL_OPACITY * (fW / vw);
        R = R * (1 - op) + (fR / fW) * op;
        G = G * (1 - op) + (fG / fW) * op;
        B = B * (1 - op) + (fB / fW) * op;
      }
      if (focusMask) {
        const wash = 0.55 * (1 - inW / vw);
        R = R * (1 - wash) + 255 * wash; G = G * (1 - wash) + 255 * wash; B = B * (1 - wash) + 255 * wash;
      }
      R = R * alpha + 255 * (1 - alpha); G = G * alpha + 255 * (1 - alpha); B = B * alpha + 255 * (1 - alpha);
      // Interpolated ground: a staggered dot every 6 px.
      if (valid[i] && coverage[i] === 1) {
        const stag = Math.floor(py / 6) % 2 === 0 ? 0 : 3;
        if ((px + stag) % 6 < 2 && py % 6 < 2) { R *= 0.62; G *= 0.62; B *= 0.62; }
      }
      out[o] = Math.round(R); out[o + 1] = Math.round(G); out[o + 2] = Math.round(B);
    }
  }
  return out;
}

/**
 * The site hillshade with the watershed fills, cropped to the readable cells,
 * for the cover. `origin` and `size` give the image's extent in grid metres
 * from the south-west corner of cell 0, so callers can overlay divides.
 */
export function siteRaster(
  grid: FlowGrid, coverage: Uint8Array, part: WatershedPartition, maxPx: number,
): { rgba: Uint8Array; w: number; h: number; origin: readonly [number, number]; size: readonly [number, number] } {
  const win = windowOf(grid, (i) => grid.valid[i] === 1);
  const wm = (win.c1 - win.c0) * grid.cellMetresX;
  const hm = (win.r1 - win.r0) * grid.cellMetresY;
  const scale = Math.min(maxPx / wm, maxPx / hm);
  const w = Math.max(1, Math.round(wm * scale));
  const h = Math.max(1, Math.round(hm * scale));
  return {
    rgba: buildRaster(grid, coverage, win, w, h, part, null), w, h,
    origin: [win.c0 * grid.cellMetresX, win.r0 * grid.cellMetresY], size: [wm, hm],
  };
}

// --- Drawing ------------------------------------------------------------------

interface Frame { x: number; y: number; w: number; h: number }

function clipTo(page: PDFPage, pts: readonly Pt[] | null, f?: Frame): void {
  const ops = [pushGraphicsState()];
  if (f) ops.push(rectangle(f.x, f.y, f.w, f.h));
  if (pts && pts.length >= 3) {
    ops.push(moveTo(pts[0]![0], pts[0]![1]));
    for (let k = 1; k < pts.length; k++) ops.push(lineTo(pts[k]![0], pts[k]![1]));
    ops.push(closePath());
  }
  ops.push(clip(), endPath());
  page.pushOperators(...ops);
}

function unclip(page: PDFPage): void {
  page.pushOperators(popGraphicsState());
}

/** 45 degree hatching clipped to the outline, then the outline itself. */
function hatch(page: PDFPage, outline: readonly Pt[]): void {
  if (outline.length < 3) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outline) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  clipTo(page, outline);
  const H = page.getHeight();
  const gap = 2.2;
  let d = '';
  for (let s = minX - (maxY - minY); s <= maxX; s += gap) {
    d += `M${(s).toFixed(2)} ${(H - minY).toFixed(2)} L${(s + (maxY - minY)).toFixed(2)} ${(H - maxY).toFixed(2)} `;
  }
  if (d) page.drawSvgPath(d, { x: 0, y: H, borderColor: PALETTE.earth, borderWidth: 0.5 });
  unclip(page);
  strokePath(page, outline, { color: PALETTE.earth, width: 0.7, close: true });
}

function arrowsAlong(page: PDFPage, pts: readonly Pt[], width: number): void {
  const H = page.getHeight();
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
  // Every segment gets at least one arrow: a short one has it at its middle.
  let next = total < ARROW_SPACING_PT / 2 ? total / 2 : ARROW_SPACING_PT / 2;
  let run = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1]!;
    const [bx, by] = pts[k]!;
    const len = Math.hypot(bx - ax, by - ay);
    while (len > 0 && run + len >= next) {
      const f = (next - run) / len;
      const x = ax + f * (bx - ax), y = ay + f * (by - ay);
      const ux = (bx - ax) / len, uy = (by - ay) / len;
      const hl = 2.4 + width, hw = 1.6 + width * 0.6;
      const tip: Pt = [x + ux * hl * 0.5, y + uy * hl * 0.5];
      const l: Pt = [x - ux * hl * 0.5 - uy * hw, y - uy * hl * 0.5 + ux * hw];
      const r: Pt = [x - ux * hl * 0.5 + uy * hw, y - uy * hl * 0.5 - ux * hw];
      page.drawSvgPath(`M${tip[0].toFixed(2)} ${(H - tip[1]).toFixed(2)} L${l[0].toFixed(2)} ${(H - l[1]).toFixed(2)} L${r[0].toFixed(2)} ${(H - r[1]).toFixed(2)} Z`, {
        x: 0, y: H, color: WATER_DEEP, borderWidth: 0,
      });
      next += ARROW_SPACING_PT;
    }
    run += len;
  }
}

/** Text with a paper knock-out behind it, kept inside the frame. */
function haloLabel(page: PDFPage, text: string, cx: number, cy: number, f: Frame, size: number, fonts: ReportFonts, color: RGB = PALETTE.ink): void {
  const w = widthOf(text, fonts.titleBold, size, fonts);
  const x = Math.max(f.x + 3, Math.min(f.x + f.w - w - 3, cx - w / 2));
  const y = Math.max(f.y + 3, Math.min(f.y + f.h - size - 3, cy - size * 0.35));
  page.drawRectangle({ x: x - 2.5, y: y - 2.5, width: w + 5, height: size + 3.5, color: PALETTE.paper, opacity: 0.88 });
  drawRuns(page, text, x, y, { font: fonts.titleBold, size, color }, fonts);
}

type LegendKind = 'fill' | 'minor' | 'divide' | 'studied' | 'order' | 'main' | 'outlet' | 'hollow' | 'stipple' | 'nodata';
interface LegendItem { kind: LegendKind; label: string; order?: number; width?: number }

function legendSwatch(page: PDFPage, it: LegendItem, x: number, y: number): void {
  const w = 18, h = 7, mid = y + h / 2;
  switch (it.kind) {
    case 'fill': {
      const cols = FILLS.slice(0, 3);
      cols.forEach((c, k) => page.drawRectangle({ x: x + k * 6, y, width: 6, height: h, color: rgb(c[0] / 255, c[1] / 255, c[2] / 255), opacity: 0.6 }));
      break;
    }
    case 'minor': page.drawRectangle({ x, y, width: w, height: h, color: rgb(MINOR_FILL[0] / 255, MINOR_FILL[1] / 255, MINOR_FILL[2] / 255), opacity: 0.6 }); break;
    case 'divide': page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: DIVIDE_WIDTH, color: PALETTE.ink, dashArray: [...DIVIDE_DASH].map((v) => v * 0.6) }); break;
    case 'studied': page.drawLine({ start: { x, y: mid }, end: { x: x + w, y: mid }, thickness: STUDIED_OUTLINE_WIDTH, color: PALETTE.ink }); break;
    case 'order': strokePath(page, [[x + 1, mid], [x + w - 1, mid]], { color: PALETTE.water, width: orderWidth(it.order ?? 1), round: true }); break;
    case 'main': strokePath(page, [[x + 1, mid], [x + w - 1, mid]], { color: WATER_DEEP, width: it.width ?? 1.2, round: true }); break;
    case 'outlet': page.drawCircle({ x: x + w / 2, y: mid, size: OUTLET_RADIUS - 0.5, borderColor: PALETTE.earth, borderWidth: 1.5 }); break;
    case 'hollow': {
      page.drawRectangle({ x, y, width: w, height: h, borderColor: PALETTE.earth, borderWidth: 0.6 });
      for (let s = 0; s < w + h; s += 2.2) {
        const x0 = Math.max(0, s - h), x1 = Math.min(w, s);
        page.drawLine({ start: { x: x + x0, y: y + (s - x0) }, end: { x: x + x1, y: y + (s - x1) }, thickness: 0.45, color: PALETTE.earth });
      }
      break;
    }
    case 'stipple': {
      page.drawRectangle({ x, y, width: w, height: h, color: hex(0xd8d1c2) });
      for (let yy = 1; yy < h; yy += 2) for (let xx = (yy % 4 === 1 ? 1 : 2); xx < w; xx += 2) page.drawRectangle({ x: x + xx - 0.35, y: y + yy - 0.35, width: 0.7, height: 0.7, color: hex(0x847b68) });
      break;
    }
    case 'nodata': page.drawRectangle({ x, y, width: w, height: h, color: WHITE, borderColor: PALETTE.rule, borderWidth: 0.6 }); break;
  }
}

function scaleRatio(ptPerMetre: number): number {
  const metresPerPt = 1 / ptPerMetre;
  const n = metresPerPt / (0.0254 / 72);
  const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

// --- Page -------------------------------------------------------------------

const TICK_LABEL = 9.1;
const LEFT_GUTTER = 38;
const TOP_GUTTER = 16;

export async function drawMapPage(
  c: PageCursor,
  doc: PDFDocument,
  model: WatershedReportModel,
  layers: MapLayers,
  fonts: ReportFonts,
  encodePng: (rgba: Uint8Array, w: number, h: number) => Promise<Uint8Array>,
): Promise<PageCursor> {
  const lang: ReportLanguage = model.language;
  const { grid, focus } = layers;
  const { cols, cellMetresX: sx, cellMetresY: sy, valid } = grid;
  const part = focus ? undefined : layers.partition;
  const cellM = Math.min(sx, sy);

  let cur = c;
  const pageBottom = cur.bottom;
  if (layers.bottomY !== undefined) cur = { ...cur, bottom: layers.bottomY };
  else if (cur.y - cur.bottom < 430) cur = newPage(doc, cur.ctx.size, cur.ctx.spine, cur.ctx.fonts, cur.ctx.footer);
  cur = focus
    ? heading(cur, t(lang, 'map.detail.kicker', { label: layers.focusTitle ?? focus.label }), t(lang, 'map.detail.title'), null, fonts)
    : heading(cur, t(lang, 'map.overview.kicker'), t(lang, 'map.overview.title'), null, fonts);
  const page = cur.page;

  // Window of cells to show.
  let win: Win;
  if (focus) {
    const w0 = windowOf(grid, (i) => focus.mask[i] === 1);
    const padC = Math.max(3, Math.round((w0.c1 - w0.c0) * 0.12));
    const padR = Math.max(3, Math.round((w0.r1 - w0.r0) * 0.12));
    win = { c0: Math.max(0, w0.c0 - padC), c1: Math.min(grid.cols, w0.c1 + padC), r0: Math.max(0, w0.r0 - padR), r1: Math.min(grid.rows, w0.r1 + padR) };
  } else {
    win = windowOf(grid, (i) => valid[i] === 1);
  }

  // Hollows to draw.
  const hollowSource = focus ? [focus] : layers.sections;
  const hollows: DepressionEntry[] = [];
  const seen = new Set<number>();
  for (const s of hollowSource) for (const d of s.depressions) if (!seen.has(d.seedCell)) { seen.add(d.seedCell); hollows.push(d); }
  hollows.sort((a, b) => b.cells - a.cells || a.seedCell - b.seedCell);
  hollows.length = Math.min(hollows.length, MAX_HOLLOWS);

  // Main channel: drawn wider than the widest flow line under it, in deep blue.
  const orderOf = new Map<number, number>();
  for (const g of layers.network.segments) for (const i of g.cells) orderOf.set(i, Math.max(orderOf.get(i) ?? 0, g.order));
  let channelOrder = 0;
  if (focus) for (const i of focus.channel.cells) channelOrder = Math.max(channelOrder, orderOf.get(i) ?? 0);
  const mainWidth = (channelOrder > 0 ? orderWidth(channelOrder) : ORDER_WIDTH[0]) + 0.6;

  const inWin = (w: Win, i: number) => {
    const cc = i % cols, rr = Math.floor(i / cols);
    return cc >= w.c0 && cc < w.c1 && rr >= w.r0 && rr < w.r1;
  };
  const minorIds = new Set(part ? part.watersheds.filter((w) => w.minor).map((w) => w.id) : []);
  /** What the map shows inside a window: its flow segments and its legend. */
  const contents = (w: Win) => {
    const segInWin = layers.network.segments.filter((g) => g.cells.some((i) => inWin(w, i)));
    const orders = new Set<number>(segInWin.map((g) => g.order));
    let anyInterp = false, anyNoData = false, anyMinor = false;
    for (let r = w.r0; r < w.r1; r++) {
      for (let cc = w.c0; cc < w.c1; cc++) {
        const i = r * cols + cc;
        if (!valid[i]) anyNoData = true;
        else if (layers.coverage[i] === 1) anyInterp = true;
        if (part && minorIds.has(part.label[i]!)) anyMinor = true;
      }
    }
    const legend: LegendItem[] = [];
    if (part) legend.push({ kind: 'fill', label: t(lang, 'map.legend.watersheds') });
    if (anyMinor) legend.push({ kind: 'minor', label: t(lang, 'map.legend.minor') });
    legend.push({ kind: 'divide', label: t(lang, 'map.legend.divide') });
    if (!focus && layers.sections.some((x) => !x.divide.degenerate)) legend.push({ kind: 'studied', label: t(lang, 'map.legend.studied') });
    for (const o of [...orders].sort((a, b) => a - b)) legend.push({ kind: 'order', order: o, label: t(lang, 'map.legend.order', { order: o }) });
    if (focus && focus.channel.cells.length > 1) legend.push({ kind: 'main', width: mainWidth, label: t(lang, 'map.legend.mainChannel') });
    if (layers.sections.some((x) => inWin(w, x.outlet))) legend.push({ kind: 'outlet', label: t(lang, 'map.legend.outlet') });
    if (hollows.some((d) => inWin(w, d.seedCell))) legend.push({ kind: 'hollow', label: t(lang, 'map.legend.depression') });
    if (anyInterp) legend.push({ kind: 'stipple', label: t(lang, 'map.legend.interpolated') });
    if (anyNoData) legend.push({ kind: 'nodata', label: t(lang, 'map.legend.noData') });
    return { segInWin, legend };
  };

  const contentW = cur.right - cur.left;
  const leftW = Math.round(contentW * 0.4);
  const legendW = contentW - leftW - 12;
  const ROW = 13.5;
  const legendHeight = (n: number) => 22 + Math.ceil(n / 2) * ROW + 4;
  // Growing the catchment map's window can add legend items, so reserve one more row.
  const collarH = Math.max(legendHeight(contents(win).legend.length + (focus ? 2 : 0)), 100);

  // Frame: fit the window's ground extent into the space above the collar.
  const availX = cur.left + LEFT_GUTTER;
  const availW = cur.right - availX;
  const availTop = cur.y - TOP_GUTTER;
  const availH = availTop - (cur.bottom + collarH + 10);
  if (focus) win = growToAspect(grid, win, availW / availH);
  const { segInWin, legend } = contents(win);
  const legendRows = Math.ceil(legend.length / 2);
  const wM = (win.c1 - win.c0) * sx;
  const hM = (win.r1 - win.r0) * sy;
  const scale = Math.min(availW / wM, availH / hM);
  const frame: Frame = { w: wM * scale, h: hM * scale, x: 0, y: 0 };
  // Left-aligned on the text column's tick gutter, so maps share the page's left edge.
  frame.x = availX;
  frame.y = availTop - frame.h;
  const wx0 = win.c0 * sx;
  const wy0 = win.r0 * sy;
  const P = (p: Pt): Pt => [frame.x + (p[0] - wx0) * scale, frame.y + (p[1] - wy0) * scale];

  // Raster.
  const long = Math.min(MAX_RASTER_PX, Math.ceil(Math.max(frame.w, frame.h) * 3));
  const pxW = Math.max(1, Math.round(frame.w >= frame.h ? long : (long * frame.w) / frame.h));
  const pxH = Math.max(1, Math.round(frame.h > frame.w ? long : (long * frame.h) / frame.w));
  const rgba = buildRaster(grid, layers.coverage, win, pxW, pxH, part, focus ? focus.mask : null);
  const img = await doc.embedPng(await encodePng(rgba, pxW, pxH));
  page.drawImage(img, { x: frame.x, y: frame.y, width: frame.w, height: frame.h });

  clipTo(page, null, frame);

  // Divides.
  if (part) {
    for (const line of partitionDivides(grid, part, win)) {
      strokePath(page, line.map(P), { color: PALETTE.ink, width: DIVIDE_WIDTH, dash: DIVIDE_DASH, opacity: 0.85 });
    }
  }
  if (focus && !focus.divide.degenerate) {
    for (const ring of [focus.divide.outer, ...focus.divide.holes]) {
      strokePath(page, smoothLine(ringPoints(ring), true, cellM).map(P), { color: PALETTE.ink, width: DIVIDE_WIDTH, dash: DIVIDE_DASH, close: true });
    }
  }

  // Hollows. Their outlines, the flow lines and the outlets are what labels must avoid.
  const obstacles: Pt[] = [];
  for (const d of hollows) {
    let outline: Pt[] | null = null;
    if (layers.filled) {
      const members = depressionMembers(layers.filled, grid.cols, grid.rows, d.seedCell);
      const mask = new Uint8Array(grid.cols * grid.rows);
      for (const m of members) mask[m] = 1;
      const tr = traceDivide(grid, mask);
      if (!tr.degenerate) outline = smoothLine(ringPoints(tr.outer), true, cellM).map(P);
    }
    if (!outline) {
      const [cx, cy] = P(cellCentre(grid, d.seedCell));
      const rad = Math.max(2.5, Math.sqrt((d.areaM2 ?? d.cells * sx * sy) / Math.PI) * scale);
      outline = Array.from({ length: 25 }, (_, k): Pt => [cx + rad * Math.cos((k / 24) * 2 * Math.PI), cy + rad * Math.sin((k / 24) * 2 * Math.PI)]);
    }
    hatch(page, outline);
    obstacles.push(...outline);
  }

  // Flow network, low orders first; arrows on order 2 and above.
  const segs = [...segInWin].sort((a, b) => a.order - b.order || a.id - b.id);
  const byId = layers.network.segments;
  const lines = segs.map((g) => {
    const pts: Pt[] = Array.from(g.cells, (i) => cellCentre(grid, i));
    const down = g.downstream >= 0 ? byId[g.downstream] : undefined;
    if (down && down.cells.length > 0) pts.push(cellCentre(grid, down.cells[0]!));
    return { g, pts: chaikin(pts, false).map(P) };
  });
  for (const { g, pts } of lines) strokePath(page, pts, { color: PALETTE.water, width: orderWidth(g.order), round: true });
  for (const { pts } of lines) obstacles.push(...pts);

  if (focus && focus.channel.cells.length > 1) {
    const pts = chaikin(Array.from(focus.channel.cells, (i) => cellCentre(grid, i)), false).map(P);
    strokePath(page, pts, { color: WATER_DEEP, width: mainWidth, round: true });
  }
  for (const { g, pts } of lines) if (g.order >= 2) arrowsAlong(page, pts, orderWidth(g.order));

  // Studied catchments on the site map.
  if (!focus) {
    for (const s of layers.sections) {
      if (s.divide.degenerate) continue;
      strokePath(page, smoothLine(ringPoints(s.divide.outer), true, cellM).map(P), { color: PALETTE.ink, width: STUDIED_OUTLINE_WIDTH, close: true });
    }
  }

  // Outlets and labels.
  for (const s of layers.sections) obstacles.push(P(cellCentre(grid, s.outlet)));
  /**
   * Where to centre a catchment label: the centroid if the label box there is
   * clear of flow lines, hollows and outlets, else the nearest clear spot on
   * rings of growing radius that still lies inside the catchment.
   */
  const labelSpot = (c0: Pt, s: CatchmentSection, size: number): Pt => {
    const w = widthOf(s.label, fonts.titleBold, size, fonts) + 8;
    const h = size + 6;
    const clear = (p: Pt) => {
      if (p[0] - w / 2 < frame.x || p[0] + w / 2 > frame.x + frame.w || p[1] - h / 2 < frame.y || p[1] + h / 2 > frame.y + frame.h) return false;
      const gx = wx0 + (p[0] - frame.x) / scale, gy = wy0 + (p[1] - frame.y) / scale;
      const cc = Math.floor(gx / sx), rr = Math.floor(gy / sy);
      if (cc < 0 || rr < 0 || cc >= cols || rr >= grid.rows || s.mask[rr * cols + cc] !== 1) return false;
      for (const o of obstacles) if (Math.abs(o[0] - p[0]) < w / 2 + 2 && Math.abs(o[1] - p[1]) < h / 2 + 2) return false;
      return true;
    };
    if (clear(c0)) return c0;
    for (let r = 6; r <= 120; r += 6) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / 6));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * 2 * Math.PI;
        const p: Pt = [c0[0] + r * Math.cos(a), c0[1] + r * Math.sin(a)];
        if (clear(p)) return p;
      }
    }
    return c0;
  };
  for (const s of layers.sections) {
    const [ox, oy] = P(cellCentre(grid, s.outlet));
    if (ox < frame.x || ox > frame.x + frame.w || oy < frame.y || oy > frame.y + frame.h) continue;
    page.drawCircle({ x: ox, y: oy, size: OUTLET_RADIUS, borderColor: PALETTE.earth, borderWidth: 1.6, color: WHITE, opacity: 0.55 });
  }
  if (!focus) {
    for (const s of layers.sections) {
      if (s.divide.degenerate) continue;
      let ax = 0, ay = 0, n = 0;
      for (let i = 0; i < s.mask.length; i++) if (s.mask[i] === 1) { const [x, y] = cellCentre(grid, i); ax += x; ay += y; n++; }
      if (n === 0) continue;
      const spot = labelSpot(P([ax / n, ay / n]), s, 11);
      haloLabel(page, s.label, spot[0], spot[1], frame, 13, fonts);
    }
  } else {
    for (const s of layers.sections) {
      const [ox, oy] = P(cellCentre(grid, s.outlet));
      if (ox < frame.x || ox > frame.x + frame.w || oy < frame.y || oy > frame.y + frame.h) continue;
      haloLabel(page, s.label, ox + OUTLET_RADIUS + 12, oy + OUTLET_RADIUS + 5, frame, 12.6, fonts, PALETTE.earth);
    }
  }

  unclip(page);

  // Orientation mark, top right inside the frame.
  const georef = model.site.crsName != null && model.site.crsName.trim() !== '';
  {
    const l1 = georef ? t(lang, 'map.north.grid') : t(lang, 'map.north.local');
    const l2 = georef ? '' : t(lang, 'map.north.unknown');
    const sz = 8.4;
    const tw = Math.max(widthOf(l1, fonts.bodyBold, sz, fonts), l2 ? widthOf(l2, fonts.body, sz, fonts) : 0);
    const bw = Math.min(frame.w - 8, Math.max(tw, 14) + 10);
    const bx = frame.x + frame.w - bw - 4;
    const by = frame.y + frame.h - 46;
    page.drawRectangle({ x: bx, y: by, width: bw, height: 42, color: PALETTE.paper, opacity: 0.9 });
    const ax = bx + bw / 2;
    page.drawSvgPath(svgPolyline(page, [[ax, by + 39], [ax - 4.5, by + 22], [ax, by + 26], [ax + 4.5, by + 22]], true), {
      x: 0, y: page.getHeight(), color: georef ? PALETTE.ink : PALETTE.mute, borderWidth: 0,
    });
    const put = (s: string, y: number, bold: boolean) => {
      const f = bold ? fonts.bodyBold : fonts.body;
      const ss = fitSize(s, f, sz, bw - 4, fonts);
      drawRuns(page, s, ax - widthOf(s, f, ss, fonts) / 2, y, { font: f, size: ss, color: PALETTE.ink2 }, fonts);
    };
    put(l1, by + 11, true);
    if (l2) put(l2, by + 2.5, false);
  }

  // Frame, ticks and coordinate labels (grid metres).
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: PALETTE.ink, borderWidth: 0.8 });
  page.drawRectangle({ x: frame.x - 2.5, y: frame.y - 2.5, width: frame.w + 5, height: frame.h + 5, borderColor: PALETTE.ink, borderWidth: 0.3 });
  const step = niceStep(Math.max(wM, hM), 6);
  const dec = decimalsFor(step);
  const label = (v: number) => formatNumber(lang, v, dec);
  let lastRight = -Infinity;
  for (let v = Math.ceil(wx0 / step) * step; v <= wx0 + wM + 1e-9; v += step) {
    const x = frame.x + (v - wx0) * scale;
    page.drawLine({ start: { x, y: frame.y }, end: { x, y: frame.y + 5 }, thickness: 0.5, color: PALETTE.ink });
    page.drawLine({ start: { x, y: frame.y + frame.h }, end: { x, y: frame.y + frame.h - 5 }, thickness: 0.5, color: PALETTE.ink });
    const s = label(v);
    const w = widthOf(s, fonts.body, TICK_LABEL, fonts);
    const lx = Math.max(cur.left, Math.min(cur.right - w, x - w / 2));
    if (lx < lastRight + 4) continue;
    drawRuns(page, s, lx, frame.y + frame.h + 5, { font: fonts.body, size: TICK_LABEL, color: PALETTE.mute }, fonts);
    lastRight = lx + w;
  }
  for (let v = Math.ceil(wy0 / step) * step; v <= wy0 + hM + 1e-9; v += step) {
    const y = frame.y + (v - wy0) * scale;
    page.drawLine({ start: { x: frame.x, y }, end: { x: frame.x + 5, y }, thickness: 0.5, color: PALETTE.ink });
    page.drawLine({ start: { x: frame.x + frame.w, y }, end: { x: frame.x + frame.w - 5, y }, thickness: 0.5, color: PALETTE.ink });
    const s = label(v);
    const room = frame.x - 5 - cur.left;
    const sz = fitSize(s, fonts.body, TICK_LABEL, room, fonts);
    const w = widthOf(s, fonts.body, sz, fonts);
    const ly = Math.max(frame.y, Math.min(frame.y + frame.h - sz, y - sz * 0.35));
    drawRuns(page, s, Math.max(cur.left, frame.x - 5 - w), ly, { font: fonts.body, size: sz, color: PALETTE.mute }, fonts);
  }

  // Collar: scale bar, scale and coordinate note on the left; legend on the right.
  const collarTop = frame.y - 12;
  {
    const bx = cur.left;
    const target = Math.min(leftW - 36, 150);
    const total = niceFloor(target / scale);
    const barPt = total * scale;
    const lead = Math.round(total / 10 ** Math.floor(Math.log10(total)));
    const segsN = lead === 2 ? 4 : 5;
    const segPt = barPt / segsN;
    const by = collarTop - 18;
    for (let k = 0; k < segsN; k++) {
      page.drawRectangle({ x: bx + k * segPt, y: by, width: segPt, height: 4, color: k % 2 === 0 ? PALETTE.ink : WHITE, borderColor: PALETTE.ink, borderWidth: 0.5 });
    }
    const { unit, divisor } = scaleBarUnit(total, 'metre');
    const segVal = total / segsN / divisor;
    const vdec = decimalsFor(segVal);
    for (let k = 0; k <= segsN; k++) {
      if (segPt < 22 && k !== 0 && k !== segsN) continue;
      const s = formatNumber(lang, segVal * k, vdec);
      const w = widthOf(s, fonts.body, TICK_LABEL, fonts);
      drawRuns(page, s, bx + k * segPt - (k === 0 ? 0 : w / 2), by + 8, { font: fonts.body, size: TICK_LABEL, color: PALETTE.ink }, fonts);
    }
    drawRuns(page, unit, bx + barPt + 5, by, { font: fonts.body, size: TICK_LABEL, color: PALETTE.ink2 }, fonts);
    const ratio = `1:${formatNumber(lang, scaleRatio(scale), 0)}`;
    let y = by - 16;
    const sline = t(lang, 'map.scale', { ratio });
    drawRuns(page, sline, bx, y, { font: fonts.bodyBold, size: 10.5, color: PALETTE.ink }, fonts);
    // The coordinate note is printed once, on the site map.
    const note = focus ? '' : georef ? t(lang, 'map.coords.grid', { crs: model.site.crsName!.trim() }) : t(lang, 'map.coords.local');
    y -= 4;
    for (const line of note ? wrapText(note, fonts.body, 9.8, leftW - 6, fonts) : []) {
      y -= 12.5;
      drawRuns(page, line, bx, y, { font: fonts.body, size: 9.8, color: PALETTE.ink2 }, fonts);
    }
  }
  {
    const lx = cur.left + leftW + 12;
    const top = collarTop;
    // A hairline above the legend instead of a box.
    page.drawLine({ start: { x: lx, y: top }, end: { x: lx + legendW, y: top }, thickness: 0.4, color: PALETTE.rule });
    drawRuns(page, t(lang, 'map.legend.title').toUpperCase(), lx + 7, top - 14, { font: fonts.bodyBold, size: 9.8, color: PALETTE.mute }, fonts);
    const colW = (legendW - 14) / 2;
    legend.forEach((it, k) => {
      const col = k < legendRows ? 0 : 1;
      const row = col === 0 ? k : k - legendRows;
      const x = lx + 7 + col * colW;
      const y = top - 22 - (row + 1) * ROW + 4;
      legendSwatch(page, it, x, y);
      const sz = fitSize(it.label, fonts.body, 8.75, colW - 26, fonts);
      drawRuns(page, it.label, x + 23, y + 1, { font: fonts.body, size: sz, color: PALETTE.ink }, fonts);
    });
  }

  return { ...cur, bottom: pageBottom, y: collarTop - collarH - 8 };
}
