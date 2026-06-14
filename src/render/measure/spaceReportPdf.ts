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

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { SpaceMetrics } from '../../terrain/spaceMetrics';
import type { ObjectMetrics } from '../../terrain/objectMetrics';
import {
  buildSpaceReportContent,
  type SpaceReportContent,
} from '../../terrain/space/spaceReportLayout';
import type { FloorPlanModel } from '../../terrain/space/floorplan/extractFloorPlan';
import type { PlanUnitSystem } from '../../terrain/space/floorplan/floorPlanSvg';

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
}

const INK = rgb(0.12, 0.14, 0.18);
const DIM = rgb(0.42, 0.46, 0.52);
const FRAME = rgb(0.2, 0.22, 0.26);
const FILL = rgb(0.93, 0.945, 0.96);
const CONTENTS = rgb(0.87, 0.885, 0.91);
const WARN = rgb(0.54, 0.18, 0.11);
const WHITE = rgb(1, 1, 1);

/** Keep every drawn string WinAnsi-encodable (StandardFonts throw otherwise). */
function safe(s: string): string {
  const map: Record<string, string> = {
    '×': 'x', '—': '-', '–': '-', '•': '-', '’': "'", '“': '"', '”': '"', '…': '...',
    '²': '2', '³': '3', '°': ' deg', '→': '->',
  };
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => map[ch] ?? '?');
}

/** Build the Space / Object report PDF and return its bytes. */
export async function buildSpaceReportPdf(input: SpaceReportPdfInput): Promise<Uint8Array> {
  const content = buildSpaceReportContent(input);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const [PW, PH] = [612, 792]; // US Letter portrait
  const page = doc.addPage([PW, PH]);
  const M = 48;

  const text = (s: string, x: number, y: number, sz: number, f: PDFFont = font, c = INK): void => {
    page.drawText(safe(s), { x, y, size: sz, font: f, color: c });
  };

  let y = PH - M;

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
    text(section.title, M, y, 11, bold, INK);
    y -= 16;
    for (const row of section.rows) {
      text(row.label, labelX, y, 9.5, bold, DIM);
      text(row.value, valueX, y, 9.5, font, INK);
      y -= 14;
    }
    y -= 8;
  }

  // ── Interior floor plan (embedded, clearly approximate) ──
  if (input.floorPlan && input.floorPlan.wallRings.length > 0) {
    y -= 4;
    text('Floor plan preview (walls traced from the scan)', M, y, 11, bold, INK);
    y -= 8;
    const planTop = y;
    const planBox = { x: M, y: planTop - 180, w: PW - 2 * M, h: 176 };
    drawFloorPlan(page, planBox, input.floorPlan, font, bold, input.unitSystem ?? 'metric');
    y = planBox.y - 12;
  }

  // ── Caveats ──
  if (content.caveats.length > 0) {
    text('Notes', M, y, 10, bold, INK);
    y -= 14;
    for (const c of content.caveats) {
      y = drawWrapped(page, font, `- ${c}`, M, y, PW - 2 * M, 8.5, DIM);
      y -= 3;
    }
    y -= 8;
  }

  // ── Provenance footer ──
  page.drawLine({ start: { x: M, y: M + 86 }, end: { x: PW - M, y: M + 86 }, thickness: 0.75, color: FRAME });
  let fy = M + 74;
  for (const line of content.provenanceLines) {
    text(line, M, fy, 7.5, font, DIM);
    fy -= 10;
  }
  // The standing honesty note in bold so a preview can never read as certified.
  text(content.provenance.notSurveyGrade, M, M - 4, 8, bold, WARN);

  return doc.save();
}

/** Word-wrap text into the page width, advancing y; returns the new y. */
function drawWrapped(
  page: PDFPage,
  font: PDFFont,
  s: string,
  x: number,
  y: number,
  maxW: number,
  sz: number,
  color: ReturnType<typeof rgb>,
): number {
  const words = safe(s).split(/\s+/);
  let line = '';
  let cy = y;
  for (const w of words) {
    const cand = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(cand, sz) > maxW && line) {
      page.drawText(line, { x, y: cy, size: sz, font, color });
      cy -= sz + 3;
      line = w;
    } else {
      line = cand;
    }
  }
  if (line) {
    page.drawText(line, { x, y: cy, size: sz, font, color });
    cy -= sz + 3;
  }
  return cy;
}

/** Draw the extracted wall plan (floor fill + wall poché + dims) in a box. */
function drawFloorPlan(
  page: PDFPage,
  box: { x: number; y: number; w: number; h: number },
  plan: FloorPlanModel,
  font: PDFFont,
  bold: PDFFont,
  unitSystem: PlanUnitSystem,
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
          ? `Room ${i + 1} ${Math.round(room.areaM2 / 0.09290304)} sq ft`
          : `Room ${i + 1} ${room.areaM2.toFixed(1)} m2`,
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
  const wFt = plan.widthM / 0.3048;
  const dFt = plan.depthM / 0.3048;
  const dimsTxt =
    unitSystem === 'imperial'
      ? `W ${wFt.toFixed(1)} ft (${plan.widthM.toFixed(1)} m) x D ${dFt.toFixed(1)} ft (${plan.depthM.toFixed(1)} m)`
      : `W ${plan.widthM.toFixed(1)} m (${wFt.toFixed(1)} ft) x D ${plan.depthM.toFixed(1)} m (${dFt.toFixed(1)} ft)`;
  page.drawText(safe(dimsTxt), { x: box.x + 6, y: box.y + 6, size: 7.5, font, color: INK });
  // Claim-accurate caption: "wall-graph reconstruction" only when the model
  // really came from the graph pass; either way still an experimental preview.
  const caption = plan.fromWallGraph
    ? 'Experimental preview - wall-graph reconstruction from the scan, not a measured floor plan; requires visual validation.'
    : 'Experimental preview - walls traced from the scan, not a measured floor plan; requires visual validation.';
  page.drawText(safe(caption), {
    x: box.x + 6,
    y: box.y + box.h - 11,
    size: 7,
    font: bold,
    color: WARN,
  });
}

export type { SpaceReportContent };
