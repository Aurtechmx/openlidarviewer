/**
 * mapSheetStyled.ts: the contour map sheet in the Light and Dark styles.
 *
 * Shaded relief with a faint elevation tint sits under the contours, cut to
 * the scan footprint; enclosed areas without ground are hatched. Contours are
 * styled by line kind from the style's tokens, index contours carry upright
 * labels on a halo, and the highest and lowest measured ground are marked.
 * A side panel (right on a landscape sheet, below the map on a portrait one)
 * carries the title, legend, elevation ramp, scale, north arrow, data block,
 * hold-out accuracy, readiness and evidence lines, and notes.
 *
 * The facts printed are the Classic sheet's own (`mapSheetFacts`), so the two
 * styles never word a figure differently. The Classic style is still drawn by
 * mapSheetPdf.ts, unchanged.
 */
import { PDFDocument, StandardFonts, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import { INPUT_NOT_RECORDED_NOTE, sourceSha256Text } from '../../science/exportDigestRecord';
import { crsOriginLine } from '../../science/crsOrigin';
import {
  contourLineKind,
  modelLengthShares,
  type ContourFeature,
  type ContourLineKind,
} from '../../terrain/contour/contourFeatureModel';
import { decimalsForInterval } from '../../terrain/contour/labelPlacement';
import { placeContourLabels } from '../../terrain/contourStudio/contourLabelEngine';
import { fitTransform, gridTicks, niceStep, tickDecimals, type Box } from '../../terrain/contour/mapSheetLayout';
import { embedSheetFonts, type SheetFonts } from '../../export/sheetKit/fonts';
import { encodePng } from '../../export/sheetKit/png';
import {
  contourSheetRaster,
  contourSheetRelief,
  styledContourStroke,
  rasterSizeFor,
  type ContourSheetRelief,
} from '../../export/sheetKit/contourSheetModel';
import {
  drawCoordinateTicks,
  drawDataBlock,
  drawFooter,
  drawLegendRow,
  drawMarker,
  drawNorthArrow,
  drawPaper,
  drawScaleBar,
  drawSectionLabel,
  dataBlockHeight,
  legendRowHeight,
  sectionLabelHeight,
  pdfColor,
  sheetText,
  sheetTextWidth,
  wrapSheetText,
  type DataRow,
  type LegendKey,
  type NorthSpec,
} from '../../export/sheetKit/primitives';
import { SHEET_SPACE, SHEET_TYPE, sheetTokens, tintAt, type SheetRgb, type SheetTokens } from '../../export/sheetKit/tokens';
import { scaleBarUnit } from './scaleBar';
import {
  buildMapSheetPdf,
  contourShareSheetLines,
  mapLinearUnitLabel,
  mapSheetFacts,
  drawAnnotationLayerForSheet,
  drawPurposeAppendixForSheet,
  type MapSheetInput,
  type MapSheetFacts,
} from './mapSheetPdf';

const SHEET_PT: Record<NonNullable<MapSheetInput['sheet']>, readonly [number, number]> = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
};

interface Frame { x: number; y: number; w: number; h: number }

/** Page points per source unit and the page origin of the map's lower-left. */
interface MapTransform {
  readonly area: Box;
  readonly scale: number;
  readonly ox: number;
  readonly oy: number;
}

/** True when the sheet's frame is a projected, georeferenced CRS. */
function isGeoreferenced(input: MapSheetInput): boolean {
  const prov = input.provenance;
  return prov ? prov.crsKnown : input.crs != null && input.crs.trim() !== '' && !/not\s*georef/i.test(input.crs);
}

/**
 * Build the contour map sheet in `input.style`. Classic, or no style, is the
 * original sheet from mapSheetPdf.ts, byte for byte; Light and Dark are the
 * styled sheet.
 */
export async function buildContourSheetPdf(
  input: MapSheetInput,
  opts: { readonly loadFont?: (name: string) => Promise<Uint8Array> } = {},
): Promise<Uint8Array> {
  if (!input.style || input.style === 'classic') return buildMapSheetPdf(input);
  return buildStyledMapSheetPdf(input, sheetTokens(input.style), opts);
}

/** Build the Light or Dark contour map sheet. */
export async function buildStyledMapSheetPdf(
  input: MapSheetInput,
  t: SheetTokens,
  opts: { readonly loadFont?: (name: string) => Promise<Uint8Array> } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title ?? 'Contour Map', { showInWindowTitleBar: true });
  doc.setLanguage('en-US');
  doc.setAuthor('OpenLiDARViewer');
  if (input.provenance) {
    const p = input.provenance;
    doc.setSubject(`Source SHA-256: ${sourceSha256Text(p)}; Input SHA-256: ${p.analysisInputSha256 ?? INPUT_NOT_RECORDED_NOTE}; ${crsOriginLine(p.crsOrigin)}`);
  }
  const stamp = input.generatedAt ?? new Date();
  doc.setCreationDate(stamp);
  doc.setModificationDate(stamp);
  const fonts = await embedSheetFonts(doc, opts.loadFont);

  const size = input.sheet ?? 'letter';
  const orient = input.orientation ?? 'portrait';
  let [PW, PH] = SHEET_PT[size];
  if (orient === 'landscape') [PW, PH] = [PH, PW];
  const page = doc.addPage([PW, PH]);
  drawPaper(page, t);

  const relief = input.relief ? contourSheetRelief(input.relief) : null;
  const bbox = input.model.bbox;
  const area: Box | null = relief?.extent ?? bbox ?? null;
  const ctx: PanelContext = { facts: mapSheetFacts(input, 0), tr: null };
  const blocks = panelBlocks(page, input, ctx, relief, t, fonts, size, orient);
  const layout = chooseLayout(PW, PH, blocks);
  const frame = layout.frame;

  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, color: pdfColor(t.panel) });
  if (!area || (input.model.features.length === 0 && !relief?.extent)) {
    sheetText(page, 'No contours to map.', frame.x + 12, frame.y + frame.h - 20, { font: fonts.sans, size: 11, color: t.dim }, fonts);
  } else {
    const pad = 6;
    const inner = { x: frame.x + pad, y: frame.y + pad, w: frame.w - 2 * pad, h: frame.h - 2 * pad };
    const fit = fitTransform(area, inner);
    ctx.tr = { area, scale: fit.scale, ox: fit.ox, oy: fit.oy };
    await drawMapLayers(doc, page, input, t, fonts, frame, inner, ctx.tr, relief);
  }
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: pdfColor(t.outline), borderWidth: t.weight.frame });

  if (ctx.tr) ctx.facts = mapSheetFacts(input, ctx.tr.scale);
  for (const { block, panel, y } of layout.placed) block.draw(panel.x, y, panel.w, layout.k);
  const tr = ctx.tr;
  const M = MARGIN;

  // Footer: software and build on the left, the deliverable in the middle, page count right.
  const purpose = input.purpose;
  const pages = purpose ? 2 : 1;
  const buildText = input.provenance?.build ? `  ·  ${input.provenance.build}` : '';
  drawFooter(page, `OpenLiDARViewer - terrain analysis${buildText}`, `1 / ${pages}`, M, PW - M, M, t, fonts);
  if (purpose) {
    const label = `Deliverable - ${purpose.label}`;
    const w = sheetTextWidth(label, fonts.sansBold, SHEET_TYPE.footer, fonts);
    sheetText(page, label, PW - M - w - 40, M, { font: fonts.sansBold, size: SHEET_TYPE.footer, color: t.dim }, fonts);
  }

  if (input.includeAnnotations && input.annotations && input.annotations.length > 0 && tr && bbox) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const inner = { x: frame.x + 6, y: frame.y + 6, w: frame.w - 12, h: frame.h - 12 };
    drawAnnotationLayerForSheet(page, frame, inner, tr.area, { ox: tr.ox, oy: tr.oy, scale: tr.scale }, input, font, bold);
  }
  if (purpose) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    drawPurposeAppendixForSheet(doc, purpose, input, font, bold, { hillshade: relief != null, tint: relief != null && t.tintAlpha > 0 });
  }
  return doc.save();
}

async function drawMapLayers(
  doc: PDFDocument,
  page: PDFPage,
  input: MapSheetInput,
  t: SheetTokens,
  fonts: SheetFonts,
  frame: Frame,
  inner: Frame,
  tr: MapTransform,
  relief: ContourSheetRelief | null,
): Promise<void> {
  const pageX = (x: number): number => tr.ox + (x - tr.area.minX) * tr.scale;
  const pageY = (y: number): number => tr.oy + (y - tr.area.minY) * tr.scale;

  // ── relief raster, cut to the footprint by its own transparency ──────────
  if (input.relief && relief?.extent) {
    const ext = relief.extent;
    const wPt = (ext.maxX - ext.minX) * tr.scale;
    const hPt = (ext.maxY - ext.minY) * tr.scale;
    const px = rasterSizeFor(wPt, hPt);
    const raster = contourSheetRaster(input.relief, t, ext, px.width, px.height);
    const png = await doc.embedPng(await encodePng(raster.rgba, raster.width, raster.height));
    page.drawImage(png, { x: pageX(ext.minX), y: pageY(ext.minY), width: wPt, height: hPt });
  }

  // ── coordinate ticks ─────────────────────────────────────────────────────
  const origin = input.worldOrigin ?? { x: 0, y: 0 };
  const georef = isGeoreferenced(input);
  const wMinX = tr.area.minX + origin.x, wMaxX = tr.area.maxX + origin.x;
  const wMinY = tr.area.minY + origin.y, wMaxY = tr.area.maxY + origin.y;
  const stepX = niceStep(wMaxX - wMinX, 5);
  const stepY = niceStep(wMaxY - wMinY, 5);
  const decX = tickDecimals(stepX), decY = tickDecimals(stepY);
  const labelGrid = input.worldOrigin != null;
  const fmt = (v: number, dec: number, suffix: string): string => (labelGrid ? `${groupThousands(v.toFixed(dec))}${georef ? suffix : ''}` : '');
  const xs = gridTicks(wMinX, wMaxX, stepX).map((w) => ({ at: pageX(w - origin.x), label: fmt(w, decX, ' E') }));
  const ys = gridTicks(wMinY, wMaxY, stepY).map((w) => ({ at: pageY(w - origin.y), label: fmt(w, decY, ' N') }));
  drawCoordinateTicks(page, frame, xs, ys, t, fonts);

  // ── footprint outline ────────────────────────────────────────────────────
  const PH = page.getHeight();
  if (relief) {
    for (const ring of relief.outline) {
      if (ring.length < 3) continue;
      let d = '';
      ring.forEach(([x, y], i) => { d += `${i === 0 ? 'M' : 'L'}${pageX(x).toFixed(2)} ${(PH - pageY(y)).toFixed(2)} `; });
      page.drawSvgPath(`${d}Z`, { x: 0, y: PH, borderColor: pdfColor(t.outline), borderWidth: t.weight.outline * 0.75, borderOpacity: 0.8 });
    }
  }

  // ── contours: ordinary first, index on top ───────────────────────────────
  const drawFeature = (f: ContourFeature): void => {
    if (f.coordinates.length < 2) return;
    let d = '';
    for (let i = 0; i < f.coordinates.length; i++) {
      const [wx, wy] = f.coordinates[i]!;
      d += `${i === 0 ? 'M' : 'L'}${pageX(wx).toFixed(2)} ${(PH - pageY(wy)).toFixed(2)} `;
    }
    if (f.closed) d += 'Z';
    const st = styledContourStroke(t, f.isIndex, contourLineKind(f));
    page.drawSvgPath(d, {
      x: 0, y: PH, borderColor: pdfColor(st.color), borderWidth: st.width, borderOpacity: st.opacity,
      ...(st.dash ? { borderDashArray: [...st.dash] } : {}),
    });
  };
  for (const f of input.model.features) if (!f.isIndex) drawFeature(f);
  for (const f of input.model.features) if (f.isIndex) drawFeature(f);

  // ── index labels: upright, on a halo in the paper colour ─────────────────
  const bbox = input.model.bbox;
  if (bbox && input.model.features.length > 0) {
    const labelOz = input.worldOrigin?.z ?? 0;
    const dec = decimalsForInterval(input.provenance?.contourIntervalM ?? input.model.intervalM);
    const sz = SHEET_TYPE.contourLabel;
    const extent = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) || 1;
    const labels = placeContourLabels(input.model.features, {
      page: { minX: bbox.minX, minY: bbox.minY, maxX: bbox.maxX, maxY: bbox.maxY },
      minStraightLen: extent * 0.03,
      maxCurvature: 0.5,
      edgeMargin: extent * 0.015,
      labelHeight: (sz + 2) / tr.scale,
      // The gap is sized from the label face at its drawn size, plus room for the halo.
      charWidth: (fonts.sansBold.widthOfTextAtSize('0', sz) + 0.4) / tr.scale,
      minFeatureLenForScale: extent * 0.04,
      indexOnly: input.purpose?.labelsIndexOnly ?? true,
      maxLabels: 60,
      repeatEveryLen: extent * 0.28,
      formatValue: (v) => (v + labelOz).toFixed(dec),
    }).labels;
    const font = fonts.sansBold;
    for (const lab of labels) {
      const px = pageX(lab.x), py = pageY(lab.y);
      if (px < inner.x || px > inner.x + inner.w || py < inner.y || py > inner.y + inner.h) continue;
      const w = font.widthOfTextAtSize(lab.text, sz);
      const c = Math.cos(lab.angle), s = Math.sin(lab.angle);
      const lift = sz * 0.35;
      const ox = px - (c * w) / 2 + s * lift;
      const oy = py - (s * w) / 2 - c * lift;
      const rot = degrees((lab.angle * 180) / Math.PI);
      // A halo: the label drawn in the paper colour around its outline, then on top.
      for (const [dx, dy] of HALO_OFFSETS) {
        page.drawText(lab.text, { x: ox + dx, y: oy + dy, size: sz, font, color: pdfColor(t.halo), rotate: rot });
      }
      page.drawText(lab.text, { x: ox, y: oy, size: sz, font, color: pdfColor(t.contourLabel), rotate: rot });
    }
  }

  // ── highest and lowest measured ground ───────────────────────────────────
  if (relief) {
    const oz = input.worldOrigin?.z ?? 0;
    const spot = (p: { x: number; y: number; z: number } | null, shape: 'up' | 'down'): void => {
      if (!p) return;
      const px = pageX(p.x), py = pageY(p.y);
      if (px < inner.x || px > inner.x + inner.w || py < inner.y || py > inner.y + inner.h) return;
      drawMarker(page, shape, px, py, 3, t.ink);
      const label = (p.z + oz).toFixed(1);
      const o = { font: fonts.mono, size: SHEET_TYPE.tick, color: t.ink };
      const w = sheetTextWidth(label, fonts.mono, o.size, fonts);
      const lx = px + 5 + w > inner.x + inner.w ? px - 5 - w : px + 5;
      page.drawRectangle({ x: lx - 1, y: py - 2.5, width: w + 2, height: o.size + 1, color: pdfColor(t.halo), opacity: 0.8 });
      sheetText(page, label, lx, py - 1.5, o, fonts);
    };
    spot(relief.highest, 'up');
    spot(relief.lowest, 'down');
  }
}

const HALO_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-0.7, 0], [0.7, 0], [0, -0.7], [0, 0.7], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5],
];

/** `1234567.5` as `1 234 567.5`, the coordinate style the mockups print. */
export function groupThousands(s: string): string {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [int, frac] = body.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`;
}

/** A side-panel block: its height at type scale `k`, and how to draw it. */
interface PanelBlock {
  readonly height: (w: number, k: number) => number;
  readonly draw: (x: number, yTop: number, w: number, k: number) => void;
}

/** What blocks read when they are drawn: the facts with the final map scale, and the map transform. */
interface PanelContext {
  facts: MapSheetFacts;
  tr: MapTransform | null;
}

const MARGIN = 30;
const FOOTER_H = 18;
const TICK_ROOM = 14;
/** Space between panel groups: a step above the space inside a group. */
const BLOCK_GAP = SHEET_SPACE.lg;
/** Type scales tried, largest first. Below the last, text would print smaller than about 5 points. */
const SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.75];

interface Layout {
  readonly frame: Frame;
  readonly k: number;
  readonly placed: ReadonlyArray<{ readonly block: PanelBlock; readonly panel: Frame; readonly y: number }>;
}

/** Flows `blocks` down `panels` in order at scale `k`; null when they do not fit. */
function flow(blocks: readonly PanelBlock[], panels: readonly Frame[], k: number): Layout['placed'] | null {
  const out: Array<{ block: PanelBlock; panel: Frame; y: number }> = [];
  let col = 0;
  let y = panels[0]!.y + panels[0]!.h;
  for (const block of blocks) {
    let h = block.height(panels[col]!.w, k);
    while (y - h < panels[col]!.y) {
      col++;
      if (col >= panels.length) return null;
      y = panels[col]!.y + panels[col]!.h;
      h = block.height(panels[col]!.w, k);
    }
    out.push({ block, panel: panels[col]!, y });
    y -= h + BLOCK_GAP * k;
  }
  return out;
}

/**
 * The map frame and panel columns for a page, trying the roomiest map first:
 * a landscape sheet keeps one column beside the map and adds a strip of two
 * columns under the map only when the column cannot hold every block; a
 * portrait sheet puts two columns under the map and makes them taller only
 * when needed. Within each arrangement the type scale steps down before the
 * next arrangement is tried. Every block is always placed.
 */
function chooseLayout(PW: number, PH: number, blocks: readonly PanelBlock[]): Layout {
  const M = MARGIN;
  const candidates: Array<{ frame: Frame; panels: Frame[] }> = [];
  if (PW > PH) {
    const panelW = Math.min(310, Math.max(210, PW * 0.3));
    const mapW = PW - 2 * M - panelW - 24 - TICK_ROOM;
    const right: Frame = { x: PW - M - panelW, y: M + FOOTER_H, w: panelW, h: PH - 2 * M - FOOTER_H };
    candidates.push({ frame: { x: M + TICK_ROOM, y: M + FOOTER_H + TICK_ROOM, w: mapW, h: PH - 2 * M - FOOTER_H - TICK_ROOM }, panels: [right] });
    for (const stripH of [PH * 0.22, PH * 0.3]) {
      const colW = (mapW + TICK_ROOM - 22) / 2;
      candidates.push({
        frame: { x: M + TICK_ROOM, y: M + FOOTER_H + stripH + TICK_ROOM + 8, w: mapW, h: PH - 2 * M - FOOTER_H - stripH - TICK_ROOM - 8 },
        panels: [right, { x: M, y: M + FOOTER_H, w: colW, h: stripH }, { x: M + colW + 22, y: M + FOOTER_H, w: colW, h: stripH }],
      });
    }
  } else {
    const colGap = 22;
    const colW = (PW - 2 * M - colGap) / 2;
    for (const share of [0.34, 0.42, 0.5]) {
      const panelH = PH * share;
      candidates.push({
        frame: { x: M + TICK_ROOM, y: M + FOOTER_H + panelH + TICK_ROOM + 10, w: PW - 2 * M - TICK_ROOM, h: PH - 2 * M - FOOTER_H - panelH - TICK_ROOM - 10 },
        panels: [{ x: M, y: M + FOOTER_H, w: colW, h: panelH }, { x: M + colW + colGap, y: M + FOOTER_H, w: colW, h: panelH }],
      });
    }
  }
  for (const c of candidates) {
    for (const k of SCALES) {
      const placed = flow(blocks, c.panels, k);
      if (placed) return { frame: c.frame, k, placed };
    }
  }
  // Nothing fits: the roomiest arrangement at the smallest scale, blocks stacked
  // in order down its columns, the last column running on as far as it must.
  const last = candidates[candidates.length - 1]!;
  const k = SCALES[SCALES.length - 1]!;
  const placed: Array<{ block: PanelBlock; panel: Frame; y: number }> = [];
  let col = 0;
  let y = last.panels[0]!.y + last.panels[0]!.h;
  for (const block of blocks) {
    const h = block.height(last.panels[col]!.w, k);
    if (y - h < last.panels[col]!.y && col < last.panels.length - 1 && placed.some((p) => p.panel === last.panels[col])) {
      col++;
      y = last.panels[col]!.y + last.panels[col]!.h;
    }
    placed.push({ block, panel: last.panels[col]!, y });
    y -= h + BLOCK_GAP * k;
  }
  return { frame: last.frame, k, placed };
}

function panelBlocks(
  page: PDFPage,
  input: MapSheetInput,
  ctx: PanelContext,
  relief: ContourSheetRelief | null,
  t: SheetTokens,
  f: SheetFonts,
  size: string,
  orient: string,
): PanelBlock[] {
  const unit = mapLinearUnitLabel(input.linearUnit);
  const vSuffix = ctx.facts.verticalSuffix;
  // A resolved unit is a short word (" m", " ft"); the unverified hedge is a parenthesis.
  const zUnit = vSuffix.trim().startsWith('(') ? '' : vSuffix.trim();
  const oz = input.worldOrigin?.z ?? 0;
  const blocks: PanelBlock[] = [];
  const SL = sectionLabelHeight;
  const noteStep = (k: number): number => SHEET_TYPE.note * k * 1.4;

  // ── header ───────────────────────────────────────────────────────────────
  const title = input.title ?? 'Contour Map';
  const subtitle = input.relief
    ? `Contours from the analysed ground surface, ${fmtNum(input.relief.cellSize)} ${unit} cells`
    : 'Contours from the analysed ground surface';
  const titleLines = (w: number, k: number): { lines: string[]; size: number } => {
    let sz = SHEET_TYPE.title * k;
    while (sz > 11 * k && sheetTextWidth(title, f.sansBold, sz, f) > w) sz -= 0.5;
    return { lines: wrapSheetText(title, f.sansBold, sz, w, f).slice(0, 2), size: sz };
  };
  const subLines = (w: number, k: number): string[] => wrapSheetText(subtitle, f.sans, SHEET_TYPE.subtitle * k, w, f);
  blocks.push({
    height: (w, k) => {
      const tl = titleLines(w, k);
      return SHEET_TYPE.kicker * k + 6 * k + tl.lines.length * tl.size * 1.15 + 3 * k + subLines(w, k).length * SHEET_TYPE.subtitle * k * 1.35;
    },
    draw: (x, y, w, k) => {
      let cy = y - SHEET_TYPE.kicker * k;
      sheetText(page, 'CONTOUR MAP', x, cy, { font: f.sansBold, size: SHEET_TYPE.kicker * k, color: t.accent }, f);
      cy -= 6 * k;
      const tl = titleLines(w, k);
      for (const ln of tl.lines) {
        cy -= tl.size;
        sheetText(page, ln, x, cy, { font: f.sansBold, size: tl.size, color: t.ink }, f);
        cy -= tl.size * 0.15;
      }
      cy -= 3 * k;
      for (const ln of subLines(w, k)) {
        cy -= SHEET_TYPE.subtitle * k * 1.35;
        sheetText(page, ln, x, cy + SHEET_TYPE.subtitle * k * 0.35, { font: f.sans, size: SHEET_TYPE.subtitle * k, color: t.dim }, f);
      }
    },
  });

  // ── legend: only the line kinds and marks the sheet draws ────────────────
  const kinds = new Set(input.model.features.map((ft) => contourLineKind(ft)));
  const legend: Array<[LegendKey, string]> = [];
  const line = (isIndex: boolean, kind: ContourLineKind): LegendKey => {
    const st = styledContourStroke(t, isIndex, kind);
    return { kind: 'line', color: st.color, width: st.width, ...(st.dash ? { dash: st.dash } : {}) };
  };
  legend.push([line(true, 'measured'), 'Index contour, labelled']);
  legend.push([line(false, 'measured'), `Contour interval ${ctx.facts.interval}`]);
  if (kinds.has('sparse')) legend.push([line(false, 'sparse'), 'Sparse measured ground']);
  if (kinds.has('interpolated')) legend.push([line(false, 'interpolated'), 'Contour over filled cells']);
  if (kinds.has('gap')) legend.push([line(false, 'gap'), 'Low-confidence gap']);
  if (relief) legend.push([{ kind: 'line', color: t.outline, width: t.weight.outline * 0.75 }, 'Scan footprint']);
  if (relief?.hasHoles) legend.push([{ kind: 'hatch', color: t.hatch, background: t.nodata }, 'No ground data inside the footprint']);
  if (relief?.highest) legend.push([{ kind: 'marker', color: t.ink, shape: 'up' }, 'Highest measured ground']);
  if (relief?.lowest) legend.push([{ kind: 'marker', color: t.ink, shape: 'down' }, 'Lowest measured ground']);
  blocks.push({
    height: (_w, k) => SL(k) + legend.length * legendRowHeight(k) - legendRowHeight(k) + SHEET_TYPE.legend * k,
    draw: (x, y, w, k) => {
      let cy = drawSectionLabel(page, 'Legend', x, y, w, t, f, k);
      for (const [key, label] of legend) cy = drawLegendRow(page, key, label, x, cy, t, f, k);
    },
  });

  // ── elevation ramp with histogram ────────────────────────────────────────
  if (relief && t.tintAlpha > 0 && Number.isFinite(relief.zMin) && relief.zMax > relief.zMin) {
    blocks.push({
      height: (_w, k) => SL(k) + 34 * k,
      draw: (x, y, w, k) => {
        const cy = drawSectionLabel(page, zUnit ? `Elevation (${zUnit})` : 'Elevation', x, y, w, t, f, k);
        drawRamp(page, relief, x, cy + 4 * k, w, k, oz, t, f);
      },
    });
  }

  // ── scale and north ──────────────────────────────────────────────────────
  const georef = isGeoreferenced(input);
  const north: NorthSpec = !georef ? { kind: 'local' } : input.trueNorth ? { kind: 'true', convergenceDeg: input.trueNorth.convergenceDeg } : { kind: 'grid' };
  blocks.push({
    height: (_w, k) => SL(k) + 44 * k,
    draw: (x, y, w, k) => {
      const cy = drawSectionLabel(page, 'Scale', x, y, w, t, f, k);
      let by = cy;
      if (ctx.tr) {
        by = drawScaleBar(page, { scalePtPerWorld: ctx.tr.scale, maxBarPt: Math.max(60, w - 95), unitFor: (g) => scaleBarUnit(g, input.linearUnit) }, x, cy + 2 * k, t, f);
      }
      const sheetName = `${size === 'a3' ? 'A3' : size === 'a4' ? 'A4' : 'Letter'} ${orient}`;
      const ratio = ctx.facts.scaleLabel.startsWith('1:') ? `${ctx.facts.scaleLabel} at ${sheetName}` : `Scale: ${ctx.facts.scaleLabel}`;
      sheetText(page, ratio, x, by - 4 * k, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
      drawNorthArrow(page, north, x + w - 34, cy - 16 * k, t, f);
    },
  });

  // ── data block ───────────────────────────────────────────────────────────
  const rows = (): DataRow[] => {
    const out: DataRow[] = [
      { key: 'CRS', value: ctx.facts.crs },
      { key: 'Vertical', value: ctx.facts.datum },
    ];
    if (input.relief) out.push({ key: 'Grid', value: `${fmtNum(input.relief.cellSize)} ${unit} cells` });
    out.push({ key: 'Interval', value: ctx.facts.interval });
    if (relief && Number.isFinite(relief.zMin)) {
      out.push({ key: 'Relief', value: `${(relief.zMin + oz).toFixed(1)} - ${(relief.zMax + oz).toFixed(1)}${vSuffix}` });
      const drawn = relief.measuredCells + relief.filledCells;
      if (drawn > 0) out.push({ key: 'Ground', value: `${pct(relief.measuredCells, drawn)} measured, ${pct(relief.filledCells, drawn)} filled (dashed)` });
    }
    out.push({ key: 'Style', value: ctx.facts.styleLabel });
    if (relief) out.push({ key: 'Shading', value: 'Four-light hillshade, NW key' });
    out.push({ key: 'Generated', value: ctx.facts.generated });
    out.push({ key: 'Prepared by', value: ctx.facts.preparedBy });
    return out;
  };
  const shareLines = (w: number, k: number): string[] =>
    contourShareSheetLines(modelLengthShares(input.model), w, SHEET_TYPE.note * k, (s, sz) => sheetTextWidth(s, f.sans, sz, f));
  const basisLines = (w: number, k: number): string[] =>
    ctx.facts.analysedBasis ? wrapSheetText(`Analysed basis: ${ctx.facts.analysedBasis}`, f.sans, SHEET_TYPE.note * k, w, f).slice(0, 4) : [];
  blocks.push({
    height: (w, k) => SL(k) + dataBlockHeight(rows(), w, f, 64, k) + (shareLines(w, k).length + basisLines(w, k).length) * noteStep(k),
    draw: (x, y, w, k) => {
      let cy = drawSectionLabel(page, 'Data', x, y, w, t, f, k);
      cy = drawDataBlock(page, rows(), x, cy, w, t, f, 64, k);
      cy += SHEET_TYPE.dataValue * 1.5 * k - noteStep(k);
      for (const ln of [...shareLines(w, k), ...basisLines(w, k)]) {
        cy -= noteStep(k);
        sheetText(page, ln, x, cy + noteStep(k), { font: f.sans, size: SHEET_TYPE.note * k, color: t.dim }, f);
      }
    },
  });

  // ── accuracy, readiness, evidence ────────────────────────────────────────
  // The figures as a data block, like the panel's other figures; the sample
  // note, readiness and evidence follow as sentences.
  const ACC_KEY_W = 128;
  interface Ln { text: string; color: SheetRgb; font: PDFFont }
  const accRows = (_w: number, k: number): DataRow[] => ctx.facts.accuracyRows.map(([label, value, short]) => ({
    key: short && sheetTextWidth(label.toUpperCase(), f.sansBold, SHEET_TYPE.dataKey * k, f) > ACC_KEY_W * k - 6 ? short : label,
    value,
  }));
  const accText = (w: number, k: number): Ln[] => {
    const facts = ctx.facts;
    const sz = SHEET_TYPE.note * k;
    const out: Ln[] = [];
    if (facts.accuracySampleNote) for (const ln of wrapSheetText(facts.accuracySampleNote, f.sans, sz, w, f)) out.push({ text: ln, color: t.dim, font: f.sans });
    const readyColor = facts.readiness === 'ready' ? t.ink : t.warn;
    for (const ln of wrapSheetText(facts.readinessNote, f.sansBold, sz, w, f)) out.push({ text: ln, color: readyColor, font: f.sansBold });
    for (const ln of wrapSheetText(facts.evidenceLine, f.sans, sz, w, f)) out.push({ text: ln, color: facts.evidenceValidated ? t.dim : t.warn, font: f.sans });
    return out;
  };
  blocks.push({
    height: (w, k) => SL(k) + dataBlockHeight(accRows(w, k), w, f, ACC_KEY_W, k) + SHEET_SPACE.xs * k + accText(w, k).length * noteStep(k),
    draw: (x, y, w, k) => {
      let cy = drawSectionLabel(page, ctx.facts.accuracyHeading, x, y, w, t, f, k);
      cy = drawDataBlock(page, accRows(w, k), x, cy, w, t, f, ACC_KEY_W, k) - SHEET_SPACE.xs * k + noteStep(k);
      for (const ln of accText(w, k)) {
        cy -= noteStep(k);
        sheetText(page, ln.text, x, cy, { font: ln.font, size: SHEET_TYPE.note * k, color: ln.color }, f);
      }
    },
  });

  // ── notes ────────────────────────────────────────────────────────────────
  const notes = (input.notes ?? '').trim();
  if (notes) {
    const noteLines = (w: number, k: number): string[] => wrapSheetText(notes, f.sans, SHEET_TYPE.note * k, w, f).slice(0, 4);
    blocks.push({
      height: (w, k) => SL(k) + noteLines(w, k).length * noteStep(k),
      draw: (x, y, w, k) => {
        let cy = drawSectionLabel(page, 'Project / notes', x, y, w, t, f, k) + noteStep(k);
        for (const ln of noteLines(w, k)) {
          cy -= noteStep(k);
          sheetText(page, ln, x, cy, { font: f.sans, size: SHEET_TYPE.note * k, color: t.ink }, f);
        }
      },
    });
  }
  return blocks;
}

function drawRamp(page: PDFPage, relief: ContourSheetRelief, x: number, yTop: number, w: number, k: number, oz: number, t: SheetTokens, f: SheetFonts): void {
  const histH = 12 * k, rampH = 10 * k;
  const bins = relief.histogram.length;
  const peak = Math.max(1, ...relief.histogram);
  const bw = w / bins;
  for (let i = 0; i < bins; i++) {
    const hgt = (relief.histogram[i]! / peak) * histH;
    if (hgt > 0) page.drawRectangle({ x: x + i * bw, y: yTop - histH, width: bw, height: hgt, color: pdfColor(t.dim), opacity: 0.55 });
  }
  const steps = 48;
  const sw = w / steps;
  const grey = t.shadeHi;
  for (let i = 0; i < steps; i++) {
    const c = tintAt(t, (i + 0.5) / steps)!;
    const a = Math.min(1, t.tintAlpha * 1.6);
    page.drawRectangle({
      x: x + i * sw, y: yTop - histH - rampH, width: sw + 0.2, height: rampH,
      color: pdfColor([grey * (1 - a) + c[0] * a, grey * (1 - a) + c[1] * a, grey * (1 - a) + c[2] * a]),
    });
  }
  page.drawRectangle({ x, y: yTop - histH - rampH, width: w, height: rampH, borderColor: pdfColor(t.rule), borderWidth: 0.4 });
  const lo = relief.zMin + oz, hi = relief.zMax + oz;
  const step = niceStep(hi - lo, 4);
  const dec = tickDecimals(step);
  const o = { font: f.mono, size: SHEET_TYPE.tick * k, color: t.dim };
  let lastRight = -Infinity;
  for (const v of gridTicks(lo, hi, step)) {
    const px = x + ((v - lo) / (hi - lo)) * w;
    const s = v.toFixed(dec);
    const tw = sheetTextWidth(s, f.mono, o.size, f);
    const lx = Math.min(x + w - tw, Math.max(x, px - tw / 2));
    if (lx < lastRight + 4) continue;
    sheetText(page, s, lx, yTop - histH - rampH - 9 * k, o, f);
    lastRight = lx + tw;
  }
}

function fmtNum(v: number): string {
  return String(Number(v.toPrecision(4)));
}

function pct(n: number, d: number): string {
  return `${((100 * n) / d).toFixed(1)} %`;
}

