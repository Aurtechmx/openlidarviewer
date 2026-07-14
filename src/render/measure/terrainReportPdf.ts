/**
 * terrainReportPdf.ts
 *
 * The one-click "Terrain Intelligence Report" PDF — the client-facing deliverable
 * that assembles everything the Analyse panel already computed into one clean,
 * sectioned report. It is an ASSEMBLY + LAYOUT job: every string is single-
 * sourced from {@link buildTerrainReportContent}, so the PDF can never drift from
 * the on-screen panel and never re-runs any analysis.
 *
 * A dark-on-light A4 report, sectioned with headers, that can span 1–3 pages:
 * Executive Summary, Dataset Statistics, Terrain Assessment, Coverage Analysis,
 * Quality Metrics, Warnings, Recommended Workflows (✓ / ⚠ / ✕), Terrain
 * Products Available (Available / Preview / Blocked), How to improve, and a
 * provenance footer that always carries the standing not-survey-grade note in
 * bold. The footer block is measured and bottom-anchored on the last page —
 * taking a fresh page when the body sits too low — because the stamp long ago
 * outgrew any fixed strip (~27 lines once Methods / Record / Manifest joined
 * it). The section list itself lives in the content builder — this renderer
 * lays out whatever `content.sections` carries, in order.
 *
 * Honesty contract: never an affirmative survey-grade claim; null / unknown
 * values render as an em-dash / "unknown" (the content builder guarantees this).
 *
 * Pure: pdf-lib only (no DOM / canvas), so it produces bytes anywhere and rides
 * its OWN lazy chunk (pdf-lib must never enter the initial app payload). The
 * caller triggers the download.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { AnalyseContoursResult } from '../../terrain/contour/analyseContours';
import {
  buildTerrainReportContent,
  type TerrainReportContent,
  type TerrainReportContentOptions,
} from '../../terrain/export/terrainReportContent';

const INK = rgb(0.12, 0.14, 0.18);
const DIM = rgb(0.42, 0.46, 0.52);
const FRAME = rgb(0.2, 0.22, 0.26);
const WARN = rgb(0.54, 0.18, 0.11);
const GOOD = rgb(0.13, 0.43, 0.2);
const CAUTION = rgb(0.55, 0.4, 0.05);

/** A4 portrait, in points. */
const PW = 595.28;
const PH = 841.89;
const M = 48;
/**
 * Bottom strip the flowing BODY never enters — breathing room only. The
 * provenance block no longer lives inside it: that block measures itself and
 * takes a fresh page when the body cursor sits below its anchored top.
 */
const FOOTER_RESERVE = 96;
/** Provenance-stamp typography: size, leading, and the hanging indent a
 * wrapped line's continuation renders at. */
const STAMP_SIZE = 7.5;
const STAMP_LEAD = 10;
const STAMP_INDENT = 24;
/** Bold note typography (bottom-margin slot, last line anchored at M - 4). */
const NOTE_SIZE = 8.5;
const NOTE_LEAD = 11;

/** Keep every drawn string WinAnsi-encodable (StandardFonts throw otherwise). */
function safe(s: string): string {
  const map: Record<string, string> = {
    '×': 'x', '—': '-', '–': '-', '•': '-', '’': "'", '“': '"', '”': '"', '…': '...',
    '²': '2', '³': '3', '°': ' deg', '≈': '~', '→': '->', '✓': '[OK]', '⚠': '[!]', '✕': '[X]',
  };
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => map[ch] ?? '?');
}

/** True when the argument is a pre-built content object (vs. a raw result). */
function isContent(x: unknown): x is TerrainReportContent {
  return (
    typeof x === 'object' &&
    x !== null &&
    Array.isArray((x as TerrainReportContent).sections) &&
    Array.isArray((x as TerrainReportContent).products)
  );
}

/**
 * Build the Terrain Intelligence Report PDF and return its bytes. Accepts either
 * a pre-built {@link TerrainReportContent} (preferred when the caller already
 * assembled it) or a raw {@link AnalyseContoursResult} + provenance options
 * (assembled here). Pure given a fixed `generatedAt`.
 */
export async function buildTerrainReportPdf(
  input: TerrainReportContent | AnalyseContoursResult,
  opts: TerrainReportContentOptions = {},
): Promise<Uint8Array> {
  const content = isContent(input) ? input : buildTerrainReportContent(input, opts);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // ── paging state (the report can flow onto a second page) ────────────────
  let page = doc.addPage([PW, PH]);
  let y = PH - M;

  const text = (s: string, x: number, yy: number, sz: number, f: PDFFont = font, c = INK): void => {
    page.drawText(safe(s), { x, y: yy, size: sz, font: f, color: c });
  };

  /** Start a fresh page and reset the cursor to the top margin. */
  const newPage = (): void => {
    page = doc.addPage([PW, PH]);
    y = PH - M;
  };

  /** Ensure `need` points of vertical space remain above the footer; page-break otherwise. */
  const ensure = (need: number): void => {
    if (y - need < M + FOOTER_RESERVE) newPage();
  };

  // ── Title + subtitle ─────────────────────────────────────────────────────
  text(content.subtitle, M, y - 12, 11, bold, DIM);
  y -= 18;
  text(content.title, M, y - 18, 20, bold, INK);
  y -= 26;
  page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 1, color: FRAME });
  y -= 20;

  // ── Label/value sections ─────────────────────────────────────────────────
  const labelX = M;
  const valueX = M + 170;
  const valueW = PW - M - valueX;
  for (const sec of content.sections) {
    // Keep a section header with at least its first row on the same page.
    ensure(34);
    text(sec.title, M, y, 12, bold, INK);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.5, color: FRAME });
    y -= 14;
    for (const row of sec.rows) {
      ensure(16);
      text(row.label, labelX, y, 9.5, bold, DIM);
      // Value may wrap (long reasons / notes) — keep label fixed, wrap the value.
      const endY = drawWrapped(page, font, row.value, valueX, y, valueW, 9.5, INK);
      y = Math.min(y - 14, endY - 2);
    }
    y -= 10;
  }

  // ── Warnings ─────────────────────────────────────────────────────────────
  ensure(34);
  text('Warnings', M, y, 12, bold, INK);
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.5, color: FRAME });
  y -= 14;
  if (content.warnings.length === 0) {
    ensure(14);
    text('None.', M, y, 9.5, font, DIM);
    y -= 14;
  } else {
    for (const w of content.warnings) {
      ensure(16);
      y = drawWrapped(page, font, `- ${w}`, M, y, PW - 2 * M, 9, WARN);
      y -= 3;
    }
  }
  y -= 10;

  // ── How to improve (only present when the surface is not fully-good) ──────
  if (content.howToImprove.length > 0) {
    ensure(34);
    text('How to improve', M, y, 12, bold, INK);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: PW - M, y }, thickness: 0.5, color: FRAME });
    y -= 14;
    for (const f of content.howToImprove) {
      ensure(16);
      y = drawWrapped(page, font, `- ${f}`, M, y, PW - 2 * M, 9, INK);
      y -= 3;
    }
    y -= 10;
  }

  // ── Provenance footer + the standing not-survey-grade note ───────────────
  // Bottom-anchored on the LAST page from the block's MEASURED height (the old
  // fixed start at M + 78 fit ~12 lines; Methods / Record / Manifest grew the
  // stamp to ~27, pushing the tail below y = 0 and through the bold note).
  // Long lines wrap with a hanging indent instead of leaving the sheet, and
  // the whole block moves to a fresh page when the body cursor sits inside it.
  const footerW = PW - 2 * M;
  const stamp = content.provenanceLines.flatMap((line) =>
    wrapStampLine(font, line, footerW, STAMP_SIZE, STAMP_INDENT).map((seg, i) => ({
      seg,
      x: i === 0 ? M : M + STAMP_INDENT,
    })),
  );
  // The bold note keeps its bottom-margin slot (last line at M - 4), wrapping
  // UPWARD from there so a longer wording can never fall off the page.
  const note = wrapStampLine(bold, content.notSurveyGrade, footerW, NOTE_SIZE, 0);
  const noteTop = M - 4 + (note.length - 1) * NOTE_LEAD;
  // First stamp baseline: as low as possible while every line clears the note.
  const fy0 = noteTop + 16 + (stamp.length - 1) * STAMP_LEAD;
  if (y - 16 < fy0 + 12) newPage();
  page.drawLine({ start: { x: M, y: fy0 + 12 }, end: { x: PW - M, y: fy0 + 12 }, thickness: 0.75, color: FRAME });
  let fy = fy0;
  for (const s of stamp) {
    text(s.seg, s.x, fy, STAMP_SIZE, font, DIM);
    fy -= STAMP_LEAD;
  }
  // The honesty note in bold so a preview can never read as a certified deliverable.
  let ny = noteTop;
  for (const seg of note) {
    text(seg, M, ny, NOTE_SIZE, bold, WARN);
    ny -= NOTE_LEAD;
  }

  return doc.save();
}

/**
 * Split one `Key  Value` provenance line into segments that fit the footer
 * width, breaking ONLY at spaces and keeping each segment's internal spacing
 * (a plain word-split would collapse the padded key column). Continuation
 * segments render with a hanging indent, so they measure against `maxW -
 * indent`. A single unbreakable run longer than the width draws whole rather
 * than truncating — provenance never silently loses characters. Mirrors the
 * helper in spaceReportPdf.ts (pure, injected font measurer).
 */
function wrapStampLine(
  font: PDFFont,
  s: string,
  maxW: number,
  sz: number,
  indent: number,
): string[] {
  const out: string[] = [];
  let rest = safe(s);
  let w = maxW;
  while (font.widthOfTextAtSize(rest, sz) > w) {
    // The longest space-boundary prefix that fits.
    let cut = -1;
    for (let i = rest.indexOf(' '); i !== -1; i = rest.indexOf(' ', i + 1)) {
      if (font.widthOfTextAtSize(rest.slice(0, i), sz) <= w) cut = i;
      else break;
    }
    if (cut <= 0) break;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut + 1).trimStart();
    w = maxW - indent;
  }
  out.push(rest);
  return out;
}

/**
 * Word-wrap text into the given width, advancing y; returns the new y. Mirrors
 * the wrapper in spaceReportPdf.ts (pure, injected font measurer).
 */
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

// Re-exported for callers that want to colour-key the marks / availability
// outside the PDF (the colours are documented here as the report's palette).
export const REPORT_COLORS = { INK, DIM, GOOD, CAUTION, WARN } as const;

export type { TerrainReportContent };
