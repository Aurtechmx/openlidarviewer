/**
 * mapSheetPdf.ts
 *
 * A printable, standards-aware contour MAP SHEET — the deliverable a surveyor
 * hands a client. Vector contours (index bold + labelled, intermediate hairline,
 * dashed where interpolated) over a clean sheet, wrapped in a cartographic
 * collar: a coordinate graticule with UTM-style tick labels, a round scale bar,
 * a north arrow, a legend that explains the line types, and a title block
 * carrying the CRS, vertical datum, map scale, date, and the validated ASPRS /
 * USGS 3DEP accuracy (NVA / VVA / Quality Level) with an honest readiness note.
 *
 * Pure: pdf-lib only (no DOM / canvas), so it produces bytes anywhere and is
 * unit-testable. pdf-lib is imported here so the whole module lands in its own
 * lazy chunk. The caller triggers the download.
 */

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ContourFeatureModel } from '../../terrain/contour/contourFeatureModel';
import type { ContourLabel } from '../../terrain/contour/labelPlacement';
import type { DemAccuracyStandards } from '../../terrain/quality/demAccuracyStandards';
import {
  fitTransform,
  niceStep,
  gridTicks,
  scaleBar,
  mapScaleRatio,
  type Box,
} from '../../terrain/contour/mapSheetLayout';

export type SheetSize = 'letter' | 'a4' | 'a3';
export type SheetOrientation = 'portrait' | 'landscape';

export interface MapSheetInput {
  readonly model: ContourFeatureModel;
  readonly labels: ReadonlyArray<ContourLabel>;
  /** Cell size (source units) — only used for a provenance note. */
  readonly cellSizeM?: number;
  /** Add to local coords to recover world (CRS) coords for the graticule. */
  readonly worldOrigin?: { readonly x: number; readonly y: number } | null;
  readonly crs?: string | null;
  readonly verticalDatum?: string | null;
  readonly accuracy?: DemAccuracyStandards | null;
  readonly readiness?: 'ready' | 'previewOnly' | 'blocked';
  readonly title?: string;
  readonly preparedBy?: string;
  readonly sheet?: SheetSize;
  readonly orientation?: SheetOrientation;
  readonly generatedAt?: Date;
}

const SHEET_PT: Record<SheetSize, readonly [number, number]> = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
};

const INK = rgb(0.12, 0.14, 0.18);
const DIM = rgb(0.42, 0.46, 0.52);
const FRAME = rgb(0.2, 0.22, 0.26);
const SEPIA = rgb(0.36, 0.24, 0.13);
const SEPIA_INDEX = rgb(0.26, 0.16, 0.07);
const WHITE = rgb(1, 1, 1);

/** Keep every drawn string WinAnsi-encodable (StandardFonts throw otherwise). */
function safe(s: string): string {
  const map: Record<string, string> = {
    '×': 'x', '—': '-', '–': '-', '•': '-', '’': "'", '“': '"', '”': '"', '…': '...', '°': ' deg',
  };
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => map[ch] ?? '?');
}

/** Build the map-sheet PDF and return its bytes. */
export async function buildMapSheetPdf(input: MapSheetInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const size = input.sheet ?? 'letter';
  const orient = input.orientation ?? 'portrait';
  let [PW, PH] = SHEET_PT[size];
  if (orient === 'landscape') [PW, PH] = [PH, PW];
  const page = doc.addPage([PW, PH]);

  const M = 36;
  const TB = 132; // title-block strip height at the bottom
  const gap = 8;
  const frame = { x: M, y: M + TB + gap, w: PW - 2 * M, h: PH - 2 * M - TB - gap };

  const text = (s: string, x: number, y: number, sz: number, f: PDFFont = font, c = INK): void => {
    page.drawText(safe(s), { x, y, size: sz, font: f, color: c });
  };
  const rightText = (s: string, xRight: number, y: number, sz: number, f: PDFFont = font, c = INK): void => {
    text(s, xRight - f.widthOfTextAtSize(safe(s), sz), y, sz, f, c);
  };

  const bbox = input.model.bbox;
  // ── map frame ────────────────────────────────────────────────────────────
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: FRAME, borderWidth: 1, color: WHITE });

  if (!bbox || input.model.features.length === 0) {
    text('No contours to map.', frame.x + 12, frame.y + frame.h - 20, 11, font, DIM);
  } else {
    drawMap(page, PH, frame, bbox, input, font, bold);
  }

  // ── title block ──────────────────────────────────────────────────────────
  drawTitleBlock(page, PW, M, TB, frame, bbox, input, font, bold, text, rightText);

  return doc.save();
}

/** Contours + graticule + scale bar + north arrow inside the map frame. */
function drawMap(
  page: PDFPage,
  PH: number,
  frame: { x: number; y: number; w: number; h: number },
  bbox: Box,
  input: MapSheetInput,
  font: PDFFont,
  bold: PDFFont,
): void {
  // Small inset so contours don't touch the frame border.
  const pad = 6;
  const inner = { x: frame.x + pad, y: frame.y + pad, w: frame.w - 2 * pad, h: frame.h - 2 * pad };
  const t = fitTransform(bbox, inner);
  // world/local point → y-up page point.
  const pageX = (wx: number): number => t.ox + (wx - bbox.minX) * t.scale;
  const pageY = (wy: number): number => t.oy + (wy - bbox.minY) * t.scale;
  // pdf-lib drawSvgPath places (0,0) at options.{x,y} with +y DOWN, so a y-up
  // page point py is written as the svg-y (PH - py) with the origin at (0, PH).
  const svgY = (py: number): number => PH - py;

  // ── graticule (UTM-style ticks) ──────────────────────────────────────────
  const origin = input.worldOrigin ?? { x: 0, y: 0 };
  const worldMinX = bbox.minX + origin.x;
  const worldMaxX = bbox.maxX + origin.x;
  const worldMinY = bbox.minY + origin.y;
  const worldMaxY = bbox.maxY + origin.y;
  const stepX = niceStep(worldMaxX - worldMinX, 5);
  const stepY = niceStep(worldMaxY - worldMinY, 5);
  const labelGrid = input.worldOrigin != null;
  for (const wx of gridTicks(worldMinX, worldMaxX, stepX)) {
    const px = pageX(wx - origin.x);
    if (px < inner.x || px > inner.x + inner.w) continue;
    page.drawLine({ start: { x: px, y: frame.y }, end: { x: px, y: frame.y + 6 }, thickness: 0.5, color: FRAME });
    page.drawLine({ start: { x: px, y: frame.y + frame.h }, end: { x: px, y: frame.y + frame.h - 6 }, thickness: 0.5, color: FRAME });
    if (labelGrid) {
      const s = `${Math.round(wx)}E`;
      page.drawText(safe(s), { x: px - font.widthOfTextAtSize(s, 6) / 2, y: frame.y + frame.h + 2, size: 6, font, color: DIM });
    }
  }
  for (const wy of gridTicks(worldMinY, worldMaxY, stepY)) {
    const py = pageY(wy - origin.y);
    if (py < inner.y || py > inner.y + inner.h) continue;
    page.drawLine({ start: { x: frame.x, y: py }, end: { x: frame.x + 6, y: py }, thickness: 0.5, color: FRAME });
    page.drawLine({ start: { x: frame.x + frame.w, y: py }, end: { x: frame.x + frame.w - 6, y: py }, thickness: 0.5, color: FRAME });
    if (labelGrid) {
      const s = `${Math.round(wy)}N`;
      page.drawText(safe(s), { x: frame.x - 2 - font.widthOfTextAtSize(s, 6), y: py - 3, size: 6, font, color: DIM });
    }
  }

  // ── contours ─────────────────────────────────────────────────────────────
  for (const f of input.model.features) {
    if (f.coordinates.length < 2) continue;
    let d = '';
    for (let i = 0; i < f.coordinates.length; i++) {
      const [wx, wy] = f.coordinates[i];
      const cx = pageX(wx).toFixed(2);
      const cy = svgY(pageY(wy)).toFixed(2);
      d += `${i === 0 ? 'M' : 'L'}${cx} ${cy} `;
    }
    if (f.closed) d += 'Z';
    const width = f.isIndex ? 1.1 : 0.45;
    const color = f.isIndex ? SEPIA_INDEX : SEPIA;
    const opts: Parameters<PDFPage['drawSvgPath']>[1] = {
      x: 0,
      y: PH,
      borderColor: color,
      borderWidth: width,
    };
    if (f.grade === 'dashed') opts.borderDashArray = [width * 5, width * 4];
    else if (f.grade === 'gap') { opts.borderDashArray = [width * 2, width * 5]; opts.borderOpacity = 0.5; }
    page.drawSvgPath(d, opts);
  }

  // ── index-contour elevation labels (with a white knock-out behind) ───────
  for (const lab of input.labels) {
    const px = pageX(lab.x);
    const py = pageY(lab.y);
    if (px < inner.x || px > inner.x + inner.w || py < inner.y || py > inner.y + inner.h) continue;
    let deg = (lab.angleRad * 180) / Math.PI;
    if (deg > 90) deg -= 180; else if (deg < -90) deg += 180;
    const s = `${Math.round(lab.value)}`;
    const sz = 6.5;
    const w = bold.widthOfTextAtSize(s, sz);
    // knock-out box (rotation-agnostic, slightly padded)
    page.drawRectangle({ x: px - w / 2 - 1.5, y: py - sz / 2, width: w + 3, height: sz + 1, color: WHITE, opacity: 0.85 });
    page.drawText(s, { x: px - w / 2, y: py - sz / 2 + 1, size: sz, font: bold, color: SEPIA_INDEX, rotate: degrees(deg) });
  }

  // ── north arrow (top-right inside frame) ─────────────────────────────────
  const nx = frame.x + frame.w - 22;
  const ny = frame.y + frame.h - 30;
  page.drawSvgPath(`M ${nx} ${PH - (ny + 14)} L ${nx - 5} ${PH - (ny - 6)} L ${nx} ${PH - (ny - 2)} L ${nx + 5} ${PH - (ny - 6)} Z`, {
    x: 0, y: PH, color: INK, borderColor: INK, borderWidth: 0.5,
  });
  page.drawText('N', { x: nx - bold.widthOfTextAtSize('N', 8) / 2, y: ny - 18, size: 8, font: bold, color: INK });

  // ── scale bar (bottom-left inside frame) ─────────────────────────────────
  const bar = scaleBar(t.scale, 150);
  if (bar.barPt > 0) {
    const bx = frame.x + 12;
    const by = frame.y + 14;
    page.drawRectangle({ x: bx - 6, y: by - 9, width: bar.barPt + 40, height: 26, color: WHITE, opacity: 0.85 });
    const segPt = bar.barPt / bar.segments;
    for (let i = 0; i < bar.segments; i++) {
      page.drawRectangle({ x: bx + i * segPt, y: by, width: segPt, height: 4, color: i % 2 === 0 ? INK : WHITE, borderColor: INK, borderWidth: 0.5 });
    }
    const unit = bar.totalGround >= 1000 ? 'km' : 'm';
    const scl = bar.totalGround >= 1000 ? 1000 : 1;
    for (let i = 0; i <= bar.segments; i++) {
      const v = (bar.segGround * i) / scl;
      const lbl = `${Number.isInteger(v) ? v : v.toFixed(1)}`;
      page.drawText(safe(lbl), { x: bx + i * segPt - font.widthOfTextAtSize(lbl, 6) / 2, y: by + 6, size: 6, font, color: INK });
    }
    page.drawText(unit, { x: bx + bar.barPt + 4, y: by, size: 6, font, color: DIM });
  }
}

/** Title block with CRS, datum, scale, accuracy, legend, and provenance. */
function drawTitleBlock(
  page: PDFPage,
  PW: number,
  M: number,
  TB: number,
  frame: { x: number; y: number; w: number; h: number },
  bbox: Box | null,
  input: MapSheetInput,
  font: PDFFont,
  bold: PDFFont,
  text: (s: string, x: number, y: number, sz: number, f?: PDFFont, c?: ReturnType<typeof rgb>) => void,
  rightText: (s: string, xRight: number, y: number, sz: number, f?: PDFFont, c?: ReturnType<typeof rgb>) => void,
): void {
  const topY = M + TB;
  page.drawLine({ start: { x: M, y: topY }, end: { x: PW - M, y: topY }, thickness: 1, color: FRAME });

  // Left column — identity + reference frame.
  const lx = M + 4;
  text(input.title ?? 'Contour Map', lx, topY - 16, 14, bold);
  const interval = input.model.intervalM;
  const scaleN =
    bbox && frame.w > 0
      ? Math.round(mapScaleRatio(fitTransform(bbox, { x: frame.x + 6, y: frame.y + 6, w: frame.w - 12, h: frame.h - 12 }).scale))
      : 0;
  const rows: Array<[string, string]> = [
    ['Horizontal CRS', input.crs ?? '— not georeferenced'],
    ['Vertical datum', input.verticalDatum ?? '—'],
    ['Contour interval', Number.isFinite(interval) ? `${interval} ${input.crs ? '' : '(units)'}`.trim() : '—'],
    ['Approx. scale', scaleN > 0 ? `1:${scaleN.toLocaleString()}` : '—'],
    ['Generated', (input.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'],
    ['Prepared by', input.preparedBy ?? '—'],
  ];
  rows.forEach((r, i) => {
    const y = topY - 34 - i * 13;
    text(r[0], lx, y, 7.5, bold, DIM);
    text(r[1], lx + 86, y, 7.5, font, INK);
  });

  // Middle column — legend.
  const mxx = M + (PW - 2 * M) * 0.46;
  text('Legend', mxx, topY - 16, 9, bold);
  const sample = (y: number, label: string, dash: number[] | null, w: number, c = SEPIA): void => {
    const opts: Parameters<PDFPage['drawLine']>[0] = { start: { x: mxx, y: y + 2 }, end: { x: mxx + 26, y: y + 2 }, thickness: w, color: c };
    if (dash) opts.dashArray = dash;
    page.drawLine(opts);
    text(label, mxx + 32, y, 7, font, INK);
  };
  sample(topY - 32, 'Index contour (labelled)', null, 1.1, SEPIA_INDEX);
  sample(topY - 45, 'Intermediate contour', null, 0.5);
  sample(topY - 58, 'Interpolated (uncertain)', [4, 3], 0.5);
  sample(topY - 71, 'Low-confidence gap', [2, 4], 0.5);
  const interpPct = Math.round((input.model.interpolatedFraction || 0) * 100);
  text(`${interpPct}% of contour length is interpolated`, mxx, topY - 88, 6.5, font, DIM);

  // Right column — accuracy + readiness + provenance.
  const rxr = PW - M - 4;
  rightText('Survey accuracy', rxr, topY - 16, 9, bold);
  const a = input.accuracy ?? null;
  const fmtM = (v: number | null | undefined): string => (v != null && Number.isFinite(v) ? `${v.toFixed(2)} m` : '—');
  const aRows: Array<[string, string]> = [
    ['NVA (95%)', fmtM(a?.nvaM)],
    ['VVA (95th pct)', fmtM(a?.vvaM)],
    ['RMSEz', fmtM(a?.rmseZM)],
    ['USGS 3DEP', a && a.qualityLevel !== 'unknown' ? a.qualityLevel : '—'],
  ];
  aRows.forEach((r, i) => {
    const y = topY - 34 - i * 13;
    rightText(`${r[0]}:  ${r[1]}`, rxr, y, 7.5, font, INK);
  });
  const readiness = input.readiness ?? 'previewOnly';
  const note =
    readiness === 'ready'
      ? 'Survey-grade: validated against held-out ground.'
      : 'PREVIEW - not survey-grade until validated against control.';
  rightText(note, rxr, topY - 90, 6.5, bold, readiness === 'ready' ? INK : rgb(0.6, 0.2, 0.1));
  rightText('OpenLiDARViewer - terrain analysis', rxr, M - 10 + 2, 6, font, DIM);
}
