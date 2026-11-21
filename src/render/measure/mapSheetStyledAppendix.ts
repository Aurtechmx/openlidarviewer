/**
 * mapSheetStyledAppendix.ts: the purpose appendix page of a Light or Dark map
 * sheet. It states the same content as the Classic page, from
 * {@link purposeAppendixContent}, laid out as a spec sheet: a kicker and title,
 * the purpose statement at reading size, the settings grouped in two columns
 * with each value under its key, and the validation note as a callout.
 */
import type { PDFDocument, PDFPage } from 'pdf-lib';
import type { SheetFonts } from '../../export/sheetKit/fonts';
import { SHEET_SCALE, SHEET_SPACE, SHEET_TYPE, type SheetRgb, type SheetTokens } from '../../export/sheetKit/tokens';
import {
  drawFooter,
  drawPaper,
  pdfColor,
  sheetText,
  wrapSheetText,
} from '../../export/sheetKit/primitives';
import type { PurposeAppendixContent } from './mapSheetPdf';

/** The settings, grouped by what they decide. A key not listed lands in the last group. */
const GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['Line geometry', ['Geometry', 'Cartographic smoothing', 'Generalization']],
  ['Index and labels', ['Contour index interval', 'Labels']],
  ['Appearance', ['Hillshade', 'Hypsometric tint']],
  ['Packaging', ['Exploratory output allowed', 'Complete package']],
];

/** Reading size for values, the statement and the validation note, before page scaling. */
const READ = SHEET_SCALE.lead;

/**
 * Type and spacing grow with the sheet, so an A3 page is not a Letter page
 * marooned in margin: 1 up to a Letter or A4 short side, at most 1.3.
 */
function pageScale(PW: number, PH: number): number {
  return Math.min(1.3, Math.max(1, Math.min(PW, PH) / 612));
}

/** Sizes for one page, at scale `k`. */
interface Sz { readonly k: number; readonly read: number; readonly lead: number }

type Group = { readonly name: string; readonly rows: ReadonlyArray<readonly [string, string]> };

function groupsOf(settings: PurposeAppendixContent['settings']): Group[] {
  const used = new Set<string>();
  const out: Group[] = GROUPS.map(([name, keys]) => {
    const rows = settings.filter(([k]) => keys.includes(k));
    rows.forEach(([k]) => used.add(k));
    return { name, rows };
  });
  const rest = settings.filter(([k]) => !used.has(k));
  if (rest.length > 0) out[out.length - 1] = { ...out[out.length - 1]!, rows: [...out[out.length - 1]!.rows, ...rest] };
  return out.filter((g) => g.rows.length > 0);
}

/** A group heading: a rule, then the name in the accent colour, larger than the keys under it. */
function groupHeading(page: PDFPage, name: string, x: number, y: number, w: number, t: SheetTokens, f: SheetFonts, z: Sz): number {
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, thickness: t.weight.rule, color: pdfColor(t.rule) });
  const base = y - (SHEET_SPACE.md + SHEET_TYPE.kicker * 0.7) * z.k;
  sheetText(page, name.toUpperCase(), x, base, { font: f.sansBold, size: SHEET_TYPE.kicker * z.k, color: t.accent }, f);
  return base - SHEET_SPACE.lg * z.k;
}

/** Draws one group: each value sits close under its key, rows further apart. Returns the y below it. */
function drawGroup(page: PDFPage, g: Group, x: number, y: number, w: number, t: SheetTokens, f: SheetFonts, z: Sz): number {
  let cy = groupHeading(page, g.name, x, y, w, t, f, z);
  g.rows.forEach(([key, value], i) => {
    if (i > 0) cy -= (SHEET_SPACE.lg + SHEET_TYPE.dataKey) * z.k;
    sheetText(page, key.toUpperCase(), x, cy, { font: f.sansBold, size: SHEET_TYPE.dataKey * z.k, color: t.dim }, f);
    cy -= SHEET_SPACE.xs * z.k + z.read;
    const lines = wrapSheetText(value, f.sans, z.read, w, f);
    lines.forEach((ln, j) => {
      if (j > 0) cy -= z.lead;
      sheetText(page, ln, x, cy, { font: f.sans, size: z.read, color: t.ink }, f);
    });
  });
  return cy - SHEET_SPACE.xl * z.k;
}

function paragraph(page: PDFPage, s: string, x: number, y: number, w: number, color: SheetRgb, f: SheetFonts, z: Sz): number {
  let cy = y;
  for (const ln of wrapSheetText(s, f.sans, z.read, w, f)) {
    sheetText(page, ln, x, cy, { font: f.sans, size: z.read, color }, f);
    cy -= z.lead;
  }
  return cy;
}

/**
 * Add the appendix page. The settings sit in two columns, filled in group
 * order so each column holds about half the rows; the validation note spans
 * the page below them. The page carries the same footer as sheet one.
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
  const k = pageScale(PW, PH);
  const z: Sz = { k, read: READ * k, lead: READ * k * 1.35 };
  let y = PH - margin - SHEET_TYPE.kicker * k;

  // Kicker, title and statement. The statement keeps a reading measure.
  sheetText(page, 'CONTOUR MAP  ·  DELIVERABLE', x, y, { font: f.sansBold, size: SHEET_TYPE.kicker * k, color: t.accent }, f);
  y -= (SHEET_SPACE.sm + SHEET_TYPE.title) * k;
  sheetText(page, content.title, x, y, { font: f.sansBold, size: SHEET_TYPE.title * k, color: t.ink }, f);
  y -= SHEET_SPACE.md * k + z.read;
  y = paragraph(page, content.statement, x, y, Math.min(w, 430 * k), t.dim, f, z);
  y -= SHEET_SPACE.xl * k;

  // Settings in two columns. Reading order runs down the left column, then
  // the right: the first half of the groups on the left.
  const gutter = SHEET_SPACE.xl * k;
  const colW = (w - gutter) / 2;
  const groups = groupsOf(content.settings);
  const half = Math.ceil(groups.length / 2);
  const cols = [y, y];
  groups.forEach((g, i) => {
    const c = i < half ? 0 : 1;
    cols[c] = drawGroup(page, g, x + c * (colW + gutter), cols[c]!, colW, t, f, z);
  });
  y = Math.min(cols[0]!, cols[1]!);

  // The validation note: a callout with a bar in the warning colour, from the
  // first line's cap height to the last line's baseline.
  if (content.validation) {
    y = groupHeading(page, 'Validation appendix', x, y, w, t, f, z);
    const top = y + z.read * 0.75;
    const tone = { warn: t.warn, dim: t.dim, ink: t.ink } as const;
    const inset = SHEET_SPACE.lg * k;
    let last = y;
    content.validation.forEach((ln, i) => {
      if (i > 0) y -= SHEET_SPACE.sm * k;
      last = y = paragraph(page, ln.text, x + inset, y, Math.min(w, 520 * k) - inset, tone[ln.tone], f, z) + z.lead;
      y -= z.lead;
    });
    page.drawRectangle({ x, y: last - z.read * 0.25, width: 3, height: top - (last - z.read * 0.25), color: pdfColor(t.warn) });
  }

  drawFooter(page, footerLeft, '2 / 2', margin, PW - margin, margin, t, f);
}
