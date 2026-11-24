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
import { annotationToMapXY } from './annotationMapProjection';
import { buildAnnotationReport } from './annotationReportTable';
import type { Annotation } from '../annotate/types';
import { PDFDocument, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import { INPUT_NOT_RECORDED_NOTE, sourceSha256Text } from '../../science/exportDigestRecord';
import { crsOriginLine } from '../../science/crsOrigin';
import {
  contourLineKind,
  modelLengthShares,
  type ContourFeature,
  type ContourLineKind,
} from '../../terrain/contour/contourFeatureModel';
import { CONTOUR_SHARE_BASIS, contourShareParts } from '../../terrain/contour/evidenceGrade';
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
  clipPolyline,
  drawCoordinateTicks,
  drawDataBlock,
  drawFooter,
  drawLegendRow,
  drawMarker,
  drawNorthArrow,
  drawPaper,
  drawScaleBar,
  drawSectionLines,
  dataBlockHeight,
  legendRowHeight,
  sectionLinesHeight,
  wrapSectionLabel,
  FOOTER_NOTE_DROP,
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
import { mapSheetWords, type MapSheetWords } from '../../export/localizeMapSheet';
import type { MapSheetKey } from '../../i18n/deliverables/mapSheet';
import { grouped } from '../../i18n/numberStyle';
import { drawStyledPurposeAppendix } from './mapSheetStyledAppendix';
import {
  annotationColor, annotationLines, continuationPages, drawMarkLines, drawMarksContinuation, markLinesHeight,
  measurementLetter, measurementLines, orderedAnnotationRows, type MarksContinuation,
} from './mapSheetStyledMarks';

export { measurementLetter } from './mapSheetStyledMarks';
export { exportLocale } from '../../i18n/exportLocale';
import {
  buildMapSheetPdf,
  contourShareSheetLines,
  mapLinearUnitLabel,
  mapSheetFacts,
  purposeAppendixContent,
  type MapSheetInput,
  type MapSheetFacts,
} from './mapSheetPdf';

/** Thinnest legend swatch, points. */
const LEGEND_MIN_WIDTH = 0.5;

/** Where a legend label starts, right of its swatch, points. */
const LEGEND_TEXT_X = 34;

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
  const words = mapSheetWords(input.locale, input.onUntranslated);
  doc.setTitle(input.title ?? words.say('title'), { showInWindowTitleBar: true });
  doc.setLanguage(words.tag);
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
  const ctx: PanelContext = {
    facts: mapSheetFacts(input, 0), tr: null, offMap: { measurements: 0, annotations: 0 },
    listed: { measurements: input.measurements?.length ?? 0, annotations: annotationRowsOf(input).length },
  };
  const blocks = panelBlocks(page, input, ctx, relief, t, fonts, size, orient, words);
  const noMap = !area || (input.model.features.length === 0 && !relief?.extent);
  // When the panel cannot hold every listed mark, list fewer on sheet one and
  // continue the rest on sheets of their own, until a layout fits.
  let layout = chooseLayout(PW, PH, blocks);
  while (!layout.fits && listFewer(ctx.listed)) layout = chooseLayout(PW, PH, blocks);
  // The off-map line's room is kept whatever its count, so the count does not
  // move the layout: it is worked out once, against the final map frame.
  ctx.offMap = noMap || !area
    ? { measurements: input.measurements?.length ?? 0, annotations: sheetAnnotations(input).length }
    : offMapCounts(input, innerOf(layout.frame), fitTransform(area, innerOf(layout.frame)), area);
  const frame = layout.frame;

  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, color: pdfColor(t.panel) });
  if (noMap || !area) {
    sheetText(page, words.say('noContours'), frame.x + 12, frame.y + frame.h - 20, { font: fonts.sans, size: 11, color: t.dim }, fonts);
  } else {
    const inner = innerOf(frame);
    const fit = fitTransform(area, inner);
    ctx.tr = { area, scale: fit.scale, ox: fit.ox, oy: fit.oy };
    await drawMapLayers(doc, page, input, t, fonts, frame, inner, ctx.tr, relief, words);
  }
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: pdfColor(t.outline), borderWidth: t.weight.frame });

  if (ctx.tr) ctx.facts = mapSheetFacts(input, ctx.tr.scale);
  for (const { block, panel, y } of layout.placed) block.draw(panel.x, y, panel.w, layout.k);
  const M = MARGIN;

  // Footer: software and build on the left, the deliverable in the middle, page count right.
  const purpose = input.purpose;
  const rest: MarksContinuation = {
    measurements: (input.measurements ?? []).slice(ctx.listed.measurements),
    measurementStart: ctx.listed.measurements,
    annotations: annotationRowsOf(input).slice(ctx.listed.annotations),
  };
  const more = rest.measurements.length + rest.annotations.length > 0 ? continuationPages(rest, [PW, PH], MARGIN, t, fonts, words) : 0;
  const pages = 1 + more + (purpose ? 1 : 0);
  const buildText = input.provenance?.build ? `  ·  ${input.provenance.build}` : '';
  const footerLeft = `${words.say('footApp')}${buildText}`;
  drawFooter(page, footerLeft, `1 / ${pages}`, M, PW - M, M, t, fonts, words.draft);
  if (more > 0) drawMarksContinuation(doc, rest, [PW, PH], MARGIN, footerLeft, 2, pages, t, fonts, words);
  if (purpose) {
    const label = words.say('deliverable', { t_label: purpose.label });
    const w = sheetTextWidth(label, fonts.sansBold, SHEET_TYPE.footer, fonts);
    // A translated label is longer, so it takes the right of the draft note's line.
    const [lx, ly] = words.translated ? [PW - M - w, M - FOOTER_NOTE_DROP] : [PW - M - w - 40, M];
    sheetText(page, label, lx, ly, { font: fonts.sansBold, size: SHEET_TYPE.footer, color: t.dim }, fonts);
  }

  if (purpose) {
    const content = purposeAppendixContent(purpose, input, { hillshade: relief != null, tint: relief != null && t.tintAlpha > 0 });
    drawStyledPurposeAppendix(doc, content, [PW, PH], M, footerLeft, `${pages} / ${pages}`, t, fonts, words);
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
  words: MapSheetWords,
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
  const fmt = (v: number, dec: number, suffix: string): string => (labelGrid ? `${words.num(groupThousands(v.toFixed(dec)))}${georef ? suffix : ''}` : '');
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
      formatValue: (v) => words.num((v + labelOz).toFixed(dec)),
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

  // ── measurements and annotations, numbered; the panel lists them ─────────
  drawMarks(page, input, t, fonts, inner, pageX, pageY);

  // ── highest and lowest measured ground ───────────────────────────────────
  if (relief) {
    const oz = input.worldOrigin?.z ?? 0;
    const spot = (p: { x: number; y: number; z: number } | null, shape: 'up' | 'down'): void => {
      if (!p) return;
      const px = pageX(p.x), py = pageY(p.y);
      if (px < inner.x || px > inner.x + inner.w || py < inner.y || py > inner.y + inner.h) return;
      drawMarker(page, shape, px, py, 3, t.ink);
      const label = words.num((p.z + oz).toFixed(1));
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
  /** Listed measurements and annotations the map does not show. */
  offMap: { measurements: number; annotations: number };
  /** How many measurements and annotation rows sheet one lists; the rest continue on their own sheets. */
  listed: { measurements: number; annotations: number };
}

/** The map area inside the frame, where marks are drawn. */
function innerOf(frame: Frame): Frame {
  const pad = 6;
  return { x: frame.x + pad, y: frame.y + pad, w: frame.w - 2 * pad, h: frame.h - 2 * pad };
}

/** The line a panel block ends with when some of its marks fall off the map. */
function offMapLine(n: number, what: 'measurement' | 'annotation', words: MapSheetWords): string {
  if (what === 'measurement') return n === 1 ? words.say('offMeasurement') : words.say('offMeasurements', { n });
  return n === 1 ? words.say('offAnnotation') : words.say('offAnnotations', { n });
}

/** The sheet's name in the scale line, by size and orientation. */
const SHEET_NAME: Readonly<Record<NonNullable<MapSheetInput['sheet']>, Readonly<Record<NonNullable<MapSheetInput['orientation']>, MapSheetKey>>>> = {
  letter: { portrait: 'letterPortrait', landscape: 'letterLandscape' },
  a4: { portrait: 'a4Portrait', landscape: 'a4Landscape' },
  a3: { portrait: 'a3Portrait', landscape: 'a3Landscape' },
};

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
  /** False for the fallback, whose last column may run past the panel. */
  readonly fits: boolean;
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
    // A strip of two, then three, columns under the map, taller each time.
    for (const [cols, share] of [[2, 0.22], [2, 0.3], [3, 0.3], [3, 0.38]] as const) {
      const stripH = PH * share;
      const colW = (mapW + TICK_ROOM - 22 * (cols - 1)) / cols;
      const strip = Array.from({ length: cols }, (_, c) => ({ x: M + c * (colW + 22), y: M + FOOTER_H, w: colW, h: stripH }));
      candidates.push({
        frame: { x: M + TICK_ROOM, y: M + FOOTER_H + stripH + TICK_ROOM + 8, w: mapW, h: PH - 2 * M - FOOTER_H - stripH - TICK_ROOM - 8 },
        panels: [right, ...strip],
      });
    }
  } else {
    const colGap = 22;
    const colW = (PW - 2 * M - colGap) / 2;
    for (const share of [0.34, 0.42, 0.5, 0.58]) {
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
      if (placed) return { frame: c.frame, k, placed, fits: true };
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
  return { frame: last.frame, k, placed, fits: false };
}

function panelBlocks(
  page: PDFPage,
  input: MapSheetInput,
  ctx: PanelContext,
  relief: ContourSheetRelief | null,
  t: SheetTokens,
  f: SheetFonts,
  size: NonNullable<MapSheetInput['sheet']>,
  orient: NonNullable<MapSheetInput['orientation']>,
  words: MapSheetWords,
): PanelBlock[] {
  const unit = mapLinearUnitLabel(input.linearUnit);
  const vSuffix = ctx.facts.verticalSuffix;
  const zUnit = ctx.facts.verticalUnit;
  const oz = input.worldOrigin?.z ?? 0;
  const blocks: PanelBlock[] = [];
  // A translated heading or legend label that is too long for its column wraps.
  const headingLines = (label: string, w: number, k: number): string[] => (words.translated ? wrapSectionLabel(label, w, f, k) : [label]);
  const SL = (label: string, w: number, k: number): number => sectionLinesHeight(headingLines(label, w, k).length, k);
  const heading = (label: string, x: number, y: number, w: number, k: number): number =>
    drawSectionLines(page, headingLines(label, w, k), x, y, w, t, f, k);
  /** Width of the key column that holds `keys`, at type scale 1, never below `least`. */
  const keyWidth = (least: number, keys: readonly string[]): number =>
    (words.translated ? Math.max(least, ...keys.map((key) => sheetTextWidth(key, f.sans, SHEET_TYPE.dataKey, f) + 8)) : least);
  const noteStep = (k: number): number => SHEET_TYPE.note * k * 1.4;

  // ── header ───────────────────────────────────────────────────────────────
  const title = input.title ?? words.say('title');
  const subtitle = input.relief
    ? words.say('subtitleCells', { n: fmtNum(input.relief.cellSize), t_unit: unit })
    : words.say('subtitle');
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
      sheetText(page, words.say('kicker'), x, cy, { font: f.sansBold, size: SHEET_TYPE.kicker * k, color: t.accent }, f);
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
  // A swatch is never thinner than LEGEND_MIN_WIDTH, so a hairline kind still
  // shows in the key; its opacity matches the map, so lighter kinds read lighter.
  const line = (isIndex: boolean, kind: ContourLineKind): LegendKey => {
    const st = styledContourStroke(t, isIndex, kind);
    return { kind: 'line', color: st.color, width: Math.max(st.width, LEGEND_MIN_WIDTH), opacity: st.opacity, ...(st.dash ? { dash: st.dash } : {}) };
  };
  const indexOnly = input.purpose?.labelsIndexOnly ?? true;
  legend.push([line(true, 'measured'), words.say(indexOnly ? 'indexLabelled' : 'index')]);
  legend.push([line(false, 'measured'), words.say(indexOnly ? 'interval' : 'intervalLabelled', { u_v: words.translate(ctx.facts.interval) })]);
  if (kinds.has('sparse')) legend.push([line(false, 'sparse'), words.say('sparse')]);
  if (kinds.has('interpolated')) legend.push([line(false, 'interpolated'), words.say('filled')]);
  if (kinds.has('gap')) legend.push([line(false, 'gap'), words.say('gap')]);
  if (relief) legend.push([{ kind: 'line', color: t.outline, width: t.weight.outline * 0.75 }, words.say('footprint')]);
  if (relief?.hasHoles) legend.push([{ kind: 'hatch', color: t.hatch, background: t.nodata }, words.say('hole')]);
  if (relief?.highest) legend.push([{ kind: 'marker', color: t.ink, shape: 'up' }, words.say('highest')]);
  if (relief?.lowest) legend.push([{ kind: 'marker', color: t.ink, shape: 'down' }, words.say('lowest')]);
  if ((input.measurements?.length ?? 0) > 0) legend.push([{ kind: 'line', color: t.area, width: t.weight.area }, words.say('measurementKey')]);
  if (input.includeAnnotations && (input.annotations?.length ?? 0) > 0) legend.push([{ kind: 'marker', color: t.accent, shape: 'dot' }, words.say('annotationKey')]);
  const legendStep = (k: number): number => SHEET_TYPE.legend * 1.25 * k;
  const legendLines = (label: string, w: number, k: number): string[] =>
    (words.translated ? wrapSheetText(label, f.sans, SHEET_TYPE.legend * k, w - LEGEND_TEXT_X, f) : [label]);
  blocks.push({
    height: (w, k) => SL(words.say('legend'), w, k) + legend.length * legendRowHeight(k) - legendRowHeight(k) + SHEET_TYPE.legend * k
      + legend.reduce((a, [, label]) => a + (legendLines(label, w, k).length - 1) * legendStep(k), 0),
    draw: (x, y, w, k) => {
      let cy = heading(words.say('legend'), x, y, w, k);
      for (const [key, label] of legend) {
        const [first, ...more] = legendLines(label, w, k);
        more.forEach((ln, i) => sheetText(page, ln, x + LEGEND_TEXT_X, cy - (i + 1) * legendStep(k), { font: f.sans, size: SHEET_TYPE.legend * k, color: t.ink }, f));
        cy = drawLegendRow(page, key, first!, x, cy, t, f, k) - more.length * legendStep(k);
      }
    },
  });

  // ── elevation ramp with histogram ────────────────────────────────────────
  if (relief && t.tintAlpha > 0 && Number.isFinite(relief.zMin) && relief.zMax > relief.zMin) {
    const elevation = zUnit ? words.say('elevationUnit', { t_unit: zUnit }) : words.say('elevation');
    blocks.push({
      height: (w, k) => SL(elevation, w, k) + 34 * k,
      draw: (x, y, w, k) => {
        const cy = heading(elevation, x, y, w, k);
        drawRamp(page, relief, x, cy + 4 * k, w, k, oz, t, f, words);
      },
    });
  }

  // ── scale and north ──────────────────────────────────────────────────────
  const georef = isGeoreferenced(input);
  const north: NorthSpec = !georef ? { kind: 'local' } : input.trueNorth ? { kind: 'true', convergenceDeg: input.trueNorth.convergenceDeg } : { kind: 'grid' };
  const northWords = {
    grid: words.say('northGrid'), true: words.say('northTrue'), localUp: words.say('northLocal'), unknown: words.say('northUnknown'),
    angle: (n: string, east: boolean): string => words.say(east ? 'northEast' : 'northWest', { n }),
  };
  const plain = words.locale.lang === 'en' && words.locale.numberStyle === 'point';
  // The arrow's words end at the panel's edge; the scale bar and its unit keep clear of them.
  const northRoom = !words.translated ? 95 : 35 + Math.max(60, ...(north.kind === 'local'
    ? [sheetTextWidth(northWords.localUp, f.sansBold, SHEET_TYPE.legend, f), sheetTextWidth(northWords.unknown, f.sans, SHEET_TYPE.note, f)]
    : [sheetTextWidth(northWords[north.kind], f.sansBold, SHEET_TYPE.legend, f)]));
  blocks.push({
    height: (w, k) => SL(words.say('scale'), w, k) + 44 * k,
    draw: (x, y, w, k) => {
      const cy = heading(words.say('scale'), x, y, w, k);
      let by = cy;
      if (ctx.tr) {
        by = drawScaleBar(page, { scalePtPerWorld: ctx.tr.scale, maxBarPt: Math.max(60, w - northRoom), num: words.num, unitFor: (g) => { const u = scaleBarUnit(g, input.linearUnit); return { ...u, unit: words.translate(u.unit) }; } }, x, cy + 2 * k, t, f);
      }
      const n = ctx.facts.scaleN;
      const ratio = n == null ? words.say('scaleUnknown') : n > 0
        ? words.say('scaleAt', { u_ratio: plain ? ctx.facts.scaleLabel : `1:${grouped(words.locale.numberStyle, n)}`, u_sheet: words.say(SHEET_NAME[size][orient]) })
        : words.say('scaleNone');
      sheetText(page, ratio, x, by - 4 * k, { font: f.mono, size: SHEET_TYPE.tick, color: t.dim }, f);
      drawNorthArrow(page, north, x + w - 34, cy - 16 * k, t, f, words.translated ? { ...northWords, right: x + w } : undefined);
    },
  });

  // ── data block ───────────────────────────────────────────────────────────
  const rows = (): DataRow[] => {
    const out: DataRow[] = [
      { key: words.say('kCrs'), value: ctx.facts.crsNamed ? ctx.facts.crs : words.translate(ctx.facts.crs) },
      { key: words.say('kVertical'), value: ctx.facts.datumNamed ? ctx.facts.datum : words.translate(ctx.facts.datum) },
    ];
    if (input.relief) out.push({ key: words.say('kGrid'), value: words.say('gridCells', { n: fmtNum(input.relief.cellSize), t_unit: unit }) });
    out.push({ key: words.say('kInterval'), value: words.translate(ctx.facts.interval) });
    if (relief && Number.isFinite(relief.zMin)) {
      out.push({ key: words.say('kRelief'), value: words.translate(`${(relief.zMin + oz).toFixed(1)} – ${(relief.zMax + oz).toFixed(1)}${vSuffix}`) });
      const drawn = relief.measuredCells + relief.filledCells;
      if (drawn > 0) out.push({ key: words.say('kGround'), value: words.say('groundShares', { n: pct(relief.measuredCells, drawn), m: pct(relief.filledCells, drawn) }) });
    }
    out.push({ key: words.say('kStyle'), value: words.translate(ctx.facts.styleLabel) });
    if (relief) out.push({ key: words.say('kShading'), value: words.say('shading') });
    out.push({ key: words.say('kGenerated'), value: ctx.facts.generated });
    out.push({ key: words.say('kPrepared'), value: ctx.facts.preparedBy });
    return out;
  };
  const dataKeyW = (): number => keyWidth(64, rows().map((row) => row.key));
  const shares = modelLengthShares(input.model);
  const shareText = (): string => (Number.isFinite(shares.interpolated)
    ? `${contourShareParts(shares).map((part) => words.translate(part)).join(' · ')} ${words.translate(CONTOUR_SHARE_BASIS)}`
    : words.say('sharesNone'));
  const shareLines = (w: number, k: number): string[] => words.translated
    ? wrapSheetText(shareText(), f.sans, SHEET_TYPE.note * k, w, f)
    : contourShareSheetLines(shares, w, SHEET_TYPE.note * k, (s, sz) => sheetTextWidth(s, f.sans, sz, f));
  const basisLines = (w: number, k: number): string[] =>
    ctx.facts.analysedBasis ? wrapSheetText(words.translate(`Analysed basis: ${ctx.facts.analysedBasis}`), f.sans, SHEET_TYPE.note * k, w, f).slice(0, words.translated ? undefined : 4) : [];
  blocks.push({
    height: (w, k) => SL(words.say('data'), w, k) + dataBlockHeight(rows(), w, f, dataKeyW(), k) + SHEET_SPACE.xs * k + (shareLines(w, k).length + basisLines(w, k).length) * noteStep(k),
    draw: (x, y, w, k) => {
      let cy = heading(words.say('data'), x, y, w, k);
      cy = drawDataBlock(page, rows(), x, cy, w, t, f, dataKeyW(), k);
      cy += SHEET_TYPE.dataValue * 1.5 * k - noteStep(k) - SHEET_SPACE.xs * k;
      for (const ln of [...shareLines(w, k), ...basisLines(w, k)]) {
        cy -= noteStep(k);
        sheetText(page, ln, x, cy + noteStep(k), { font: f.sans, size: SHEET_TYPE.note * k, color: t.dim }, f);
      }
    },
  });

  // ── measurements: number, name, the panel's figure and its support ───────
  // ── measurements and annotations ─────────────────────────────────────────
  // Sheet one lists the first ctx.listed of each; a line says where the rest
  // are. The off-map line keeps its room at the widest count it could print.
  const listTail = (more: string | null, offAtMost: number, what: 'measurement' | 'annotation', w: number, k: number): string[] => [
    ...(more ? wrapSheetText(more, f.sans, SHEET_TYPE.note * k, w, f) : []),
    ...(offAtMost > 0 ? wrapSheetText(offMapLine(offAtMost, what, words), f.sans, SHEET_TYPE.note * k, w, f) : []),
  ];
  const tailHeight = (lines: number, k: number): number => (lines > 0 ? SHEET_SPACE.sm * k + lines * noteStep(k) : 0);
  const drawTail = (x: number, cy: number, w: number, k: number, more: string | null, off: number, what: 'measurement' | 'annotation'): void => {
    listTail(more, off, what, w, k).forEach((ln, j) => {
      cy -= noteStep(k) + (j === 0 ? SHEET_SPACE.sm * k : 0);
      sheetText(page, ln, x, cy, { font: f.sans, size: SHEET_TYPE.note * k, color: t.dim }, f);
    });
  };

  const ms = input.measurements ?? [];
  if (ms.length > 0) {
    const header = words.say('measurementsN', { n: ms.length });
    const lines = (w: number, k: number) => measurementLines(ms.slice(0, ctx.listed.measurements), 0, w, k, t, f, words);
    const more = (): string | null => {
      const n = ctx.listed.measurements;
      if (n >= ms.length) return null;
      return n === ms.length - 1
        ? words.say('moreMeasurement', { u_a: measurementLetter(n) })
        : words.say('moreMeasurements', { u_a: measurementLetter(n), u_b: measurementLetter(ms.length - 1) });
    };
    blocks.push({
      height: (w, k) => SL(header, w, k) + markLinesHeight(lines(w, k), k) + tailHeight(listTail(more(), ms.length, 'measurement', w, k).length, k),
      draw: (x, y, w, k) => {
        const top = heading(header, x, y, w, k) + noteStep(k);
        const cy = lines(w, k).length > 0 ? drawMarkLines(page, lines(w, k), x, top, k, t.area, f) : top;
        drawTail(x, cy, w, k, more(), ctx.offMap.measurements, 'measurement');
      },
    });
  }

  const annRows = annotationRowsOf(input);
  if (annRows.length > 0) {
    const header = words.translate(buildAnnotationReport(sheetAnnotations(input), {}).header);
    const lines = (w: number, k: number) => annotationLines(annRows.slice(0, ctx.listed.annotations), w, k, t, f, words);
    const more = (): string | null => {
      const n = annRows.length - ctx.listed.annotations;
      if (n <= 0) return null;
      return n === 1 ? words.say('moreAnnotation') : words.say('moreAnnotations', { n });
    };
    blocks.push({
      height: (w, k) => SL(header, w, k) + markLinesHeight(lines(w, k), k) + tailHeight(listTail(more(), annRows.length, 'annotation', w, k).length, k),
      draw: (x, y, w, k) => {
        const top = heading(header, x, y, w, k) + noteStep(k);
        const cy = lines(w, k).length > 0 ? drawMarkLines(page, lines(w, k), x, top, k, t.ink, f) : top;
        drawTail(x, cy, w, k, more(), ctx.offMap.annotations, 'annotation');
      },
    });
  }

  // ── accuracy, readiness, evidence ────────────────────────────────────────
  // The figures as a data block, like the panel's other figures; the sample
  // note, readiness and evidence follow as sentences.
  const ACC_KEY_W = 128;
  interface Ln { text: string; color: SheetRgb; font: PDFFont }
  const accRows = (_w: number, k: number): DataRow[] => ctx.facts.accuracyRows.map(([label, value, short]) => {
    const full = words.translate(label);
    return {
      key: short && sheetTextWidth(full, f.sans, SHEET_TYPE.dataKey * k, f) > ACC_KEY_W * k - 6 ? words.translate(short) : full,
      value: words.translate(value),
    };
  });
  const accKeyW = (w: number, k: number): number => keyWidth(ACC_KEY_W, accRows(w, k).map((row) => row.key));
  const accHeading = (): string => words.translate(ctx.facts.accuracyHeading);
  const accText = (w: number, k: number): Ln[] => {
    const facts = ctx.facts;
    const sz = SHEET_TYPE.note * k;
    const out: Ln[] = [];
    if (facts.accuracySampleNote) for (const ln of wrapSheetText(words.translate(facts.accuracySampleNote), f.sans, sz, w, f)) out.push({ text: ln, color: t.dim, font: f.sans });
    const readyColor = facts.readiness === 'ready' ? t.ink : t.warn;
    for (const ln of wrapSheetText(words.translate(facts.readinessNote), f.sansBold, sz, w, f)) out.push({ text: ln, color: readyColor, font: f.sansBold });
    for (const ln of wrapSheetText(words.translate(facts.evidenceLine), f.sans, sz, w, f)) out.push({ text: ln, color: facts.evidenceValidated ? t.dim : t.warn, font: f.sans });
    return out;
  };
  blocks.push({
    height: (w, k) => SL(accHeading(), w, k) + dataBlockHeight(accRows(w, k), w, f, accKeyW(w, k), k) + SHEET_SPACE.xs * k + accText(w, k).length * noteStep(k),
    draw: (x, y, w, k) => {
      let cy = heading(accHeading(), x, y, w, k);
      cy = drawDataBlock(page, accRows(w, k), x, cy, w, t, f, accKeyW(w, k), k) - SHEET_SPACE.xs * k + noteStep(k);
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
      height: (w, k) => SL(words.say('projectNotes'), w, k) + noteLines(w, k).length * noteStep(k),
      draw: (x, y, w, k) => {
        let cy = heading(words.say('projectNotes'), x, y, w, k) + noteStep(k);
        for (const ln of noteLines(w, k)) {
          cy -= noteStep(k);
          sheetText(page, ln, x, cy, { font: f.sans, size: SHEET_TYPE.note * k, color: t.ink }, f);
        }
      },
    });
  }
  return blocks;
}

function drawRamp(page: PDFPage, relief: ContourSheetRelief, x: number, yTop: number, w: number, k: number, oz: number, t: SheetTokens, f: SheetFonts, words: MapSheetWords): void {
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
    const s = words.num(v.toFixed(dec));
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
  return ((100 * n) / d).toFixed(1);
}


/** The annotation report rows a sheet lists, in list order. */
function annotationRowsOf(input: MapSheetInput) {
  const anns = sheetAnnotations(input);
  return anns.length > 0 ? orderedAnnotationRows(buildAnnotationReport(anns, {}).rows) : [];
}

/**
 * Lists fewer marks on sheet one: the longer list loses a quarter. False when
 * nothing is left to move to the continuation sheets.
 */
function listFewer(listed: { measurements: number; annotations: number }): boolean {
  if (listed.measurements === 0 && listed.annotations === 0) return false;
  const key = listed.measurements >= listed.annotations ? 'measurements' : 'annotations';
  listed[key] = listed[key] <= 1 ? 0 : Math.floor(listed[key] * 0.75);
  return true;
}

/** The annotations a sheet draws: only when asked for and present. */
function sheetAnnotations(input: MapSheetInput): ReadonlyArray<Annotation> {
  return input.includeAnnotations && input.annotations ? input.annotations : [];
}

/** A badge: a short label in a disc with a halo, so it reads over relief and lines. */
function badge(page: PDFPage, label: string, cx: number, cy: number, color: SheetRgb, t: SheetTokens, f: SheetFonts): void {
  const r = label.length > 1 ? 6.2 : 5.4;
  page.drawCircle({ x: cx, y: cy, size: r + 1.2, color: pdfColor(t.halo), opacity: 0.9 });
  page.drawCircle({ x: cx, y: cy, size: r, color: pdfColor(color) });
  const w = f.sansBold.widthOfTextAtSize(label, 6.5);
  page.drawText(label, { x: cx - w / 2, y: cy - 2.3, size: 6.5, font: f.sansBold, color: pdfColor(t.panel) });
}

/** Where a measurement's letter sits: the ring's centre or the line's middle. */
function badgeAt(pts: ReadonlyArray<readonly [number, number]>, closed: boolean): [number, number] {
  const n = pts.length;
  if (closed && n >= 3) return [pts.reduce((a, p) => a + p[0], 0) / n, pts.reduce((a, p) => a + p[1], 0) / n];
  if (n >= 2) {
    const a = pts[Math.floor((n - 1) / 2)]!, b = pts[Math.ceil((n - 1) / 2)]!;
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  }
  return [pts[0]![0], pts[0]![1]];
}

/** How many listed measurements and annotations get no letter or number on the map. */
function offMapCounts(input: MapSheetInput, inner: Frame, fit: { scale: number; ox: number; oy: number }, area: Box): { measurements: number; annotations: number } {
  const up = input.sceneUpAxis ?? 'z';
  const px = (x: number): number => fit.ox + (x - area.minX) * fit.scale;
  const py = (y: number): number => fit.oy + (y - area.minY) * fit.scale;
  const inside = (x: number, y: number): boolean => x >= inner.x && x <= inner.x + inner.w && y >= inner.y && y <= inner.y + inner.h;
  let measurements = 0, annotations = 0;
  for (const m of input.measurements ?? []) {
    const pts = m.points.map((p) => { const q = annotationToMapXY({ x: p[0], y: p[1], z: p[2] }, up); return [px(q.x), py(q.y)] as [number, number]; });
    if (pts.length === 0) continue;
    const [ax, ay] = badgeAt(pts, m.closed);
    if (!inside(ax, ay)) measurements++;
  }
  for (const a of sheetAnnotations(input)) {
    const q = annotationToMapXY(a.localPosition, up);
    if (!inside(px(q.x), py(q.y))) annotations++;
  }
  return { measurements, annotations };
}

function drawMarks(
  page: PDFPage,
  input: MapSheetInput,
  t: SheetTokens,
  f: SheetFonts,
  inner: Frame,
  pageX: (x: number) => number,
  pageY: (y: number) => number,
): void {
  const up = input.sceneUpAxis ?? 'z';
  const PH = page.getHeight();
  const box = { x: inner.x, y: inner.y, w: inner.w, h: inner.h };
  const inside = (x: number, y: number): boolean => x >= inner.x && x <= inner.x + inner.w && y >= inner.y && y <= inner.y + inner.h;
  (input.measurements ?? []).forEach((m, i) => {
    const pts = m.points.map((p) => {
      const q = annotationToMapXY({ x: p[0], y: p[1], z: p[2] }, up);
      return [pageX(q.x), pageY(q.y)] as [number, number];
    });
    if (pts.length === 0) return;
    const ring = m.closed && pts.length >= 3 ? [...pts, pts[0]!] : pts;
    if (m.closed && pts.length >= 3 && pts.every(([x, y]) => inside(x, y))) {
      const d = pts.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(PH - y).toFixed(2)}`).join(' ') + ' Z';
      page.drawSvgPath(d, { x: 0, y: PH, color: pdfColor(t.area), opacity: 0.1 });
    }
    for (const run of clipPolyline(ring, box)) {
      if (run.length < 2) continue;
      const d = run.map(([x, y], k) => `${k === 0 ? 'M' : 'L'}${x.toFixed(2)} ${(PH - y).toFixed(2)}`).join(' ');
      page.drawSvgPath(d, { x: 0, y: PH, borderColor: pdfColor(t.halo), borderWidth: t.weight.area + 1.6, borderOpacity: 0.7 });
      page.drawSvgPath(d, { x: 0, y: PH, borderColor: pdfColor(t.area), borderWidth: t.weight.area });
    }
    for (const [x, y] of pts) {
      if (inside(x, y)) page.drawRectangle({ x: x - 1.8, y: y - 1.8, width: 3.6, height: 3.6, color: pdfColor(t.panel), borderColor: pdfColor(t.area), borderWidth: 0.8 });
    }
    const [ax, ay] = badgeAt(pts, m.closed);
    if (inside(ax, ay)) badge(page, measurementLetter(i), ax, ay, t.area, t, f);
  });
  // Annotations: a coloured, numbered dot at each one on the map; the panel groups them by type.
  const anns = sheetAnnotations(input);
  anns.forEach((a, i) => {
    const q = annotationToMapXY(a.localPosition, up);
    const x = pageX(q.x), y = pageY(q.y);
    if (inside(x, y)) badge(page, String(i + 1), x, y, annotationColor(t, a.type), t, f);
  });
}
