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
import { contourShapeStyleLabel } from '../../terrain/contour/contourShapeStyle';
import type { DemAccuracyStandards } from '../../terrain/quality/demAccuracyStandards';
import type { ExportProvenance } from '../../terrain/export/exportProvenance';
import {
  fitTransform,
  niceStep,
  gridTicks,
  scaleBar,
  mapScaleRatio,
  type Box,
} from '../../terrain/contour/mapSheetLayout';
import { evidenceNote, evidenceStatus } from '../../validation/exportEvidenceNote';

/**
 * The claim the map sheet stands on (§19). A printed contour map sheet is the
 * CONTOURS product — synthetically validated (E3) but below its required E4
 * cross-implementation bar, so the gate marks it exploratory. The sheet stamps
 * that verdict in its collar (see {@link mapSheetEvidenceNote}) so a printed
 * deliverable carries the same honest status as the GeoJSON / DXF / DEM exports
 * of the same scan, never reading as a validated survey product.
 */
export const MAP_SHEET_CLAIM = 'CONTOURS';

/**
 * The evidence-gate note for the map sheet, DERIVED from the one gate (never
 * asserted). Pure + exported so the collar wording can be asserted without
 * rendering a PDF. Defaults to the CONTOURS claim; a caller may pass another id
 * for a differently-sourced sheet.
 */
export function mapSheetEvidenceNote(claimId: string = MAP_SHEET_CLAIM): string {
  return evidenceNote(claimId);
}

/**
 * The compact collar line drawn on the sheet — "Evidence: exploratory export"
 * etc. Concise so it fits the title-block strip; the full sentence is available
 * via {@link mapSheetEvidenceNote} for anywhere with room.
 */
export function mapSheetEvidenceLine(claimId: string = MAP_SHEET_CLAIM): string {
  const status = evidenceStatus(claimId);
  return status === 'validated'
    ? 'Evidence: validated export (meets required evidence level).'
    : status === 'refused'
      ? 'Evidence: export not permitted at current evidence level.'
      : 'Evidence: exploratory export - below required evidence level.';
}

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
  /**
   * Resolved linear unit of a projected CRS. The map frame's ground coordinates
   * are in SOURCE units, so the scale bar must label them in the right unit — a
   * foot-based CRS reads "ft", not "m". Omitted ⇒ the standing metre default.
   */
  readonly linearUnit?: 'metre' | 'foot' | 'us-survey-foot' | 'unknown';
  readonly accuracy?: DemAccuracyStandards | null;
  readonly readiness?: 'ready' | 'previewOnly' | 'blocked';
  readonly title?: string;
  readonly preparedBy?: string;
  /** Free-text "Project / Notes" block printed under the identity column. */
  readonly notes?: string;
  readonly sheet?: SheetSize;
  readonly orientation?: SheetOrientation;
  readonly generatedAt?: Date;
  /**
   * The unified export provenance. When supplied, the title block SOURCES its
   * CRS, vertical datum, contour style, accuracy, export-readiness verdict and
   * generation date FROM IT — so the map sheet can never drift from the GeoJSON
   * / DXF / SVG / DEM exports of the same scan. The layout is unchanged; only
   * the strings are single-sourced. Falls back to the discrete fields when
   * absent (back-compat).
   */
  readonly provenance?: ExportProvenance;
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

/**
 * The readiness note printed in the title block. Pure and exported so it can be
 * asserted without rendering a PDF. Per project stance, this NEVER makes a bare
 * affirmative survey-grade claim: the 'ready' state states the validation fact
 * without calling it survey-grade or a certification, and the preview state is
 * already negated.
 */
export function readinessNote(readiness: 'ready' | 'previewOnly' | 'blocked'): string {
  return readiness === 'ready'
    ? 'Validated against held-out ground - not a survey certification.'
    : 'PREVIEW - not survey-grade until validated against control.';
}

/**
 * Greedy word-wrap a string to a maximum width, capped at `maxLines`. The width
 * measurer is injected (so the function is pure and unit-testable without a
 * PDF). When the text overruns `maxLines`, the last kept line is truncated and
 * an ellipsis appended so a long note degrades gracefully instead of
 * overflowing the title strip. A single word wider than the line is hard-cut.
 */
export function wrapTextToWidth(
  textStr: string,
  maxWidthPt: number,
  fontSizePt: number,
  measure: (s: string, size: number) => number,
  maxLines = 3,
): string[] {
  const words = textStr.trim().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0 || maxWidthPt <= 0 || maxLines <= 0) return [];
  const fits = (s: string): boolean => measure(s, fontSizePt) <= maxWidthPt;
  const lines: string[] = [];
  let line = '';
  let truncated = false;
  for (let w = 0; w < words.length; w++) {
    const word = words[w];
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    // Candidate overruns. Commit the current line first.
    if (line) {
      lines.push(line);
      line = '';
      if (lines.length >= maxLines) { truncated = true; break; }
    }
    // The word alone fits on a fresh line — carry it forward.
    if (fits(word)) {
      line = word;
      continue;
    }
    // A single word wider than the line: hard-cut it to what fits.
    let chunk = '';
    for (const ch of word) {
      if (fits(chunk + ch)) chunk += ch;
      else break;
    }
    line = chunk || word.slice(0, 1);
  }
  if (line && lines.length < maxLines) lines.push(line);
  else if (line) truncated = true;

  // If anything was dropped, ellipsise the final kept line so the overrun reads
  // as deliberate truncation rather than silently vanishing.
  if (truncated && lines.length > 0) {
    const i = lines.length - 1;
    let last = lines[i];
    while (last.length > 0 && !fits(`${last}…`)) last = last.slice(0, -1);
    lines[i] = `${last}…`;
  }
  return lines;
}

/**
 * The scale-bar ground unit + per-label divisor for a given total ground length
 * and the map's SOURCE linear unit. Pure and exported so the label-vs-value
 * contract can be asserted without rendering a PDF.
 *
 * The map frame is drawn in the CRS's source units, so the bar's `totalGround`
 * is in those units. A foot CRS labels feet plainly with no km grouping — the
 * bar must never read "1 km" for what is really 1000 ft. Metres (the standing
 * default for an omitted / metre / unknown unit) group up to km past 1000.
 */
export function scaleBarUnit(
  totalGround: number,
  linearUnit: MapSheetInput['linearUnit'],
): { unit: string; divisor: number } {
  const isFootUnit = linearUnit === 'foot' || linearUnit === 'us-survey-foot';
  if (isFootUnit) return { unit: 'ft', divisor: 1 };
  const groupKm = totalGround >= 1000;
  return { unit: groupKm ? 'km' : 'm', divisor: groupKm ? 1000 : 1 };
}

/**
 * The plain linear-unit label (ft / m) for the SOURCE units the map is drawn
 * in. Single-sourced so the contour-interval row, the scale bar and the notes
 * never disagree about the unit. A non-georeferenced scan is still treated as
 * metric (the app's standing default everywhere — measurements, scale bar), so
 * the interval reads "0.5 m", not a hedged "(units)".
 */
export function mapLinearUnitLabel(linearUnit: MapSheetInput['linearUnit']): string {
  return linearUnit === 'foot' || linearUnit === 'us-survey-foot' ? 'ft' : 'm';
}

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
  // Only a truly georeferenced scan has a real east/north + true north. When it
  // isn't, the graticule labels drop the "E"/"N" compass suffix (the numbers
  // are local-frame coordinates) and the north arrow is omitted — claiming a
  // compass direction on ungeoreferenced data would be an overclaim.
  const prov = input.provenance;
  const georef = prov
    ? prov.crsKnown
    : input.crs != null && input.crs.trim() !== '' && !/not\s*georef/i.test(input.crs);
  for (const wx of gridTicks(worldMinX, worldMaxX, stepX)) {
    const px = pageX(wx - origin.x);
    if (px < inner.x || px > inner.x + inner.w) continue;
    page.drawLine({ start: { x: px, y: frame.y }, end: { x: px, y: frame.y + 6 }, thickness: 0.5, color: FRAME });
    page.drawLine({ start: { x: px, y: frame.y + frame.h }, end: { x: px, y: frame.y + frame.h - 6 }, thickness: 0.5, color: FRAME });
    if (labelGrid) {
      const s = georef ? `${Math.round(wx)}E` : `${Math.round(wx)}`;
      page.drawText(safe(s), { x: px - font.widthOfTextAtSize(s, 6) / 2, y: frame.y + frame.h + 2, size: 6, font, color: DIM });
    }
  }
  for (const wy of gridTicks(worldMinY, worldMaxY, stepY)) {
    const py = pageY(wy - origin.y);
    if (py < inner.y || py > inner.y + inner.h) continue;
    page.drawLine({ start: { x: frame.x, y: py }, end: { x: frame.x + 6, y: py }, thickness: 0.5, color: FRAME });
    page.drawLine({ start: { x: frame.x + frame.w, y: py }, end: { x: frame.x + frame.w - 6, y: py }, thickness: 0.5, color: FRAME });
    if (labelGrid) {
      const s = georef ? `${Math.round(wy)}N` : `${Math.round(wy)}`;
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

  // ── north arrow (top-right inside frame) — only when georeferenced ────────
  if (georef) {
    const nx = frame.x + frame.w - 22;
    const ny = frame.y + frame.h - 30;
    page.drawSvgPath(`M ${nx} ${PH - (ny + 14)} L ${nx - 5} ${PH - (ny - 6)} L ${nx} ${PH - (ny - 2)} L ${nx + 5} ${PH - (ny - 6)} Z`, {
      x: 0, y: PH, color: INK, borderColor: INK, borderWidth: 0.5,
    });
    page.drawText('N', { x: nx - bold.widthOfTextAtSize('N', 8) / 2, y: ny - 18, size: 8, font: bold, color: INK });
  }

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
    // Scale-bar ground unit follows the map's SOURCE linear unit (see
    // scaleBarUnit): a foot CRS reads "ft", never the metre default or a bogus
    // "km" for 1000 ft.
    const { unit, divisor: scl } = scaleBarUnit(bar.totalGround, input.linearUnit);
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

  // Single-source the title-block strings from the unified provenance when it is
  // supplied, so the sheet's CRS / datum / interval / style / accuracy / date /
  // export-readiness can never drift from the other exports of the same scan. The
  // layout is untouched — only the values are sourced from `p`.
  const prov = input.provenance;
  const crsStr = prov ? prov.horizontalCrs : (input.crs ?? '— not georeferenced');
  const datumStr = prov ? prov.verticalDatum : (input.verticalDatum ?? '—');
  const generatedStr = prov
    ? prov.generated.slice(0, 16).replace('T', ' ') + ' UTC'
    : (input.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

  // Left column — identity + reference frame.
  const lx = M + 4;
  // The title must not collide with the Legend column (which starts at the
  // 0.46 fraction). A long filename is shrunk to fit, then ellipsised at the
  // floor size — so it degrades gracefully instead of running over the legend.
  const titleStr = input.title ?? 'Contour Map';
  const titleMaxW = M + (PW - 2 * M) * 0.46 - lx - 12;
  let titleSize = 14;
  while (titleSize > 9 && bold.widthOfTextAtSize(safe(titleStr), titleSize) > titleMaxW) {
    titleSize -= 0.5;
  }
  let titleDraw = titleStr;
  if (bold.widthOfTextAtSize(safe(titleDraw), titleSize) > titleMaxW) {
    titleDraw =
      wrapTextToWidth(titleStr, titleMaxW, titleSize, (s, sz) => bold.widthOfTextAtSize(safe(s), sz), 1)[0] ??
      titleStr;
  }
  text(titleDraw, lx, topY - 16, titleSize, bold);
  const interval = prov?.contourIntervalM ?? input.model.intervalM;
  // World-unit→metres factor so the 1:N ratio stays a TRUE dimensionless ratio
  // on a foot CRS (the map is drawn in source units). 1 for metric / unknown.
  const worldUnitToMetres =
    input.linearUnit === 'foot'
      ? 0.3048
      : input.linearUnit === 'us-survey-foot'
        ? 1200 / 3937
        : 1;
  const scaleN =
    bbox && frame.w > 0
      ? Math.round(
          mapScaleRatio(
            fitTransform(bbox, { x: frame.x + 6, y: frame.y + 6, w: frame.w - 12, h: frame.h - 12 }).scale,
            worldUnitToMetres,
          ),
        )
      : 0;
  const rows: Array<[string, string]> = [
    ['Horizontal CRS', crsStr],
    ['Vertical datum', datumStr],
    ['Contour interval', interval != null && Number.isFinite(interval) ? `${interval} ${mapLinearUnitLabel(input.linearUnit)}` : '—'],
    ['Approx. scale', scaleN > 0 ? `1:${scaleN.toLocaleString()}` : '—'],
    ['Generated', generatedStr],
    ['Prepared by', input.preparedBy ?? '—'],
  ];
  rows.forEach((r, i) => {
    const y = topY - 34 - i * 13;
    text(r[0], lx, y, 7.5, bold, DIM);
    text(r[1], lx + 86, y, 7.5, font, INK);
  });

  // Middle column — legend.
  const mxx = M + (PW - 2 * M) * 0.46;

  // Project / Notes — a small wrapped block UNDER the identity rows (which end
  // at topY-99) and LEFT of the legend column (mxx), so it never collides with
  // either. Width is bounded by the legend column start; lines are capped so
  // long text truncates inside the 132pt strip rather than overflowing it.
  const notes = (input.notes ?? '').trim();
  if (notes) {
    const notesX = lx;
    const notesMaxW = Math.max(60, mxx - lx - 10);
    text('Project / Notes', notesX, topY - 110, 6, bold, DIM);
    const noteLines = wrapTextToWidth(
      notes,
      notesMaxW,
      6.5,
      (s, sz) => font.widthOfTextAtSize(safe(s), sz),
      2,
    );
    noteLines.forEach((ln, i) => text(ln, notesX, topY - 120 - i * 8.5, 6.5, font, INK));
  }
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
  // Interpolated fraction is NaN when there is no contour length to measure
  // against (an empty contour set). Report that honestly rather than collapsing
  // it to a fabricated 0%.
  const interpFraction = input.model.interpolatedFraction;
  const interpLine = Number.isFinite(interpFraction)
    ? `${Math.round(interpFraction * 100)}% of contour length is interpolated`
    : 'Interpolated fraction — not measured (no contours)';
  text(interpLine, mxx, topY - 88, 6.5, font, DIM);
  // Honest stamp of the shape style applied to the plotted contours (sourced
  // from the unified provenance when present, so it matches every other export).
  const styleLabel = prov ? prov.contourStyleLabel : contourShapeStyleLabel(input.model.contourStyle);
  text(`Contour style: ${styleLabel}`, mxx, topY - 99, 6.5, font, DIM);

  // Right column — accuracy + readiness + provenance.
  const rxr = PW - M - 4;
  rightText('Survey accuracy', rxr, topY - 16, 9, bold);
  const fmtM = (v: number | null | undefined): string => (v != null && Number.isFinite(v) ? `${v.toFixed(2)} m` : '—');
  // Accuracy rows, single-sourced from provenance when present (its accuracy
  // block is null when the run measured none, in which case every figure reads
  // '—' rather than a fabricated zero).
  const aRows: Array<[string, string]> = prov
    ? [
        // "-style (hold-out)" / "(estimated)": the printed sheet must carry
        // the same qualifiers as the Analyse-panel preview of these rows —
        // hold-out figures, not independent-checkpoint assessments.
        ['NVA-style (95%, hold-out)', fmtM(prov.accuracy?.nvaM)],
        ['VVA-style (95th pct, hold-out)', fmtM(prov.accuracy?.vvaM)],
        ['RMSEz', fmtM(prov.accuracy?.rmseZM)],
        ['USGS 3DEP', prov.accuracy && prov.accuracy.usgsQualityLevel !== 'unknown' ? `${prov.accuracy.usgsQualityLevel} (estimated)` : '—'],
      ]
    : (() => {
        const a = input.accuracy ?? null;
        return [
          ['NVA-style (95%, hold-out)', fmtM(a?.nvaM)],
          ['VVA-style (95th pct, hold-out)', fmtM(a?.vvaM)],
          ['RMSEz', fmtM(a?.rmseZM)],
          ['USGS 3DEP', a && a.qualityLevel !== 'unknown' ? `${a.qualityLevel} (estimated)` : '—'],
        ];
      })();
  aRows.forEach((r, i) => {
    const y = topY - 34 - i * 13;
    rightText(`${r[0]}:  ${r[1]}`, rxr, y, 7.5, font, INK);
  });
  // Export-readiness verdict — single-sourced from the unified provenance so the
  // sheet's readiness note can't disagree with the other exports. Maps the
  // provenance verdict (Ready / Preview / Blocked) onto the note vocabulary.
  const readiness: 'ready' | 'previewOnly' | 'blocked' = prov
    ? prov.exportReadiness === 'Ready'
      ? 'ready'
      : prov.exportReadiness === 'Blocked'
        ? 'blocked'
        : 'previewOnly'
    : input.readiness ?? 'previewOnly';
  const note = readinessNote(readiness);
  rightText(note, rxr, topY - 90, 6.5, bold, readiness === 'ready' ? INK : rgb(0.6, 0.2, 0.1));
  // Evidence-gate verdict (§19) — the SAME central gate the other exports stamp,
  // so a printed sheet carries the honest claim status (exploratory for CONTOURS
  // today) and can never read as a validated deliverable. Drawn beneath the
  // readiness note; wrapped so a long verdict degrades gracefully in the strip.
  const evLine = mapSheetEvidenceLine();
  const evColor = evidenceStatus(MAP_SHEET_CLAIM) === 'validated' ? DIM : rgb(0.6, 0.2, 0.1);
  const evWrapped = wrapTextToWidth(
    evLine,
    (PW - M - 4) - (M + (PW - 2 * M) * 0.46),
    6,
    (s, sz) => font.widthOfTextAtSize(safe(s), sz),
    2,
  );
  evWrapped.forEach((ln, i) => rightText(ln, rxr, topY - 101 - i * 8, 6, font, evColor));
  rightText('OpenLiDARViewer - terrain analysis', rxr, M - 10 + 2, 6, font, DIM);
}
