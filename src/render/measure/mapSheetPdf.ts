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
import type { ContourFeatureModel, ContourFeature } from '../../terrain/contour/contourFeatureModel';
import type { Annotation, AnnotationType } from '../annotate/types';
import { buildAnnotationReport, type AnnotationReportRow } from './annotationReportTable';
import {
  projectAnnotationToPage,
  type SceneUpAxis,
} from './annotationMapProjection';
import { decimalsForInterval, type ContourLabel } from '../../terrain/contour/labelPlacement';
import { placeContourLabels } from '../../terrain/contourStudio/contourLabelEngine';
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
  /**
   * Add to local coords to recover world coords. `x`/`y` georeference the
   * graticule; `z` (the dropped vertical origin) is added back to DISPLAYED
   * contour-elevation labels so a recentred scan reads real heights (e.g.
   * +210..+450 m) instead of the recentred-negative local frame — the same
   * additive restore the measurement and vector-export paths already apply. Map
   * GEOMETRY (x/y, the graticule) stays in the local frame; only the label
   * VALUE is shifted. Absent/zero `z` ⇒ labels read the local frame unchanged.
   */
  readonly worldOrigin?: { readonly x: number; readonly y: number; readonly z?: number } | null;
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
  /**
   * Opt-in: draw the placed annotations on the sheet (numbered markers on the
   * map + a description table in the top-right collar). Default OFF, so a sheet
   * built without this flag is byte-for-byte the pre-annotation output.
   */
  readonly includeAnnotations?: boolean;
  /**
   * The placed annotations, in list order (the marker index is the 1-based list
   * position, matching the panel and the description table). Only read when
   * {@link includeAnnotations} is true and the list is non-empty.
   */
  readonly annotations?: ReadonlyArray<Annotation>;
  /**
   * The RAW scene's up-axis, so an annotation's `localPosition` is rotated into
   * the SAME canonical frame the contour geometry lives in before it is plotted.
   * This MUST be the gather's `sourceUpAxis` (not the source format's nominal
   * axis) — see the frame reasoning in `annotationMapProjection.ts`. Defaults to
   * 'z' (the survey formats a georeferenced sheet is built from).
   */
  readonly sceneUpAxis?: SceneUpAxis;
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
const SEPIA_INDEX = rgb(0.24, 0.14, 0.05);
// A lighter sepia for INTERPOLATED contours: still continuous (it is a real
// estimate between measured ground), but visibly weaker than a measured line so
// the ~96%-interpolated preview reads as signal, not noise. Gap (unsupported)
// runs stay broken — the strongest "do not trust this line" signal.
const SEPIA_LIGHT = rgb(0.58, 0.47, 0.36);
const WHITE = rgb(1, 1, 1);

/**
 * Marker fill per annotation type. Chosen to read as a distinct inspection layer
 * OVER the sepia contour ink (cool/saturated dots against warm hairlines), and
 * to keep the four types tellable apart at print size. The description table
 * carries the type name too, so colour is a reinforcement, not the only cue.
 */
const ANNOTATION_COLORS: Record<AnnotationType, ReturnType<typeof rgb>> = {
  note: rgb(0.20, 0.40, 0.78),
  info: rgb(0.10, 0.52, 0.55),
  warning: rgb(0.85, 0.53, 0.10),
  issue: rgb(0.74, 0.16, 0.12),
};

/**
 * One place that maps a contour feature's index/grade to its drawn style, so the
 * plotting loop and the legend swatches can never disagree. Honest by
 * construction: a MEASURED line is full-ink and continuous; an INTERPOLATED line
 * is a lighter continuous tint; a low-confidence GAP is broken. INDEX contours
 * are always drawn continuous (the map's structural skeleton) and carry weight;
 * their evidence shows as a lighter ink when interpolated rather than a dash that
 * would fight the index hierarchy.
 */
export interface ContourDrawStyle {
  readonly color: ReturnType<typeof rgb>;
  readonly width: number;
  readonly dash: number[] | null;
  readonly opacity: number;
}
export function contourDrawStyle(isIndex: boolean, grade: ContourFeature['grade']): ContourDrawStyle {
  if (isIndex) {
    const w = 1.2;
    if (grade === 'solid') return { color: SEPIA_INDEX, width: w, dash: null, opacity: 1 };
    if (grade === 'dashed') return { color: SEPIA_INDEX, width: w, dash: null, opacity: 0.72 };
    return { color: SEPIA_INDEX, width: w * 0.92, dash: [w * 1.6, w * 2.2], opacity: 0.6 };
  }
  const w = 0.55;
  if (grade === 'solid') return { color: SEPIA, width: w, dash: null, opacity: 1 };
  if (grade === 'dashed') return { color: SEPIA_LIGHT, width: w * 0.92, dash: null, opacity: 0.9 };
  return { color: SEPIA_LIGHT, width: w * 0.82, dash: [1.4, 2.4], opacity: 0.6 };
}

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

  // ── neatlines ────────────────────────────────────────────────────────────
  // A double map-frame border (a hairline just outside the 1pt frame) and an
  // outer sheet neatline around the whole printable area — the finished-map
  // convention that reads as a deliverable rather than a screenshot.
  page.drawRectangle({ x: frame.x - 3, y: frame.y - 3, width: frame.w + 6, height: frame.h + 6, borderColor: FRAME, borderWidth: 0.4 });
  page.drawRectangle({ x: M - 4, y: M - 4, width: PW - 2 * M + 8, height: PH - 2 * M + 8, borderColor: FRAME, borderWidth: 0.6 });

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

  // ── graticule ────────────────────────────────────────────────────────────
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
  // are local-frame coordinates) and the north arrow is replaced by an explicit
  // "local grid up" note — claiming a compass direction on ungeoreferenced data
  // would be an overclaim.
  const prov = input.provenance;
  const georef = prov
    ? prov.crsKnown
    : input.crs != null && input.crs.trim() !== '' && !/not\s*georef/i.test(input.crs);

  const ticksX = gridTicks(worldMinX, worldMaxX, stepX)
    .map((w) => ({ w, px: pageX(w - origin.x) }))
    .filter((tk) => tk.px >= inner.x && tk.px <= inner.x + inner.w);
  const ticksY = gridTicks(worldMinY, worldMaxY, stepY)
    .map((w) => ({ w, py: pageY(w - origin.y) }))
    .filter((tk) => tk.py >= inner.y && tk.py <= inner.y + inner.h);

  // Interior graticule as faint tick-crosses at each grid intersection — the
  // survey-sheet convention that reads position without a heavy grid obscuring
  // the terrain.
  for (const tx of ticksX) {
    for (const ty of ticksY) {
      page.drawLine({ start: { x: tx.px - 2.5, y: ty.py }, end: { x: tx.px + 2.5, y: ty.py }, thickness: 0.3, color: FRAME, opacity: 0.5 });
      page.drawLine({ start: { x: tx.px, y: ty.py - 2.5 }, end: { x: tx.px, y: ty.py + 2.5 }, thickness: 0.3, color: FRAME, opacity: 0.5 });
    }
  }
  // Edge ticks + coordinate labels (top edge for eastings, left edge for northings).
  for (const tx of ticksX) {
    page.drawLine({ start: { x: tx.px, y: frame.y }, end: { x: tx.px, y: frame.y + 6 }, thickness: 0.5, color: FRAME });
    page.drawLine({ start: { x: tx.px, y: frame.y + frame.h }, end: { x: tx.px, y: frame.y + frame.h - 6 }, thickness: 0.5, color: FRAME });
    if (labelGrid) {
      const s = georef ? `${Math.round(tx.w)}E` : `${Math.round(tx.w)}`;
      page.drawText(safe(s), { x: tx.px - font.widthOfTextAtSize(s, 6) / 2, y: frame.y + frame.h + 3, size: 6, font, color: DIM });
    }
  }
  for (const ty of ticksY) {
    page.drawLine({ start: { x: frame.x, y: ty.py }, end: { x: frame.x + 6, y: ty.py }, thickness: 0.5, color: FRAME });
    page.drawLine({ start: { x: frame.x + frame.w, y: ty.py }, end: { x: frame.x + frame.w - 6, y: ty.py }, thickness: 0.5, color: FRAME });
    if (labelGrid) {
      const s = georef ? `${Math.round(ty.w)}N` : `${Math.round(ty.w)}`;
      page.drawText(safe(s), { x: frame.x - 3 - font.widthOfTextAtSize(s, 6), y: ty.py - 3, size: 6, font, color: DIM });
    }
  }

  // ── contours (intermediate first, index on top so structure never hides) ──
  const drawFeature = (f: ContourFeature): void => {
    if (f.coordinates.length < 2) return;
    let d = '';
    for (let i = 0; i < f.coordinates.length; i++) {
      const [wx, wy] = f.coordinates[i];
      d += `${i === 0 ? 'M' : 'L'}${pageX(wx).toFixed(2)} ${svgY(pageY(wy)).toFixed(2)} `;
    }
    if (f.closed) d += 'Z';
    const st = contourDrawStyle(f.isIndex, f.grade);
    const opts: Parameters<PDFPage['drawSvgPath']>[1] = {
      x: 0, y: PH, borderColor: st.color, borderWidth: st.width, borderOpacity: st.opacity,
    };
    if (st.dash) opts.borderDashArray = st.dash;
    page.drawSvgPath(d, opts);
  };
  for (const f of input.model.features) if (!f.isIndex) drawFeature(f);
  for (const f of input.model.features) if (f.isIndex) drawFeature(f);

  // ── index-contour elevation labels ───────────────────────────────────────
  // Placed by the print-aware §17 engine: upright, on the straightest supported
  // run of each index contour, collision-avoided, and never stamped on an
  // unsupported (gap) span. Values carry the vertical-origin add-back so a
  // recentred scan reads real heights (geometry stays local; only the VALUE
  // shifts) at the interval's own precision. Falls back to the pre-placed
  // `input.labels` only if the engine has no geometry to work from.
  const labelOz = input.worldOrigin?.z ?? 0;
  const labelDecimals = decimalsForInterval(input.provenance?.contourIntervalM ?? input.model.intervalM);
  const sz = 6.5;
  const extent = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY) || 1;
  const engineLabels = input.model.features.length
    ? placeContourLabels(input.model.features, {
        page: { minX: bbox.minX, minY: bbox.minY, maxX: bbox.maxX, maxY: bbox.maxY },
        minStraightLen: extent * 0.03,
        maxCurvature: 0.5,
        edgeMargin: extent * 0.015,
        labelHeight: (sz + 2) / t.scale,
        charWidth: 3.7 / t.scale,
        minFeatureLenForScale: extent * 0.04,
        indexOnly: true,
        maxLabels: 60,
        // Repeat labels along each index contour (~every 28% of the map extent)
        // so a long line reads its height wherever the eye lands — the printed
        // topo-sheet convention.
        repeatEveryLen: extent * 0.28,
        formatValue: (v) => (v + labelOz).toFixed(labelDecimals),
      }).labels
    : [];
  const drawn = engineLabels.length
    ? engineLabels.map((l) => ({ x: l.x, y: l.y, angle: l.angle, text: l.text }))
    : input.labels.map((l) => {
        let deg = (l.angleRad * 180) / Math.PI;
        if (deg > 90) deg -= 180;
        else if (deg < -90) deg += 180;
        return { x: l.x, y: l.y, angle: (deg * Math.PI) / 180, text: (l.value + labelOz).toFixed(labelDecimals) };
      });
  for (const lab of drawn) {
    const px = pageX(lab.x);
    const py = pageY(lab.y);
    if (px < inner.x || px > inner.x + inner.w || py < inner.y || py > inner.y + inner.h) continue;
    const s = lab.text;
    const w = bold.widthOfTextAtSize(s, sz);
    // Knock-out sized to the ROTATED text's footprint so a steep label is never
    // clipped by an axis-aligned box (a diagonal number needs both extents).
    const bw = Math.abs(w * Math.cos(lab.angle)) + Math.abs(sz * Math.sin(lab.angle)) + 3;
    const bh = Math.abs(w * Math.sin(lab.angle)) + Math.abs(sz * Math.cos(lab.angle)) + 2;
    page.drawRectangle({ x: px - bw / 2, y: py - bh / 2, width: bw, height: bh, color: WHITE, opacity: 0.82 });
    page.drawText(s, { x: px - w / 2, y: py - sz / 2 + 1, size: sz, font: bold, color: SEPIA_INDEX, rotate: degrees((lab.angle * 180) / Math.PI) });
  }

  // ── orientation (top-right inside frame) ─────────────────────────────────
  if (georef) {
    // True north — a georeferenced frame has a real bearing.
    const nx = frame.x + frame.w - 22;
    const ny = frame.y + frame.h - 30;
    page.drawRectangle({ x: nx - 12, y: ny - 22, width: 24, height: 40, color: WHITE, opacity: 0.82 });
    page.drawSvgPath(`M ${nx} ${PH - (ny + 14)} L ${nx - 5} ${PH - (ny - 6)} L ${nx} ${PH - (ny - 2)} L ${nx + 5} ${PH - (ny - 6)} Z`, {
      x: 0, y: PH, color: INK, borderColor: INK, borderWidth: 0.5,
    });
    page.drawText('N', { x: nx - bold.widthOfTextAtSize('N', 8) / 2, y: ny - 18, size: 8, font: bold, color: INK });
  } else {
    // Ungeoreferenced: the sheet's +Y IS up (pageY maps world +Y to page +Y),
    // but that is a LOCAL grid axis, not a compass bearing. State it explicitly
    // rather than leave the corner blank or imply north.
    const gx = frame.x + frame.w - 62;
    const gy = frame.y + frame.h - 12;
    page.drawRectangle({ x: gx - 6, y: gy - 24, width: 66, height: 30, color: WHITE, opacity: 0.82 });
    page.drawSvgPath(`M ${gx} ${PH - (gy + 3)} L ${gx - 3.5} ${PH - (gy - 8)} L ${gx + 3.5} ${PH - (gy - 8)} Z`, {
      x: 0, y: PH, color: DIM, borderColor: DIM, borderWidth: 0.4,
    });
    page.drawLine({ start: { x: gx, y: gy - 8 }, end: { x: gx, y: gy - 18 }, thickness: 0.5, color: DIM });
    page.drawText('local grid up', { x: gx + 8, y: gy - 8, size: 5.5, font: bold, color: DIM });
    page.drawText('true north unknown', { x: gx + 8, y: gy - 16, size: 5.5, font, color: DIM });
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

  // ── annotations (opt-in) ─────────────────────────────────────────────────
  // Drawn LAST so the markers and their table sit above the contours, and only
  // when the caller opted in AND there is something to draw — so a sheet built
  // without annotations emits exactly the operations it did before this feature.
  if (input.includeAnnotations && input.annotations && input.annotations.length > 0) {
    drawAnnotationLayer(page, frame, inner, bbox, t, input.annotations, input.sceneUpAxis ?? 'z', font, bold);
  }
}

/**
 * The annotation inspection layer: a numbered marker on the map for each
 * annotation that falls within the map extent, plus a description table in the
 * top-right collar. The marker index is the annotation's 1-based list position,
 * so a marker and its table row always carry the same number.
 *
 * Coordinate frame: `projectAnnotationToPage` converts each annotation's raw
 * scene position into the map (contour) frame before projecting — see
 * annotationMapProjection.ts. Off-map annotations are not drawn on the map but
 * are STILL listed in the table (with a footnote), so the table stays complete.
 */
function drawAnnotationLayer(
  page: PDFPage,
  frame: { x: number; y: number; w: number; h: number },
  inner: { x: number; y: number; w: number; h: number },
  bbox: Box,
  t: { ox: number; oy: number; scale: number },
  annotations: ReadonlyArray<Annotation>,
  sceneUpAxis: SceneUpAxis,
  font: PDFFont,
  bold: PDFFont,
): void {
  // One content model for the table (buildAnnotationReport) — complete by
  // construction (one row per annotation, note summarised + flagged, no
  // coordinate emitted). The markers reuse the SAME 1-based index.
  const report = buildAnnotationReport(annotations, {});
  let offMapCount = 0;
  annotations.forEach((a, i) => {
    const index = i + 1;
    const p = projectAnnotationToPage(a.localPosition, sceneUpAxis, bbox, t);
    if (!p.insideBbox || p.pageX < inner.x || p.pageX > inner.x + inner.w || p.pageY < inner.y || p.pageY > inner.y + inner.h) {
      offMapCount++;
      return;
    }
    drawMarker(page, p.pageX, p.pageY, index, ANNOTATION_COLORS[a.type], bold);
  });
  drawAnnotationTable(page, frame, report.header, report.rows, offMapCount, font, bold);
}

/**
 * One numbered marker: a white halo disc for legibility over the contour ink, a
 * filled type-coloured dot, and the index in a small knock-out box beside it so
 * the number reads whatever the dot sits on.
 */
function drawMarker(
  page: PDFPage,
  px: number,
  py: number,
  index: number,
  color: ReturnType<typeof rgb>,
  bold: PDFFont,
): void {
  // Halo + dot. drawEllipse's x/yScale are the radii; the centre is (px, py) in
  // the y-up page frame (same frame drawText uses), so no svg-y flip is needed.
  page.drawEllipse({ x: px, y: py, xScale: 5.2, yScale: 5.2, color: WHITE, opacity: 0.9 });
  page.drawEllipse({ x: px, y: py, xScale: 3.2, yScale: 3.2, color, borderColor: WHITE, borderWidth: 0.6 });
  const label = String(index);
  const sz = 6.5;
  const w = bold.widthOfTextAtSize(label, sz);
  // Index knock-out to the upper-right of the dot, so it never disappears into
  // the dot fill or a dark contour line.
  const lx = px + 5.5;
  const ly = py + 1.5;
  page.drawRectangle({ x: lx - 1, y: ly - 1.5, width: w + 2, height: sz + 1, color: WHITE, opacity: 0.85 });
  page.drawText(label, { x: lx, y: ly, size: sz, font: bold, color: INK });
}

/**
 * The description table in the top-right collar. Rows are SUMMARISED but never
 * silently dropped: the height is fitted by shrinking the row pitch within
 * reason, and if the list still overflows the sheet the overflow is called out
 * with a note recommending a larger sheet size — the surveyor-sheet rule that a
 * deliverable must recommend a better area rather than hide rows.
 */
function drawAnnotationTable(
  page: PDFPage,
  frame: { x: number; y: number; w: number; h: number },
  header: string,
  rows: ReadonlyArray<AnnotationReportRow>,
  offMapCount: number,
  font: PDFFont,
  bold: PDFFont,
): void {
  const pad = 8;
  const boxW = Math.min(190, frame.w * 0.42);
  const rightX = frame.x + frame.w - pad;
  const leftX = rightX - boxW;
  // The box TOP sits below both orientation indicators (the north-arrow box
  // bottoms out at frame top − 52; the ungeoreferenced "local grid up" note at
  // frame top − 36), so the table never collides with the corner. Everything
  // flows downward from here.
  const boxTop = frame.y + frame.h - 54;
  const headSz = 8;
  const rowSz = 6.5;
  const headerBaseline = boxTop - 12;
  // Available vertical run from the header down to a margin above the scale bar.
  const avail = headerBaseline - (frame.y + 28);
  const footNote =
    offMapCount > 0
      ? `${offMapCount} annotation${offMapCount === 1 ? '' : 's'} outside the map extent - listed, not plotted.`
      : '';
  const footLines = footNote ? 1 : 0;
  const noteRun = rowSz + 4;
  // Fit the row pitch: start roomy, shrink toward a floor so more rows fit before
  // we ever recommend a bigger sheet — a surveyor sheet must not silently drop a
  // row. Only when even the floor pitch overflows do we show a "+N more" note
  // and recommend a larger sheet size.
  const minPitch = 7.5;
  const maxPitch = 10;
  let pitch = maxPitch;
  const rowsRun = (): number => rows.length * pitch + footLines * noteRun;
  while (pitch > minPitch && rowsRun() > avail) pitch -= 0.5;
  const fitRows = Math.max(0, Math.floor((avail - footLines * noteRun) / pitch));
  const shown = Math.min(rows.length, Math.max(1, fitRows));
  const overflowed = shown < rows.length;
  const overflowRun = overflowed ? noteRun : 0;

  // Background box sized to exactly what is drawn (header + shown rows + notes).
  const bodyBottom = headerBaseline - 6 - shown * pitch - overflowRun - footLines * noteRun;
  const boxBottom = bodyBottom - 2;
  page.drawRectangle({
    x: leftX - 4, y: boxBottom, width: boxW + 8, height: boxTop - boxBottom,
    color: WHITE, opacity: 0.9, borderColor: FRAME, borderWidth: 0.5,
  });

  page.drawText(safe(header), { x: leftX, y: headerBaseline, size: headSz, font: bold, color: INK });
  page.drawLine({
    start: { x: leftX, y: headerBaseline - 3 }, end: { x: rightX, y: headerBaseline - 3 },
    thickness: 0.5, color: FRAME,
  });

  let y = headerBaseline - 12;
  const typeX = leftX + bold.widthOfTextAtSize('88', rowSz) + 4;
  const descX = typeX + font.widthOfTextAtSize('warning', rowSz) + 5;
  const descMax = rightX - descX;
  for (let i = 0; i < shown; i++) {
    const r = rows[i];
    // "12  warning  Title - note": the index (bold) + type prefix, then the
    // title and any note on the same line, clipped so nothing runs past the edge.
    page.drawText(safe(`${r.index}`), { x: leftX, y, size: rowSz, font: bold, color: INK });
    page.drawText(safe(r.type), { x: typeX, y, size: rowSz, font, color: DIM });
    const desc = r.note ? `${r.title} - ${r.note}` : r.title;
    const clipped = clipToWidth(desc, descMax, rowSz, (s, sc) => font.widthOfTextAtSize(safe(s), sc));
    page.drawText(safe(clipped), { x: descX, y, size: rowSz, font, color: INK });
    y -= pitch;
  }
  if (overflowed) {
    const more = rows.length - shown;
    page.drawText(
      safe(`+${more} more not shown - increase the sheet size to print the full list.`),
      { x: leftX, y: y - 2, size: rowSz, font: bold, color: rgb(0.6, 0.2, 0.1) },
    );
    y -= noteRun;
  }
  if (footNote) {
    page.drawText(safe(footNote), { x: leftX, y: y - 2, size: rowSz, font, color: DIM });
  }
}

/** Hard-clip a single line to a max width, appending "…" when it is cut. */
function clipToWidth(
  s: string,
  maxW: number,
  sz: number,
  measure: (s: string, sz: number) => number,
): string {
  if (maxW <= 0) return '';
  if (measure(s, sz) <= maxW) return s;
  let out = s;
  while (out.length > 0 && measure(`${out}…`, sz) > maxW) out = out.slice(0, -1);
  return out.length > 0 ? `${out}…` : '';
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

  // Three ruled columns: identity | legend | survey accuracy. The separators
  // fix the boundaries so no column's text can bleed into the next (the PREVIEW
  // verdict and the interpolated-% line used to overlap on a letter sheet).
  const mxx = M + (PW - 2 * M) * 0.46; // legend column start
  const rcx = M + (PW - 2 * M) * 0.72; // survey-accuracy column start
  page.drawLine({ start: { x: mxx - 10, y: topY - 6 }, end: { x: mxx - 10, y: M + 4 }, thickness: 0.4, color: FRAME, opacity: 0.55 });
  page.drawLine({ start: { x: rcx - 10, y: topY - 6 }, end: { x: rcx - 10, y: M + 4 }, thickness: 0.4, color: FRAME, opacity: 0.55 });

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
  // Rule under the title — the finished-sheet convention that anchors the block.
  page.drawLine({
    start: { x: lx, y: topY - 21 },
    end: { x: lx + Math.max(60, bold.widthOfTextAtSize(safe(titleDraw), titleSize)), y: topY - 21 },
    thickness: 0.8, color: FRAME,
  });
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

  // Middle column — legend (mxx defined with the column separators above).
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
  page.drawLine({ start: { x: mxx, y: topY - 21 }, end: { x: mxx + 26, y: topY - 21 }, thickness: 0.6, color: FRAME });
  const sample = (y: number, label: string, st: ContourDrawStyle): void => {
    const opts: Parameters<PDFPage['drawLine']>[0] = {
      start: { x: mxx, y: y + 2 }, end: { x: mxx + 26, y: y + 2 },
      thickness: st.width, color: st.color, opacity: st.opacity,
    };
    if (st.dash) opts.dashArray = st.dash;
    page.drawLine(opts);
    text(label, mxx + 32, y, 7, font, INK);
  };
  // Swatches drawn from the SAME contourDrawStyle the map plots, so the legend
  // can never describe a line weight/tint the sheet doesn't use.
  sample(topY - 32, 'Index contour (labelled)', contourDrawStyle(true, 'solid'));
  sample(topY - 45, 'Intermediate contour', contourDrawStyle(false, 'solid'));
  sample(topY - 58, 'Interpolated (uncertain)', contourDrawStyle(false, 'dashed'));
  sample(topY - 71, 'Low-confidence gap', contourDrawStyle(false, 'gap'));
  // Interpolated fraction is NaN when there is no contour length to measure
  // against (an empty contour set). Report that honestly rather than collapsing
  // it to a fabricated 0%.
  const interpFraction = input.model.interpolatedFraction;
  const interpLine = Number.isFinite(interpFraction)
    ? `${Math.round(interpFraction * 100)}% interpolated (by length)`
    : 'Interpolated fraction — not measured (no contours)';
  text(interpLine, mxx, topY - 88, 6.5, font, DIM);
  // Honest stamp of the shape style applied to the plotted contours (sourced
  // from the unified provenance when present, so it matches every other export).
  const styleLabel = prov ? prov.contourStyleLabel : contourShapeStyleLabel(input.model.contourStyle);
  text(`Contour style: ${styleLabel}`, mxx, topY - 99, 6.5, font, DIM);

  // Right column — accuracy + readiness + provenance.
  const rxr = PW - M - 4;
  rightText('Survey accuracy', rxr, topY - 16, 9, bold);
  page.drawLine({ start: { x: rxr - bold.widthOfTextAtSize('Survey accuracy', 9), y: topY - 21 }, end: { x: rxr, y: topY - 21 }, thickness: 0.6, color: FRAME });
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
  // Export-readiness + evidence verdict, wrapped WITHIN the accuracy column
  // (rcx..rxr) so the honest PREVIEW / exploratory banner can never bleed into
  // the legend column. Both stay the SAME central-gate strings every other
  // export stamps, so a printed sheet can never read as a validated deliverable.
  const warn = rgb(0.6, 0.2, 0.1);
  const rcw = rxr - rcx;
  const measure = (s: string, sz: number): number => font.widthOfTextAtSize(safe(s), sz);
  const boldMeasure = (s: string, sz: number): number => bold.widthOfTextAtSize(safe(s), sz);
  const note = readinessNote(readiness);
  const noteWrapped = wrapTextToWidth(note, rcw, 6.5, boldMeasure, 3);
  noteWrapped.forEach((ln, i) => rightText(ln, rxr, topY - 84 - i * 8, 6.5, bold, readiness === 'ready' ? INK : warn));
  const evLine = mapSheetEvidenceLine();
  const evColor = evidenceStatus(MAP_SHEET_CLAIM) === 'validated' ? DIM : warn;
  const evWrapped = wrapTextToWidth(evLine, rcw, 6, measure, 3);
  const evStartY = topY - 84 - noteWrapped.length * 8 - 5;
  evWrapped.forEach((ln, i) => rightText(ln, rxr, evStartY - i * 8, 6, font, evColor));
  rightText('OpenLiDARViewer - terrain analysis', rxr, M - 9, 6, font, DIM);
}
