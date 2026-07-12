/**
 * contourStudioPdf.ts
 *
 * The BYTE EMITTER for the premium multipage Contour Studio deliverable PDF.
 * It consumes the PURE content model built by `buildContourPdfModel`
 * (contourStudio/contourDeliverablePdfModel.ts) and turns it into real PDF
 * bytes with pdf-lib — one PDF page per model page/section, rendering ONLY the
 * text the model provides. It fabricates no numbers, headings or claims: every
 * string drawn comes verbatim from the model, so the honesty rules the model
 * enforces (§20.6/§20.7) carry through untouched to the printed page.
 *
 * When the model represents an exploratory/blocked state and carries a
 * watermark, that watermark is drawn diagonally on every page.
 *
 * Pure: pdf-lib only (no DOM / canvas), so it produces bytes anywhere and is
 * unit-testable. pdf-lib is imported here so the whole module lands in its own
 * lazy chunk. Deterministic given a fixed model. Matches the async
 * `buildXxx(...): Promise<Uint8Array>` convention of {@link buildMapSheetPdf}.
 */

import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import type { ContourPdfModel } from '../contourStudio/contourDeliverablePdfModel';

const INK = rgb(0.12, 0.14, 0.18);
const DIM = rgb(0.42, 0.46, 0.52);
const RULE = rgb(0.2, 0.22, 0.26);
const WATERMARK = rgb(0.85, 0.4, 0.36);

// US Letter, portrait.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;

/** Keep every drawn string WinAnsi-encodable (StandardFonts throw otherwise). */
function safe(s: string): string {
  const map: Record<string, string> = {
    '×': 'x', '—': '-', '–': '-', '•': '-', '’': "'", '“': '"', '”': '"',
    '…': '...', '°': ' deg', '≈': '~', '±': '+/-', '²': '2',
  };
  return s.replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => map[ch] ?? '?');
}

/**
 * Greedy word-wrap a string to a maximum width using the embedded font's
 * measurer. A single word wider than the line is hard-cut so nothing overflows.
 */
function wrap(textStr: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = safe(textStr).split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const fits = (s: string): boolean => font.widthOfTextAtSize(s, size) <= maxWidth;
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) { line = candidate; continue; }
    if (line) { lines.push(line); line = ''; }
    if (fits(word)) { line = word; continue; }
    // A single word wider than the line: hard-cut it to what fits.
    let chunk = '';
    for (const ch of word) {
      if (fits(chunk + ch)) chunk += ch;
      else { if (chunk) { lines.push(chunk); } chunk = ch; }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines.length > 0 ? lines : [''];
}

/** Draw the diagonal watermark across the whole page (drawn first, behind text). */
function drawWatermark(page: PDFPage, font: PDFFont, mark: string): void {
  const label = safe(mark).toUpperCase();
  const size = 64;
  const w = font.widthOfTextAtSize(label, size);
  // Roughly centre the rotated (45deg) baseline on the page.
  const cx = PAGE_W / 2 - (w / 2) * Math.SQRT1_2;
  const cy = PAGE_H / 2 - (w / 2) * Math.SQRT1_2;
  page.drawText(label, {
    x: cx, y: cy, size, font, color: WATERMARK, opacity: 0.16, rotate: degrees(45),
  });
}

/**
 * Emit the multipage Contour Studio deliverable PDF from the pure content model.
 * One PDF page per `model.pages` entry; the model's title block is drawn as a
 * header on the first page. Returns the PDF bytes. Renders honest text only —
 * nothing beyond what the model provides.
 */
export async function buildContourStudioPdf(model: ContourPdfModel): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const contentW = PAGE_W - 2 * MARGIN;

  model.pages.forEach((modelPage, pageIndex) => {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    if (model.watermark) drawWatermark(page, bold, model.watermark);

    let y = PAGE_H - MARGIN;

    const drawLine = (s: string, size: number, f: PDFFont, color = INK): void => {
      for (const ln of wrap(s, f, size, contentW)) {
        page.drawText(ln, { x: MARGIN, y, size, font: f, color });
        y -= size * 1.4;
      }
    };

    // The model's title block is the cover header — drawn once, on page 1.
    if (pageIndex === 0) {
      model.titleBlock.forEach((ln, i) => {
        if (i === 0) drawLine(ln, 18, bold);
        else drawLine(ln, 9.5, font, DIM);
      });
      y -= 8;
      page.drawLine({
        start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 1, color: RULE,
      });
      y -= 22;
    }

    // Section heading + body lines — verbatim from the model.
    drawLine(modelPage.title, 14, bold);
    y -= 6;
    for (const ln of modelPage.lines) {
      if (ln.trim().length === 0) { y -= 8; continue; }
      drawLine(ln, 10.5, font);
      y -= 2;
    }

    // Footer: producing software line, honest and small.
    page.drawText(safe(model.evidenceBadge), {
      x: MARGIN, y: MARGIN - 18, size: 7.5, font, color: DIM,
    });
    const pageLabel = `${pageIndex + 1} / ${model.pages.length}`;
    page.drawText(pageLabel, {
      x: PAGE_W - MARGIN - font.widthOfTextAtSize(pageLabel, 7.5),
      y: MARGIN - 18, size: 7.5, font, color: DIM,
    });
  });

  return doc.save();
}
