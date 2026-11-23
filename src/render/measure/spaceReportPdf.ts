/**
 * spaceReportPdf.ts
 *
 * A one-page, dark-on-light Space / Object REPORT PDF for a NON-TERRAIN scan —
 * the export equivalent of the on-screen ObjectPanel. Interior scans get
 * dimensions / floor area / ceiling height / enclosed volume / storeys / planes;
 * objects get oriented + axis-aligned dimensions / envelope volume / surface
 * area / completeness. Both carry the capture-quality block, a provenance footer
 * (software + version, date, source, units), the standing not-survey-grade note,
 * and the panel's honesty caveats verbatim.
 *
 * For interiors, the density-derived FLOOR-PLAN sketch is embedded on the page
 * (outline + wall lines + scale + dimensions + the "approximate / not a survey"
 * caption), clearly labelled approximate.
 *
 * Pure: pdf-lib only (no DOM / canvas), so it produces bytes anywhere and rides
 * its own lazy chunk. The caller triggers the download. All TEXT content is
 * single-sourced from {@link buildSpaceReportContent} so the PDF can never drift
 * from the on-screen numbers.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
/** The session's sheet style, read by the caller that loads this chunk. */
export { sheetStyle } from './mapSheetExportOptions';
export { exportLocale } from '../../i18n/exportLocale';
import { openReport } from '../../export/sheetKit/reportStyle';
import type { SheetStyle } from '../../export/sheetKit/tokens';
import { metresToFeet, type SpaceMetrics } from '../../terrain/spaceMetrics';
import type { ObjectMetrics } from '../../terrain/objectMetrics';
import { buildSpaceReportContent, spaceReportWords, type ReportWords } from '../../terrain/space/spaceReportLayout';
import { languageInfo } from '../../i18n/languages';
import type { ExportLocale } from '../../i18n/exportLocale';
import type { FloorPlanModel } from '../../terrain/space/floorplan/extractFloorPlan';
import type { PlanUnitSystem } from '../../terrain/space/floorplan/floorPlanSvg';
import {
  clipWithSuffix,
  mayCapField,
  winAnsiSafe,
  wrapReportField,
  wrapStampLine,
} from '../../winAnsiText';

export interface SpaceReportPdfInput {
  readonly space: SpaceMetrics | null;
  readonly object?: ObjectMetrics | null;
  readonly name?: string | null;
  readonly softwareVersion?: string | null;
  readonly metricVersion?: string | null;
  readonly generatedAt?: Date | string | null;
  readonly unitToMetres?: number;
  /** Interior-only: the extracted wall-plan model to embed on the page. */
  readonly floorPlan?: FloorPlanModel | null;
  /**
   * Display unit system for the embedded plan's dimensions (mirrors the
   * measurement panel / the SVG sheet): metric prints metres first, imperial
   * feet first. Default 'metric'.
   */
  readonly unitSystem?: PlanUnitSystem;
  /** Truncation note for a truncated source file; printed as a Coverage row. */
  readonly coverageNote?: string | null;
  /** The language and number style to write the report in; English when absent. */
  readonly locale?: ExportLocale;
}

let INK = rgb(0.12, 0.14, 0.18);
let DIM = rgb(0.42, 0.46, 0.52);
let FRAME = rgb(0.2, 0.22, 0.26);
let FILL = rgb(0.93, 0.945, 0.96);
let CONTENTS = rgb(0.87, 0.885, 0.91);
let WARN = rgb(0.54, 0.18, 0.11);
let WHITE = rgb(1, 1, 1);

/** The report's colours, swapped for a Light or Dark build and restored after it. */
interface ReportInk { readonly INK: RGB; readonly DIM: RGB; readonly FRAME: RGB; readonly FILL: RGB; readonly CONTENTS: RGB; readonly WARN: RGB; readonly WHITE: RGB; }
const CLASSIC_INK: ReportInk = { INK, DIM, FRAME, FILL, CONTENTS, WARN, WHITE };
function useInk(c: ReportInk): void {
  ({ INK, DIM, FRAME, FILL, CONTENTS, WARN, WHITE } = c);
}

/** Keep every drawn string WinAnsi-encodable (StandardFonts throw otherwise). */
const safe = winAnsiSafe;

/** Build the Space / Object report PDF and return its bytes. */
/**
 * The report in a sheet style (`render.style`): Light and Dark set it in the
 * sheet kit's type, colours and paper with the same content; Classic, or no
 * style, is the report as before, byte for byte.
 */
export async function buildSpaceReportPdf(
  input: SpaceReportPdfInput,
  render: { readonly style?: SheetStyle | null; readonly loadFont?: (name: string) => Promise<Uint8Array> } = {},
): Promise<Uint8Array> {
  try {
    return await buildSpaceReportPdfStyled(input, render);
  } finally {
    useInk(CLASSIC_INK);
  }
}

async function buildSpaceReportPdfStyled(
  input: SpaceReportPdfInput,
  render: { readonly style?: SheetStyle | null; readonly loadFont?: (name: string) => Promise<Uint8Array> },
): Promise<Uint8Array> {
  const content = buildSpaceReportContent(input);
  const words = spaceReportWords(input.locale);
  const doc = await PDFDocument.create();
  // Info dictionary, accessibility hooks and faces. Light and Dark: the sheet
  // kit's fonts and colours. No await follows until the save, so the swapped
  // colours are this build's alone.
  const { kit, font, bold } = await openReport(doc, content.title, input.generatedAt, render, languageInfo(input.locale?.lang).tag);
  if (kit) {
    const k = kit, t = kit.tokens;
    useInk({ INK: k.color(t.ink), DIM: k.color(t.dim), FRAME: k.color(t.outline), FILL: k.mix(t.panel, t.rule, 0.35), CONTENTS: k.mix(t.panel, t.rule, 0.7), WARN: k.color(t.warn), WHITE: k.color(t.panel) });
  }

  const [PW, PH] = [612, 792]; // US Letter portrait
  let page = doc.addPage([PW, PH]);
  const M = 48;

  const text = (s: string, x: number, y: number, sz: number, f: PDFFont = font, c = INK): void => {
    page.drawText(safe(s), { x, y, size: sz, font: f, color: c });
  };

  // The footer is bottom-anchored, so the body needs a floor or it draws over
  // it. A room scan with a floor plan and four notes did exactly that: the last
  // two notes landed on the provenance stamp. The footer's height depends only
  // on the content, so it is measured before anything is drawn, and the body
  // breaks to a new page rather than crossing it.
  const footerW = PW - 2 * M;
  const stampIndent = 24;
  const stamp = content.provenanceLines.flatMap((line) =>
    wrapStampLine(font, line, footerW, 7.5, stampIndent).map((seg, i) => ({
      seg,
      x: i === 0 ? M : M + stampIndent,
    })),
  );
  const note = wrapStampLine(bold, content.provenance.notSurveyGrade, footerW, 8, 0);
  const noteTop = M - 4 + (note.length - 1) * 11;
  const fy0 = noteTop + 16 + (stamp.length - 1) * 10;
  /** Lowest baseline the body may use: clear of the footer rule above the stamp. */
  const BODY_FLOOR = fy0 + 24;

  let y = PH - M;

  /** Break to a fresh page when `need` points of body would cross the footer; true when it broke. */
  const room = (need: number): boolean => {
    if (y - need >= BODY_FLOOR) return false;
    page = doc.addPage([PW, PH]);
    y = PH - M;
    return true;
  };

  /**
   * Draw `s` wrapped to `maxW` from `x`, each line checking its own room, so
   * a long note continues on the next page instead of running into the
   * footer. Used for app-written hints and caveats, which are never capped.
   */
  const flow = (s: string, x: number, maxW: number, sz: number, f: PDFFont, c: Color): void => {
    for (const line of wrapReportField(s, f, sz, maxW, false)) {
      room(sz + 3);
      page.drawText(line, { x, y, size: sz, font: f, color: c });
      y -= sz + 3;
    }
  };

  // ── Title + subtitle ──
  text(content.title, M, y - 16, 18, bold);
  y -= 22;
  text(content.subtitle, M, y - 12, 11, font, DIM);
  y -= 24;
  page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: FRAME });
  y -= 18;

  // ── Sections (label / value rows) ──
  const labelX = M;
  const valueX = M + 168;
  for (const section of content.sections) {
    room(30);
    text(section.title, M, y, 11, bold, INK);
    y -= 16;
    for (const row of section.rows) {
      room(14);
      // Label and value wrap in their own columns and advance together; a
      // row that breaks across pages repeats its label as "(continued)".
      const labelW = valueX - labelX - 8;
      const valueW = PW - M - valueX;
      // A row value may copy file-derived text (the scan name) and is capped,
      // unless its label marks a CRS, datum, digest or unit.
      const cap = mayCapField(row.label);
      const labelLines = wrapReportField(row.label, bold, 9.5, labelW, cap);
      const valueLines = wrapReportField(row.value, font, 9.5, valueW, cap);
      const rows = Math.max(labelLines.length, valueLines.length);
      for (let i = 0; i < rows; i++) {
        if (i > 0) y -= 12.5;
        if (room(9.5) && i >= labelLines.length) {
          const cont = clipWithSuffix(labelLines.join(' '), words.t('continued'), (t) => bold.widthOfTextAtSize(t, 9.5), labelW);
          page.drawText(cont, { x: labelX, y, size: 9.5, font: bold, color: DIM });
        }
        if (i < labelLines.length) page.drawText(labelLines[i], { x: labelX, y, size: 9.5, font: bold, color: DIM });
        if (i < valueLines.length) page.drawText(valueLines[i], { x: valueX, y, size: 9.5, font, color: INK });
      }
      y -= 14;
      // The per-row qualifier the panel shows as a tooltip. Without it the
      // sheet printed a bare envelope volume and a bare bounding surface area,
      // so a reader had no way to tell either one from a solid measurement.
      if (row.hint) {
        flow(row.hint, valueX, PW - M - valueX, 7, font, DIM);
        y -= 1;
      }
    }
    y -= 8;
  }

  // ── Interior floor plan (embedded, clearly approximate) ──
  if (input.floorPlan && input.floorPlan.wallRings.length > 0) {
    y -= 4;
    room(200);
    text(words.t('planTitle'), M, y, 11, bold, INK);
    y -= 8;
    const planTop = y;
    const planBox = { x: M, y: planTop - 180, w: PW - 2 * M, h: 176 };
    drawFloorPlan(page, planBox, input.floorPlan, font, bold, input.unitSystem ?? 'metric', words);
    y = planBox.y - 12;
  }

  // ── Caveats ──
  if (content.caveats.length > 0) {
    room(30);
    text(words.t('notesTitle'), M, y, 10, bold, INK);
    y -= 14;
    for (const c of content.caveats) {
      // Two lines of headroom, so a note that wraps starts on the page it ends on.
      room(24);
      flow(`- ${c}`, M, PW - 2 * M, 8.5, font, DIM);
      y -= 3;
    }
  }

  // ── Provenance footer ──
  // Bottom-anchored from the block's MEASURED height (the old fixed start at
  // M + 74 ran the stamp's tail into the bold note once the Evidence line
  // joined it), and long lines wrap with a hanging indent instead of leaving
  // the sheet. The bold note keeps its bottom-margin slot (last line at
  // M - 4), wrapping upward from there.
  page.drawLine({ start: { x: M, y: fy0 + 12 }, end: { x: PW - M, y: fy0 + 12 }, thickness: 0.75, color: FRAME });
  let fy = fy0;
  for (const s of stamp) {
    text(s.seg, s.x, fy, 7.5, font, DIM);
    fy -= 10;
  }
  // The standing honesty note in bold so a preview can never read as certified.
  let ny = noteTop;
  for (const seg of note) {
    text(seg, M, ny, 8, bold, WARN);
    ny -= 11;
  }

  if (kit) {
    useInk(CLASSIC_INK);
    kit.done();
  }
  return doc.save();
}

type Color = ReturnType<typeof rgb>;

/** Draw the extracted wall plan (floor fill + wall poché + dims) in a box. */
function drawFloorPlan(
  page: PDFPage,
  box: { x: number; y: number; w: number; h: number },
  plan: FloorPlanModel,
  font: PDFFont,
  bold: PDFFont,
  unitSystem: PlanUnitSystem,
  words: ReportWords,
): void {
  const PH = 792;
  const pad = 28;
  const inner = { x: box.x + pad, y: box.y + pad, w: box.w - 2 * pad, h: box.h - 2 * pad };
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: FRAME, borderWidth: 0.75, color: WHITE });

  const [minX, minY, maxX, maxY] = plan.bbox;
  const planW = Math.max(1e-6, maxX - minX);
  const planD = Math.max(1e-6, maxY - minY);
  const scale = Math.min(inner.w / planW, inner.h / planD);
  const usedW = planW * scale;
  const usedH = planD * scale;
  const offX = inner.x + (inner.w - usedW) / 2;
  const offY = inner.y + (inner.h - usedH) / 2;
  // plan-metre (x east, y north) → y-up page point.
  const pageX = (x: number): number => offX + (x - minX) * scale;
  const pageY = (yy: number): number => offY + (yy - minY) * scale;
  const svgY = (py: number): number => PH - py;

  /** All rings of one layer as a single nonzero-winding SVG path: the trace
   * emits outer rings CCW and holes CW, so one fill keeps holes (and door
   * gaps) open in the PDF exactly as in the standalone SVG. */
  const ringsPath = (rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): string => {
    let d = '';
    for (const ring of rings) {
      ring.forEach((p, i) => {
        d += `${i === 0 ? 'M' : 'L'}${pageX(p[0]).toFixed(2)} ${svgY(pageY(p[1])).toFixed(2)} `;
      });
      d += 'Z ';
    }
    return d.trim();
  };

  // Scanned-floor interior (light), contents hints (grey), wall poché on top.
  if (plan.floorRings.length > 0) {
    page.drawSvgPath(ringsPath(plan.floorRings), { x: 0, y: PH, color: FILL, borderColor: FRAME, borderWidth: 0.4 });
  }
  if (plan.contentRings.length > 0) {
    page.drawSvgPath(ringsPath(plan.contentRings), { x: 0, y: PH, color: CONTENTS, borderColor: FRAME, borderWidth: 0.3 });
  }
  if (plan.wallRings.length > 0) {
    page.drawSvgPath(ringsPath(plan.wallRings), { x: 0, y: PH, color: INK, borderColor: INK, borderWidth: 0.4 });
  }
  // Unknown wall gaps (no square jamb evidence — unscanned or unclassifiable)
  // as light dashed lines, matching the standalone SVG sheet; classified
  // doorways stay genuine openings.
  for (const g of plan.unknownGaps) {
    page.drawLine({
      start: { x: pageX(g.a[0]), y: pageY(g.a[1]) },
      end: { x: pageX(g.b[0]), y: pageY(g.b[1]) },
      thickness: 0.8,
      color: DIM,
      dashArray: [3, 2.5],
    });
  }

  // Room labels: "Room N 12.3 m2" at each segmented room's label anchor
  // (roomDetect.ts pole of inaccessibility — inside the room by
  // construction). Centred by the Helvetica width metric pdf-lib exposes.
  if (plan.rooms.length > 0) {
    plan.rooms.forEach((room, i) => {
      const txt = safe(
        unitSystem === 'imperial'
          ? words.t('roomImperial', { i: i + 1, area: Math.round(room.areaM2 / 0.09290304) })
          : words.t('roomMetric', { i: i + 1, area: words.fx(room.areaM2, 1) }),
      );
      const sz = 6.5;
      const w = bold.widthOfTextAtSize(txt, sz);
      // Only label rooms the text actually fits inside (mirrors the SVG).
      let rMinX = Infinity, rMaxX = -Infinity, rMinY = Infinity, rMaxY = -Infinity;
      for (const [x, yy] of room.ring) {
        if (x < rMinX) rMinX = x;
        if (x > rMaxX) rMaxX = x;
        if (yy < rMinY) rMinY = yy;
        if (yy > rMaxY) rMaxY = yy;
      }
      if ((rMaxX - rMinX) * scale < w + 4 || (rMaxY - rMinY) * scale < 10) return;
      page.drawText(txt, {
        x: pageX(room.label[0]) - w / 2,
        y: pageY(room.label[1]) - sz / 2,
        size: sz,
        font: bold,
        color: INK,
      });
    });
  }

  // Dimensions + caption — units follow the caller's unit system, mirroring
  // the SVG sheet and the measurement panel (metric: metres first; imperial:
  // feet first), so the report never argues with the on-screen numbers.
  const wFt = metresToFeet(plan.widthM);
  const dFt = metresToFeet(plan.depthM);
  const f1 = (v: number): string => words.fx(v, 1);
  const dimsTxt =
    unitSystem === 'imperial'
      ? words.t('planDimsImperial', { w: f1(wFt), wAlt: f1(plan.widthM), d: f1(dFt), dAlt: f1(plan.depthM) })
      : words.t('planDimsMetric', { w: f1(plan.widthM), wAlt: f1(wFt), d: f1(plan.depthM), dAlt: f1(dFt) });
  page.drawText(safe(dimsTxt), { x: box.x + 6, y: box.y + 6, size: 7.5, font, color: INK });
  // Claim-accurate caption: "wall-graph reconstruction" only when the model
  // really came from the graph pass; either way still an experimental preview.
  const caption = plan.fromWallGraph ? words.t('planCaptionGraph') : words.t('planCaptionTrace');
  // A caption longer than the box (German runs close) steps down in size
  // rather than leave the plan's frame; English fits at 7 pt as before.
  const captionText = safe(caption);
  const captionRoom = box.w - 12;
  const captionWidth = bold.widthOfTextAtSize(captionText, 7);
  const captionSize = captionWidth > captionRoom ? Math.max(5, 7 * captionRoom / captionWidth) : 7;
  page.drawText(captionText, {
    x: box.x + 6,
    y: box.y + box.h - 11,
    size: captionSize,
    font: bold,
    color: WARN,
  });
}

export type { SpaceReportContent } from '../../terrain/space/spaceReportLayout';
