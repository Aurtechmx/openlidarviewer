/**
 * watershedGif.ts — an animated GIF of one catchment, revealed by D8 flow
 * length to its outlet.
 *
 * Frame k shows every catchment cell whose flow length is at most
 * L_k = L_max · k / K, coloured by flow length on viridis (perceptually
 * uniform, monotonic in lightness), over a grey hillshade of the DTM; cells
 * outside the catchment are shaded darker, NoData cells are dotted, the outlet
 * is ringed, and the channel lines at the Lab's current setting are drawn as
 * the reveal reaches them. The last frame holds the complete catchment. The
 * colour is a distance along D8 paths, never a time: no velocity is modelled,
 * and every label says "flow length".
 *
 * North is up: grid row 0 is the southern row, so the northernmost cropped row
 * is drawn first. Each cell is an s × s block of pixels (nearest neighbour), so
 * cells stay square; a catchment wider than the page is shown one pixel per d
 * cells instead, and the footer says so. The output is at most 1000 px on its
 * long side.
 *
 * The map, legend bar, scale bar, north arrow and marks are written straight
 * into palette indices. Text comes from a `TextRasterizer` (a canvas in the
 * browser, a stub in tests) as an alpha mask, blended onto the background and
 * snapped to the nearest palette colour. One global palette of 256 colours:
 * the fixed hillshade greys, 128 viridis steps, the UI colours and three
 * text-blend ramps.
 *
 * Each frame after the first carries only the rectangle that changed. The
 * caller's `yieldFn` runs between frames so a long export never holds the main
 * thread for more than one frame's work.
 */

import { GifWriter } from './gifEncoder';
import { asciiFold } from './safeText';
import { viridis } from '../ui/fieldSimulation/labColormaps';
import { CELL_NODATA, type FlowGrid } from '../simulation/flowPulse/flowTypes';
import type { D8Result } from '../simulation/flowPulse/d8Flow';
import { flowLengthToOutlet, type FlowLengthUnit } from '../simulation/flowPulse/flowLength';
import { EDGE_CONTAMINATED_NOTE } from '../simulation/flowPulse/edgeContamination';
import {
  areaLimitWarning,
  peakFlowText,
  type PeakFlowEstimate,
} from '../simulation/flowPulse/rationalDischarge';

// ── palette ────────────────────────────────────────────────────────────────

export const IX = {
  BG: 0, WHITE: 1, BLACK: 2, DIM: 3, NODATA: 4, OUTLET: 5, ACCENT: 6, CHANNEL_DIM: 7, RULE: 8,
} as const;
export const GREY_BASE = 16;
export const GREY_LEVELS = 64;
export const VIRIDIS_BASE = GREY_BASE + GREY_LEVELS;
export const VIRIDIS_LEVELS = 128;
const BLEND_BASE = VIRIDIS_BASE + VIRIDIS_LEVELS;
const BLEND_STEPS = 16;

const UI_RGB: ReadonlyArray<readonly [number, number, number]> = [
  [5, 11, 26], // background, the Lab's field colour
  [255, 255, 255],
  [0, 0, 0],
  [154, 164, 184], // secondary text
  [138, 148, 173], // NoData dots, the Lab's withheld colour
  [255, 90, 54], // outlet ring
  [56, 189, 248], // frame label
  [150, 158, 172], // channels outside the catchment
  [40, 52, 78], // rules
];

/** Grey relief level for a hillshade value in [0, 1], the Lab grid's cool grey. */
function reliefRgb(v: number): [number, number, number] {
  const g = Math.round(34 + (196 - 34) * Math.min(1, Math.max(0, v)));
  return [g, Math.min(255, g + 3), Math.min(255, g + 8)];
}

/** The 256-colour global palette, RGB triplets. */
export function watershedPalette(): Uint8Array {
  const p = new Uint8Array(256 * 3);
  UI_RGB.forEach((c, i) => p.set(c, i * 3));
  for (let i = 0; i < GREY_LEVELS; i++) p.set(reliefRgb(i / (GREY_LEVELS - 1)), (GREY_BASE + i) * 3);
  for (let i = 0; i < VIRIDIS_LEVELS; i++) p.set(viridis(i / (VIRIDIS_LEVELS - 1)), (VIRIDIS_BASE + i) * 3);
  // Text blends: white, secondary grey and the accent, each over the background.
  [IX.WHITE, IX.DIM, IX.ACCENT].forEach((fg, ramp) => {
    const f = UI_RGB[fg]!, b = UI_RGB[IX.BG]!;
    for (let s = 0; s < BLEND_STEPS; s++) {
      const a = (s + 1) / (BLEND_STEPS + 1);
      p.set([0, 1, 2].map((k) => Math.round(b[k]! + (f[k]! - b[k]!) * a)), (BLEND_BASE + ramp * BLEND_STEPS + s) * 3);
    }
  });
  return p;
}

const greyIndex = (v: number): number =>
  GREY_BASE + Math.round(Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.7)) * (GREY_LEVELS - 1));
export const viridisIndex = (t: number): number =>
  VIRIDIS_BASE + Math.round(Math.min(1, Math.max(0, t)) * (VIRIDIS_LEVELS - 1));

// ── text ───────────────────────────────────────────────────────────────────

/** A rasterised line of text: coverage 0-255 per pixel. */
export interface TextMask {
  readonly width: number;
  readonly height: number;
  readonly alpha: Uint8Array;
}

/** Draws text for the GIF; a canvas in the browser, a stub in tests. */
export interface TextRasterizer {
  measure(text: string, px: number, bold: boolean): number;
  mask(text: string, px: number, bold: boolean): TextMask;
}

/** Line box height for a font size. */
const lineBox = (px: number): number => Math.ceil(px * 1.35);

const FONT_STACK = '"Olv Font", "Olv Font Fallback", system-ui, -apple-system, "Segoe UI", sans-serif';

/** The browser rasteriser: one scratch canvas, white text, alpha read back. */
export function canvasTextRasterizer(): TextRasterizer {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('No 2D canvas is available to draw the GIF labels.');
  const font = (px: number, bold: boolean): string => `${bold ? 600 : 400} ${px}px ${FONT_STACK}`;
  return {
    measure(text, px, bold) {
      ctx.font = font(px, bold);
      return Math.ceil(ctx.measureText(text).width);
    },
    mask(text, px, bold) {
      ctx.font = font(px, bold);
      const width = Math.max(1, Math.ceil(ctx.measureText(text).width) + 2);
      const height = lineBox(px);
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.font = font(px, bold);
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, 1, Math.round(px * 1.05));
      const data = ctx.getImageData(0, 0, width, height).data;
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]!;
      return { width, height, alpha };
    },
  };
}

/** Snaps a text pixel (foreground at some coverage over a palette colour) to the nearest palette entry. */
class Blender {
  private readonly _cache = new Map<number, number>();
  private readonly _palette: Uint8Array;
  constructor(palette: Uint8Array) { this._palette = palette; }

  index(bg: number, fg: number, alpha: number): number {
    const a = Math.round((alpha / 255) * 16);
    if (a <= 0) return bg;
    if (a >= 16) return fg;
    const key = (bg << 13) | (fg << 5) | a;
    const hit = this._cache.get(key);
    if (hit !== undefined) return hit;
    const p = this._palette, t = a / 16;
    const r = p[bg * 3]! + (p[fg * 3]! - p[bg * 3]!) * t;
    const g = p[bg * 3 + 1]! + (p[fg * 3 + 1]! - p[bg * 3 + 1]!) * t;
    const b = p[bg * 3 + 2]! + (p[fg * 3 + 2]! - p[bg * 3 + 2]!) * t;
    let best = bg, bestD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 256; i++) {
      const dr = p[i * 3]! - r, dg = p[i * 3 + 1]! - g, db = p[i * 3 + 2]! - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = i; }
    }
    this._cache.set(key, best);
    return best;
  }
}

/** An indexed image the renderer draws into. */
class Canvas8 {
  readonly px: Uint8Array;
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number, fill = 0) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height).fill(fill);
  }

  rect(x: number, y: number, w: number, h: number, idx: number): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w)), y1 = Math.min(this.height, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) this.px.fill(idx, yy * this.width + x0, yy * this.width + Math.max(x0, x1));
  }

  set(x: number, y: number, idx: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.px[y * this.width + x] = idx;
  }

  /** A line of square pen `w` from (x0, y0) to (x1, y1), pixel centres. */
  line(x0: number, y0: number, x1: number, y1: number, w: number, idx: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    const half = (w - 1) / 2;
    for (let k = 0; k <= steps; k++) {
      const x = Math.round(x0 + ((x1 - x0) * k) / steps - half);
      const y = Math.round(y0 + ((y1 - y0) * k) / steps - half);
      for (let dy = 0; dy < w; dy++) for (let dx = 0; dx < w; dx++) this.set(x + dx, y + dy, idx);
    }
  }
}

/** Ellipsise `text` to fit `maxWidth` pixels. */
function fitText(text: string, px: number, bold: boolean, maxWidth: number, raster: TextRasterizer): string {
  if (raster.measure(text, px, bold) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (raster.measure(`${text.slice(0, mid)}…`, px, bold) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}

/** Word-wrap `text` to lines no wider than `maxWidth`. */
export function wrapText(text: string, px: number, maxWidth: number, raster: TextRasterizer): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && raster.measure(next, px, false) > maxWidth) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.map((l) => fitText(l, px, false, maxWidth, raster));
}

/** Draw text with its line box's top-left at (x, y); `align` 'right' puts its right edge at x. */
function drawText(
  img: Canvas8, blender: Blender, raster: TextRasterizer,
  text: string, x: number, y: number, px: number, bold: boolean, fg: number, align: 'left' | 'right' | 'center' = 'left',
): number {
  const m = raster.mask(text, px, bold);
  const x0 = align === 'left' ? x : align === 'right' ? x - m.width : x - Math.round(m.width / 2);
  for (let yy = 0; yy < m.height; yy++) {
    for (let xx = 0; xx < m.width; xx++) {
      const a = m.alpha[yy * m.width + xx]!;
      if (a === 0) continue;
      const X = x0 + xx, Y = y + yy;
      if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
      const i = Y * img.width + X;
      img.px[i] = blender.index(img.px[i]!, fg, a);
    }
  }
  return m.width;
}

// ── captions ───────────────────────────────────────────────────────────────

/** What the GIF states about the catchment, gathered by the caller. */
export interface WatershedFacts {
  readonly outletCol: number;
  readonly outletRow: number;
  readonly sourceName: string | null;
  readonly conditioning: 'raw' | 'priority-flood';
  /** Cell lengths in metres, or null when the horizontal scale is not resolved. */
  readonly cellMetres: { readonly x: number; readonly y: number } | null;
  readonly cells: number;
  readonly areaM2: number | null;
  readonly edgeContaminated: boolean;
  /** The Lab's peak-flow estimate at the outlet, or null when none is shown. */
  readonly peakFlow: PeakFlowEstimate | null;
  /** How channel lines were chosen, e.g. "estimated peak flow at least 1 L/s". */
  readonly channelRule: string;
  readonly crsName: string | null;
  readonly isGeographic: boolean;
  readonly version: string;
  readonly dateIso: string;
  /** Present when the outlet was snapped from a clicked cell. */
  readonly snappedFrom?: { readonly col: number; readonly row: number } | null;
}

const fmtMetres = (v: number): string => (v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toFixed(2))));

/** Formats a flow length on the frame label and the legend. */
export function formatLength(v: number, unit: FlowLengthUnit): string {
  const n = v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Number(v.toFixed(v >= 10 ? 0 : 1)));
  return unit === 'm' ? `${n} m` : `${n} cell${n === '1' ? '' : 's'}`;
}

/** The north statement: grid north of a projected CRS, the geographic grid, or no CRS. */
export function northLabel(crsName: string | null, isGeographic: boolean): string {
  if (isGeographic) return 'North: geographic grid';
  if (crsName) return `Grid north (${crsName})`;
  return 'Grid +Y (no CRS)';
}

export interface WatershedCaption {
  readonly title: string;
  readonly subtitle: string;
  readonly north: string;
  /** Footer paragraphs, wrapped by the renderer. */
  readonly footer: readonly string[];
  /** Plain-text provenance for the GIF comment extension. */
  readonly comment: string;
}

/** The title, footer and comment text, from the facts alone. */
export function watershedCaption(f: WatershedFacts, unit: FlowLengthUnit, downsample = 1): WatershedCaption {
  const surface = f.conditioning === 'priority-flood' ? 'Priority-Flood-conditioned' : 'raw';
  const cell = f.cellMetres
    ? `${fmtMetres(f.cellMetres.x)} m${Math.abs(f.cellMetres.x - f.cellMetres.y) > 1e-9 ? ` x ${fmtMetres(f.cellMetres.y)} m` : ''}`
    : 'size not resolved';
  const area = f.areaM2 == null
    ? 'contributing area withheld: the horizontal scale is not resolved'
    : `contributing area ${f.edgeContaminated ? 'at least ' : ''}${Math.round(f.areaM2).toLocaleString('en-US')} m²${f.edgeContaminated ? ` (${EDGE_CONTAMINATED_NOTE.replace(/^at least: /, '')})` : ''}`;
  const flow = f.peakFlow
    ? f.peakFlow.ok
      ? `Peak flow ${peakFlowText(f.peakFlow)}: rational method Q = C·i·A, steady state, uniform rain lasting at least the time of concentration${f.peakFlow.lowerBound ? '; a lower bound' : ''}.${areaLimitWarning(f.peakFlow) ? ` ${areaLimitWarning(f.peakFlow)}` : ''}`
      : `Peak flow not estimated: ${f.peakFlow.reason.replace(/^Withheld: /, '')}.`
    : null;
  const north = northLabel(f.crsName, f.isGeographic);
  const footer = [
    `Method: D8 single-direction routing over the ${surface} DTM. Colour is D8 flow length to the outlet (orthogonal step 1 cell, diagonal √2 cells), a distance, not a travel time: no velocity is modelled.`,
    `Cell ${cell}${downsample > 1 ? ` (1 pixel block per ${downsample} x ${downsample} cells)` : ''} · ${f.cells.toLocaleString('en-US')} cells · ${area}.`,
    ...(flow ? [flow] : []),
    `Lines: ${f.channelRule}. Outlet ringed${f.snappedFrom ? ` (snapped from col ${f.snappedFrom.col}, row ${f.snappedFrom.row})` : ''}. NoData dotted. Outside the catchment shaded darker.`,
    `Cells: col counts from the west, row from the south, both from 0. CRS ${f.crsName ?? 'not resolved'} · ${north} · OpenLiDARViewer ${f.version} · ${f.dateIso.slice(0, 10)}`,
  ];
  const title = `Catchment of outlet col ${f.outletCol}, row ${f.outletRow}`;
  const subtitle = f.sourceName ?? 'Unnamed scan';
  const commentText = [
    'OpenLiDARViewer Flow Pulse watershed animation (SIMULATED).',
    title, subtitle, ...footer,
    `Frames reveal cells by D8 flow length to the outlet (${unit === 'm' ? 'metres' : 'cell lengths'}); the last frame holds the whole catchment.`,
  ].join('\n');
  // GIF comments are 7-bit ASCII.
  const comment = asciiFold(commentText.replace(/√2/g, 'sqrt(2)').replace(/≤/g, '<='));
  return { title, subtitle, north, footer, comment };
}

// ── layout ─────────────────────────────────────────────────────────────────

export const GIF_MAX_SIDE = 1000;
const PAD = 16;
const MIN_WIDTH = 720;
const HEADER_H = 70;
const LEGEND_BLOCK_H = 66;
const FOOTER_PX = 12;
const FOOTER_LINE = 16;
const MAX_CELL_PX = 24;

export interface WatershedLayout {
  readonly width: number;
  readonly height: number;
  /** Cropped grid window, inclusive. */
  readonly c0: number;
  readonly c1: number;
  readonly r0: number;
  readonly r1: number;
  /** Pixels per block and cells per block side. */
  readonly s: number;
  readonly d: number;
  readonly mapX: number;
  readonly mapY: number;
  readonly mapW: number;
  readonly mapH: number;
  readonly legendY: number;
  readonly footerY: number;
  readonly footerLines: readonly string[];
}

/** Bounding box of the mask, widened by a margin and clamped to the grid. */
export function cropOf(mask: Uint8Array, cols: number, rows: number): { c0: number; c1: number; r0: number; r1: number } {
  let c0 = cols, c1 = -1, r0 = rows, r1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    const c = i % cols, r = (i - c) / cols;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  if (c1 < 0) return { c0: 0, c1: cols - 1, r0: 0, r1: rows - 1 };
  const m = Math.max(2, Math.ceil(0.06 * Math.max(c1 - c0 + 1, r1 - r0 + 1)));
  return { c0: Math.max(0, c0 - m), c1: Math.min(cols - 1, c1 + m), r0: Math.max(0, r0 - m), r1: Math.min(rows - 1, r1 + m) };
}

/** Fit the cropped grid, square cells, into a page at most {@link GIF_MAX_SIDE} on its long side. */
export function watershedLayout(
  crop: { c0: number; c1: number; r0: number; r1: number },
  footer: readonly string[],
  raster: TextRasterizer,
): WatershedLayout {
  const cw = crop.c1 - crop.c0 + 1, ch = crop.r1 - crop.r0 + 1;
  const wrapAt = (w: number): string[] => footer.flatMap((p) => wrapText(p, FOOTER_PX, w - 2 * PAD, raster));
  const worstLines = wrapAt(MIN_WIDTH).length;
  const bottomH = 12 + LEGEND_BLOCK_H + 8 + worstLines * FOOTER_LINE + PAD;
  const mapMaxW = GIF_MAX_SIDE - 2 * PAD;
  const mapMaxH = GIF_MAX_SIDE - PAD - HEADER_H - bottomH;
  let d = 1;
  let s = Math.min(MAX_CELL_PX, Math.floor(Math.min(mapMaxW / cw, mapMaxH / ch)));
  if (s < 1) {
    s = 1;
    d = Math.ceil(Math.max(cw / mapMaxW, ch / mapMaxH));
  }
  const mapW = Math.ceil(cw / d) * s, mapH = Math.ceil(ch / d) * s;
  const width = Math.max(MIN_WIDTH, mapW + 2 * PAD);
  const footerLines = wrapAt(width);
  const mapX = Math.floor((width - mapW) / 2), mapY = PAD + HEADER_H;
  const legendY = mapY + mapH + 12;
  const footerY = legendY + LEGEND_BLOCK_H + 8;
  const height = footerY + footerLines.length * FOOTER_LINE + PAD;
  return { width, height, ...crop, s, d, mapX, mapY, mapW, mapH, legendY, footerY, footerLines };
}

/** Round tick values from 0 to `max`, about `n` of them, always including 0. */
export function niceTicks(max: number, n = 5): number[] {
  if (!(max > 0)) return [0];
  const raw = max / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((v) => v >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** A round scale-bar length no longer than `maxValue`. */
export function niceLength(maxValue: number): number {
  if (!(maxValue > 0)) return 0;
  const mag = 10 ** Math.floor(Math.log10(maxValue));
  for (const k of [5, 2, 1]) if (k * mag <= maxValue) return k * mag;
  return mag;
}

// ── rendering ──────────────────────────────────────────────────────────────

export interface WatershedGifInput {
  readonly grid: FlowGrid;
  readonly routed: D8Result;
  readonly outlet: number;
  /** Hillshade per cell in [0, 1] of the DTM (NaN or absent: mid grey). */
  readonly shade: Float32Array | null;
  /** 1 for each cell drawn as a channel at the Lab's current setting. */
  readonly channel: Uint8Array | null;
  /** Flow length in metres, or in cell lengths when the scale is unresolved. */
  readonly unit: FlowLengthUnit;
  readonly facts: WatershedFacts;
  /** Reveal steps; the GIF has `revealFrames + 1` frames. Default 36. */
  readonly revealFrames?: number;
}

export interface WatershedGifOptions {
  readonly raster: TextRasterizer;
  readonly onProgress?: (done: number, total: number) => void;
  /** Awaited between frames; default a macrotask. */
  readonly yieldFn?: () => Promise<void>;
}

/** Display time of each reveal frame and of the final hold, in hundredths of a second. */
export const REVEAL_DELAY_CS = 9;
export const HOLD_DELAY_CS = 300;
export const DEFAULT_REVEAL_FRAMES = 36;

/** Flow length thresholds per frame: L_k = L_max · k / K for k = 0..K. */
export function revealThresholds(maxLength: number, k = DEFAULT_REVEAL_FRAMES): number[] {
  return Array.from({ length: k + 1 }, (_, i) => (i === k ? maxLength : (maxLength * i) / k));
}

/** Everything the frames are drawn from: flow lengths, the page layout, the captions. */
export interface WatershedPlan {
  readonly flowLength: Float64Array;
  readonly maxLength: number;
  /** 1 for each cell in the catchment. */
  readonly mask: Uint8Array;
  readonly layout: WatershedLayout;
  readonly caption: WatershedCaption;
  readonly thresholds: readonly number[];
}

/** Flow lengths, crop, layout and captions for one catchment. */
export function planWatershedGif(input: WatershedGifInput, raster: TextRasterizer): WatershedPlan {
  const { grid, routed, outlet } = input;
  const fl = flowLengthToOutlet(grid, routed, outlet, input.unit);
  const mask = new Uint8Array(fl.length.length);
  for (let i = 0; i < mask.length; i++) mask[i] = Number.isNaN(fl.length[i]!) ? 0 : 1;
  const crop = cropOf(mask, grid.cols, grid.rows);
  // The footer names the block size when cells are merged, which can change
  // the layout; settle it in at most three rounds.
  let caption = watershedCaption(input.facts, input.unit, 1);
  let L = watershedLayout(crop, caption.footer, raster);
  for (let round = 0; round < 3 && L.d > 1; round++) {
    const next = watershedCaption(input.facts, input.unit, L.d);
    const nl = watershedLayout(crop, next.footer, raster);
    caption = next;
    const settled = nl.d === L.d;
    L = nl;
    if (settled) break;
  }
  const thresholds = revealThresholds(fl.maxLength, input.revealFrames ?? DEFAULT_REVEAL_FRAMES);
  return { flowLength: fl.length, maxLength: fl.maxLength, mask, layout: L, caption, thresholds };
}

/** The GIF file, frame by frame, yielding between frames. */
export async function renderWatershedGif(input: WatershedGifInput, opts: WatershedGifOptions): Promise<Uint8Array> {
  const { grid, routed, outlet } = input;
  const { cols } = grid;
  const raster = opts.raster;
  const yieldFn = opts.yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const plan = planWatershedGif(input, raster);
  const { layout: L, caption, thresholds, mask } = plan;
  const fl = { length: plan.flowLength, maxLength: plan.maxLength };
  const palette = watershedPalette();
  const blender = new Blender(palette);
  const total = thresholds.length;

  // Static page: header, legend, scale bar, north arrow, footer.
  const chrome = new Canvas8(L.width, L.height, IX.BG);
  const titleMax = L.width - 2 * PAD - 150;
  drawText(chrome, blender, raster, fitText(caption.title, 16, true, titleMax, raster), PAD, PAD, 16, true, IX.WHITE);
  drawText(chrome, blender, raster, fitText(caption.subtitle, 12, false, titleMax, raster), PAD, PAD + 23, 12, false, IX.DIM);
  drawNorthArrow(chrome, blender, raster, L.width - PAD, PAD, caption.north);
  const legend = drawLegend(chrome, blender, raster, L, fl.maxLength, input.unit);
  drawScaleBar(chrome, blender, raster, L, grid, input.unit);
  L.footerLines.forEach((line, i) => drawText(chrome, blender, raster, line, PAD, L.footerY + i * FOOTER_LINE, FOOTER_PX, false, IX.DIM));

  // Static map: grey relief, darker outside the catchment, dotted NoData.
  const bw = Math.ceil((L.c1 - L.c0 + 1) / L.d), bh = Math.ceil((L.r1 - L.r0 + 1) / L.d);
  const blockCell = new Int32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const c = L.c0 + bx * L.d, r = L.r1 - by * L.d;
      blockCell[by * bw + bx] = r >= L.r0 ? r * cols + c : -1;
    }
  }
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const i = blockCell[by * bw + bx]!;
      const x = L.mapX + bx * L.s, y = L.mapY + by * L.s;
      if (i < 0 || routed.status[i] === CELL_NODATA) {
        chrome.rect(x, y, L.s, L.s, IX.BG);
        for (let yy = y; yy < y + L.s; yy++) for (let xx = x; xx < x + L.s; xx++) if (xx % 4 === 1 && yy % 4 === 1) chrome.set(xx, yy, IX.NODATA);
        continue;
      }
      const v = input.shade ? input.shade[i]! : 0.7;
      chrome.rect(x, y, L.s, L.s, greyIndex(mask[i] === 1 ? v : v * 0.5));
    }
  }

  // Channel segments, from each channel cell's centre to its receiver's.
  const cx = (i: number): number => L.mapX + (((i % cols) - L.c0) + 0.5) / L.d * L.s - 0.5;
  const cy = (i: number): number => L.mapY + ((L.r1 - Math.floor(i / cols)) + 0.5) / L.d * L.s - 0.5;
  const inCrop = (i: number): boolean => {
    const c = i % cols, r = Math.floor(i / cols);
    return c >= L.c0 && c <= L.c1 && r >= L.r0 && r <= L.r1;
  };
  const segs: Array<{ a: number; b: number; len: number }> = [];
  if (input.channel) {
    for (let i = 0; i < input.channel.length; i++) {
      if (input.channel[i] !== 1 || !inCrop(i)) continue;
      const to = routed.receiver[i]!;
      if (to < 0 || !inCrop(to) || routed.status[to] === CELL_NODATA) continue;
      segs.push({ a: i, b: to, len: mask[i] === 1 ? fl.length[i]! : Number.NaN });
    }
  }
  const lw = Math.max(1, Math.round(L.s / 4));
  const cased = L.s >= 3;
  for (const sg of segs) if (Number.isNaN(sg.len)) chrome.line(cx(sg.a), cy(sg.a), cx(sg.b), cy(sg.b), lw, IX.CHANNEL_DIM);

  // Per-block flow-length colour.
  const blockLen = new Float64Array(bw * bh).fill(Number.NaN);
  for (let k = 0; k < blockCell.length; k++) {
    const i = blockCell[k]!;
    if (i >= 0 && mask[i] === 1) blockLen[k] = fl.length[i]!;
  }

  const writer = new GifWriter(L.width, L.height, palette, { comment: caption.comment });
  let prev: Uint8Array | null = null;
  for (let f = 0; f < total; f++) {
    const lk = thresholds[f]!;
    const img = new Canvas8(L.width, L.height);
    img.px.set(chrome.px);
    for (let k = 0; k < blockLen.length; k++) {
      const len = blockLen[k]!;
      if (!(len <= lk)) continue;
      const bx = k % bw, by = (k - bx) / bw;
      img.rect(L.mapX + bx * L.s, L.mapY + by * L.s, L.s, L.s, viridisIndex(fl.maxLength > 0 ? len / fl.maxLength : 0));
    }
    for (const sg of segs) {
      if (!(sg.len <= lk)) continue;
      if (cased) img.line(cx(sg.a), cy(sg.a), cx(sg.b), cy(sg.b), lw + 2, IX.BLACK);
    }
    for (const sg of segs) if (sg.len <= lk) img.line(cx(sg.a), cy(sg.a), cx(sg.b), cy(sg.b), lw, IX.WHITE);
    drawOutlet(img, cx(outlet), cy(outlet), Math.max(5, Math.round(1.6 * L.s)));
    // Frame label and the legend's progress mark.
    drawText(img, blender, raster, `flow length ≤ ${formatLength(lk, input.unit)}`, PAD, PAD + 42, 15, true, IX.ACCENT);
    const mx = legend.x + Math.round((fl.maxLength > 0 ? lk / fl.maxLength : 1) * (legend.w - 1));
    for (let t = 0; t < 6; t++) img.rect(mx - (5 - t), legend.y - 7 + t, 2 * (5 - t) + 1, 1, IX.WHITE);
    const frame = diffRect(prev, img.px, L.width, L.height);
    writer.addFrame({ ...frame, delayCs: f === total - 1 ? HOLD_DELAY_CS : REVEAL_DELAY_CS });
    prev = img.px;
    opts.onProgress?.(f + 1, total);
    if (f < total - 1) await yieldFn();
  }
  return writer.finish();
}

/** The smallest rectangle where `next` differs from `prev`, cut out of `next` (1 x 1 when nothing changed). */
export function diffRect(
  prev: Uint8Array | null, next: Uint8Array, width: number, height: number,
): { indices: Uint8Array; width: number; height: number; left: number; top: number } {
  if (!prev) return { indices: next.slice(), width, height, left: 0, top: 0 };
  let x0 = width, x1 = -1, y0 = height, y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (prev[row + x] === next[row + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { indices: next.slice(0, 1), width: 1, height: 1, left: 0, top: 0 };
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(next.subarray((y0 + y) * width + x0, (y0 + y) * width + x0 + w), y * w);
  return { indices: out, width: w, height: h, left: x0, top: y0 };
}

function drawOutlet(img: Canvas8, x: number, y: number, r: number): void {
  const R = r + 2;
  for (let yy = Math.floor(y - R); yy <= Math.ceil(y + R); yy++) {
    for (let xx = Math.floor(x - R); xx <= Math.ceil(x + R); xx++) {
      const d = Math.hypot(xx - x, yy - y);
      if (d >= r - 2 && d <= r) img.set(xx, yy, IX.OUTLET);
      else if ((d > r && d <= r + 1.5) || (d >= r - 3.5 && d < r - 2)) img.set(xx, yy, IX.BLACK);
    }
  }
}

function drawNorthArrow(img: Canvas8, blender: Blender, raster: TextRasterizer, right: number, top: number, label: string): void {
  const cx = right - 12;
  // An upward arrow: a filled triangle head over a stem.
  for (let t = 0; t < 12; t++) img.rect(cx - Math.floor(t / 2), top + t, 2 * Math.floor(t / 2) + 1, 1, IX.WHITE);
  img.rect(cx - 1, top + 12, 3, 10, IX.WHITE);
  drawText(img, blender, raster, 'N', cx - 18, top + 2, 14, true, IX.WHITE, 'right');
  drawText(img, blender, raster, label, right, top + 26, 11, false, IX.DIM, 'right');
}

function drawLegend(
  img: Canvas8, blender: Blender, raster: TextRasterizer, L: WatershedLayout, maxLength: number, unit: FlowLengthUnit,
): { x: number; y: number; w: number } {
  const x = PAD, w = Math.min(420, L.width - 2 * PAD - 230);
  const y = L.legendY + 26;
  drawText(img, blender, raster, `D8 flow length to the outlet (${unit === 'm' ? 'm' : 'cell lengths'}), not travel time`, x, L.legendY, 12, false, IX.WHITE);
  for (let i = 0; i < w; i++) img.rect(x + i, y, 1, 12, viridisIndex(w > 1 ? i / (w - 1) : 0));
  for (const t of niceTicks(maxLength)) {
    const tx = x + Math.round((maxLength > 0 ? t / maxLength : 0) * (w - 1));
    img.rect(tx, y + 12, 1, 5, IX.WHITE);
    drawText(img, blender, raster, formatLength(t, unit).replace(/ (m|cells?)$/, ''), tx, y + 18, 11, false, IX.DIM, 'center');
  }
  return { x, y, w };
}

function drawScaleBar(img: Canvas8, blender: Blender, raster: TextRasterizer, L: WatershedLayout, grid: FlowGrid, unit: FlowLengthUnit): void {
  const right = L.width - PAD;
  const pxPerUnit = unit === 'm' ? L.s / (L.d * grid.cellMetresX) : L.s / L.d;
  const maxPx = Math.min(200, L.mapW * 0.4);
  const len = niceLength(maxPx / pxPerUnit);
  const px = Math.max(1, Math.round(len * pxPerUnit));
  const y = L.legendY + 30;
  img.rect(right - px, y, px, 4, IX.WHITE);
  img.rect(right - px, y - 4, 1, 8, IX.WHITE);
  img.rect(right - 1, y - 4, 1, 8, IX.WHITE);
  const aniso = Math.abs(grid.cellMetresX - grid.cellMetresY) > 1e-9 * grid.cellMetresX;
  const text = `${formatLength(len, unit)}${aniso ? ' (east-west)' : ''}`;
  drawText(img, blender, raster, text, right - px / 2, y - 22, 12, false, IX.WHITE, 'center');
}
