/**
 * mapSheetStyledAppendix.ts: the purpose appendix page of a Light or Dark map
 * sheet. It states the same content as the Classic page, from
 * {@link purposeAppendixContent}, on the style's paper, ink and typefaces.
 */
import type { PDFDocument } from 'pdf-lib';
import type { SheetFonts } from '../../export/sheetKit/fonts';
import { SHEET_SPACE, SHEET_TYPE, type SheetTokens } from '../../export/sheetKit/tokens';
import {
  drawFooter,
  drawPaper,
  drawSectionLabel,
  pdfColor,
  sheetText,
  wrapSheetText,
} from '../../export/sheetKit/primitives';
import type { PurposeAppendixContent } from './mapSheetPdf';

/** Width of the settings key column, points. */
const KEY_W = 150;

/**
 * Add the appendix page. Every row sits inside its box with room below the
 * last line, and the page carries the same footer as sheet one.
 */
export function drawStyledPurposeAppendix(
  doc: PDFDocument,
  content: PurposeAppendixContent,
  pageSize: readonly [number, number],
  margin: number,
  footerLeft: string,
  t: SheetTokens,
  f: SheetFonts,
): void {
  const [PW, PH] = pageSize;
  const page = doc.addPage([PW, PH]);
  drawPaper(page, t);
  const x = margin, w = PW - 2 * margin;
  let y = PH - margin - SHEET_TYPE.title;

  sheetText(page, content.title, x, y, { font: f.sansBold, size: SHEET_TYPE.title, color: t.ink }, f);
  y -= SHEET_SPACE.lg;
  for (const ln of wrapSheetText(content.statement, f.sans, SHEET_TYPE.note, w, f)) {
    sheetText(page, ln, x, y, { font: f.sans, size: SHEET_TYPE.note, color: t.dim }, f);
    y -= SHEET_TYPE.note * 1.4;
  }
  y -= SHEET_SPACE.lg;

  // Settings: key on the left, value wrapped in its own column.
  y = drawSectionLabel(page, 'This deliverable', x, y, w, t, f);
  const step = SHEET_TYPE.dataValue * 1.6;
  for (const [key, value] of content.settings) {
    sheetText(page, key, x, y, { font: f.sansBold, size: SHEET_TYPE.dataKey, color: t.dim }, f);
    for (const ln of wrapSheetText(value, f.sans, SHEET_TYPE.dataValue, w - KEY_W, f)) {
      sheetText(page, ln, x + KEY_W, y, { font: f.sans, size: SHEET_TYPE.dataValue, color: t.ink }, f);
      y -= step;
    }
  }
  y -= SHEET_SPACE.md;
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: t.weight.rule, color: pdfColor(t.rule) });
  y -= SHEET_SPACE.xl;

  if (content.validation) {
    y = drawSectionLabel(page, 'Validation appendix', x, y, w, t, f);
    const tone = { warn: t.warn, dim: t.dim, ink: t.ink } as const;
    for (const ln of content.validation) {
      for (const part of wrapSheetText(ln.text, f.sans, SHEET_TYPE.note, w, f)) {
        sheetText(page, part, x, y, { font: f.sans, size: SHEET_TYPE.note, color: tone[ln.tone] }, f);
        y -= SHEET_TYPE.note * 1.4;
      }
      y -= SHEET_SPACE.sm;
    }
  }

  drawFooter(page, footerLeft, '2 / 2', margin, PW - margin, margin, t, f);
}
