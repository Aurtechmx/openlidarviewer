/**
 * mapSheetStyledMarks.ts: the measurement and annotation lists of a Light or
 * Dark map sheet. The side panel lists as many as fit; the rest continue on
 * sheets of their own, so every letter and number on the map is listed
 * somewhere and no list runs off a page.
 */
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib';
import type { SheetFonts } from '../../export/sheetKit/fonts';
import { supportWord, type SheetMeasurement } from '../../export/sheetKit/sheetMeasurement';
import { SHEET_SCALE, SHEET_SPACE, SHEET_TYPE, type SheetRgb, type SheetTokens } from '../../export/sheetKit/tokens';
import { drawFooter, drawPaper, drawSectionLabel, sectionLabelHeight, sheetText, wrapSheetText } from '../../export/sheetKit/primitives';
import type { AnnotationReportRow } from './annotationReportTable';
import type { MapSheetWords } from '../../export/localizeMapSheet';
import type { MapSheetKey } from '../../i18n/deliverables/mapSheet';

/** A measurement's letter: A to Z, then AA, AB and on. */
export function measurementLetter(i: number): string {
  let n = i + 1, out = '';
  while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
  return out;
}

/** The colour an annotation type is drawn and grouped in. */
export function annotationColor(t: SheetTokens, type: string): SheetRgb {
  if (type === 'issue') return t.area;
  if (type === 'warning') return t.warn;
  if (type === 'info') return t.accent;
  return t.minor;
}

/** One printed line of a list. `label` is a measurement letter on its first line. */
export interface MarkLine {
  readonly label: string | null;
  readonly text: string;
  readonly font: PDFFont;
  readonly color: SheetRgb;
  readonly indent: number;
  /** Space above the line, points at scale 1. */
  readonly gap: number;
  /** True on the first line of a measurement, an annotation row or a group heading: a column breaks only here. */
  readonly start: boolean;
}

/** Width of the letter column in the measurement list, points at scale 1. */
const LETTER_W = 18;
const ANNOTATION_ORDER = ['issue', 'warning', 'note', 'info'] as const;
const GROUP_KEY: Record<(typeof ANNOTATION_ORDER)[number], MapSheetKey> = { issue: 'typeIssue', warning: 'typeWarning', note: 'typeNote', info: 'typeInfo' };

/** The lines of `ms`, lettered from `start`, at width `w` and scale `k`. */
export function measurementLines(
  ms: readonly SheetMeasurement[], start: number, w: number, k: number, t: SheetTokens, f: SheetFonts, words: MapSheetWords,
): MarkLine[] {
  const out: MarkLine[] = [];
  const sz = SHEET_TYPE.note * k;
  const tw = w - LETTER_W * k;
  ms.forEach((m, i) => {
    const lines: Array<[string, PDFFont, SheetRgb]> = [];
    for (const ln of wrapSheetText(m.name, f.sansBold, sz, tw, f)) lines.push([ln, f.sansBold, t.ink]);
    for (const ln of wrapSheetText(words.value(m.value), f.mono, sz, tw, f)) lines.push([ln, f.mono, t.ink]);
    for (const ln of wrapSheetText(words.say('support', { t_word: m.support ?? supportWord(m.grade) }), f.sans, sz, tw, f)) lines.push([ln, f.sans, m.grade === 'green' ? t.dim : t.warn]);
    for (const note of m.notes) for (const ln of wrapSheetText(words.translate(note), f.sans, sz, tw, f)) lines.push([ln, f.sans, t.dim]);
    lines.forEach(([text, font, color], j) => out.push({
      label: j === 0 ? measurementLetter(start + i) : null, text, font, color, indent: LETTER_W, gap: j === 0 && i > 0 ? SHEET_SPACE.sm : 0, start: j === 0,
    }));
  });
  return out;
}

/** Annotation report rows in the order they are listed: grouped by type. */
export function orderedAnnotationRows(rows: readonly AnnotationReportRow[]): AnnotationReportRow[] {
  return ANNOTATION_ORDER.flatMap((type) => rows.filter((r) => r.type === type));
}

/** The lines of annotation `rows` (already in list order), each group under its heading. */
export function annotationLines(rows: readonly AnnotationReportRow[], w: number, k: number, t: SheetTokens, f: SheetFonts, words: MapSheetWords): MarkLine[] {
  const out: MarkLine[] = [];
  const sz = SHEET_TYPE.note * k;
  for (const type of ANNOTATION_ORDER) {
    const group = rows.filter((r) => r.type === type);
    if (group.length === 0) continue;
    out.push({ label: null, text: words.say(GROUP_KEY[type], { n: group.length }), font: f.sansBold, color: annotationColor(t, type), indent: 0, gap: out.length > 0 ? SHEET_SPACE.xs : 0, start: true });
    for (const r of group) {
      const body = r.note ? `${r.title}: ${r.note}${r.noteTruncated ? '...' : ''}` : r.title;
      wrapSheetText(`${r.index}. ${body}`, f.sans, sz, w - 8 * k, f).forEach((ln, j) => out.push({ label: null, text: ln, font: f.sans, color: t.ink, indent: 8, gap: 0, start: j === 0 }));
    }
  }
  return out;
}

/** Height of `lines` at scale `k`. */
export function markLinesHeight(lines: readonly MarkLine[], k: number): number {
  return lines.reduce((a, l) => a + SHEET_TYPE.note * k * 1.4 + l.gap * k, 0);
}

/** Draws `lines` from the baseline above `y`. Returns the last baseline. */
export function drawMarkLines(page: PDFPage, lines: readonly MarkLine[], x: number, y: number, k: number, labelColor: SheetRgb, f: SheetFonts): number {
  let cy = y;
  const sz = SHEET_TYPE.note * k;
  for (const l of lines) {
    cy -= SHEET_TYPE.note * k * 1.4 + l.gap * k;
    if (l.label) sheetText(page, l.label, x, cy, { font: f.sansBold, size: sz, color: labelColor }, f);
    sheetText(page, l.text, x + l.indent * k, cy, { font: l.font, size: sz, color: l.color }, f);
  }
  return cy;
}

/** What the continuation sheets list. */
export interface MarksContinuation {
  /** Measurements not listed on sheet one, and the index of the first of them. */
  readonly measurements: readonly SheetMeasurement[];
  readonly measurementStart: number;
  /** Annotation rows not listed on sheet one, in list order. */
  readonly annotations: readonly AnnotationReportRow[];
}

type Section = { readonly heading: string; readonly lines: readonly MarkLine[] };
type Column = Array<{ readonly heading: string | null; readonly lines: MarkLine[] }>;

/**
 * Lays the remaining lists into pages of columns at scale 1. A list carries on
 * into the next column, and the next page, under a repeated heading.
 */
function paginate(sections: readonly Section[], cols: number, colH: number, words: MapSheetWords): Column[][] {
  const pages: Column[][] = [];
  let page: Column[] = [];
  let col: Column = [];
  let used = 0;
  const lineH = (l: MarkLine): number => SHEET_TYPE.note * 1.4 + l.gap;
  const headH = sectionLabelHeight(1);
  const nextCol = (): void => {
    page.push(col); col = []; used = 0;
    if (page.length === cols) { pages.push(page); page = []; }
  };
  for (const s of sections) {
    if (used > 0 && used + headH + SHEET_SPACE.lg + lineH(s.lines[0]!) > colH) nextCol();
    if (used > 0) used += SHEET_SPACE.lg;
    let block = { heading: s.heading as string | null, lines: [] as MarkLine[] };
    used += headH;
    // Whole units move to the next column: a measurement, or an annotation row.
    const units: MarkLine[][] = [];
    for (const l of s.lines) {
      if (l.start || units.length === 0) units.push([]);
      units[units.length - 1]!.push(l);
    }
    for (const unit of units) {
      const h = unit.reduce((a, l) => a + lineH(l), 0);
      if (used + h > colH && block.lines.length > 0) {
        col.push(block);
        nextCol();
        block = { heading: words.say('continued', { u_heading: s.heading }), lines: [] };
        used = headH;
      }
      // A unit taller than a whole column still breaks, line by line.
      for (const l of unit) {
        if (used + lineH(l) > colH && block.lines.length > 0) {
          col.push(block);
          nextCol();
          block = { heading: words.say('continued', { u_heading: s.heading }), lines: [] };
          used = headH;
        }
        block.lines.push(l);
        used += lineH(l);
      }
    }
    col.push(block);
  }
  if (col.length > 0) page.push(col);
  if (page.length > 0) pages.push(page);
  return pages;
}

/** The sheets a continuation needs on a page of `pageSize`, before any is drawn. */
export function continuationPages(c: MarksContinuation, pageSize: readonly [number, number], margin: number, t: SheetTokens, f: SheetFonts, words: MapSheetWords): number {
  return layoutContinuation(c, pageSize, margin, t, f, words).pages.length;
}

function layoutContinuation(c: MarksContinuation, pageSize: readonly [number, number], margin: number, t: SheetTokens, f: SheetFonts, words: MapSheetWords) {
  const [PW, PH] = pageSize;
  const cols = PW > PH ? 3 : 2;
  const gutter = SHEET_SPACE.xl;
  const colW = (PW - 2 * margin - gutter * (cols - 1)) / cols;
  const top = PH - margin - SHEET_TYPE.kicker - SHEET_SPACE.sm - SHEET_SCALE.lead - SHEET_SPACE.xl;
  const bottom = margin + 24;
  const sections: Section[] = [];
  if (c.measurements.length > 0) sections.push({ heading: words.say('measurements'), lines: measurementLines(c.measurements, c.measurementStart, colW, 1, t, f, words) });
  if (c.annotations.length > 0) sections.push({ heading: words.say('annotations'), lines: annotationLines(c.annotations, colW, 1, t, f, words) });
  return { pages: paginate(sections, cols, top - bottom, words), colW, gutter, top };
}

/**
 * Draws the continuation sheets after sheet one. `firstPage` is the number
 * sheet one's footer gives the first of them, `pageCount` the set's total.
 */
export function drawMarksContinuation(
  doc: PDFDocument, c: MarksContinuation, pageSize: readonly [number, number], margin: number,
  footerLeft: string, firstPage: number, pageCount: number, t: SheetTokens, f: SheetFonts, words: MapSheetWords,
): void {
  const { pages, colW, gutter, top } = layoutContinuation(c, pageSize, margin, t, f, words);
  const [PW, PH] = pageSize;
  pages.forEach((cols, p) => {
    const page = doc.addPage([PW, PH]);
    drawPaper(page, t);
    let y = PH - margin - SHEET_TYPE.kicker;
    sheetText(page, words.say('kicker'), margin, y, { font: f.sansBold, size: SHEET_TYPE.kicker, color: t.accent }, f);
    y -= SHEET_SPACE.sm + SHEET_SCALE.lead;
    sheetText(page, words.say('marksContinued'), margin, y, { font: f.sansBold, size: SHEET_SCALE.lead, color: t.ink }, f);
    cols.forEach((col, ci) => {
      const x = margin + ci * (colW + gutter);
      let cy = top;
      col.forEach((block, bi) => {
        if (bi > 0) cy -= SHEET_SPACE.lg;
        if (block.heading) cy = drawSectionLabel(page, block.heading, x, cy, colW, t, f) + SHEET_TYPE.note * 1.4;
        cy = drawMarkLines(page, block.lines, x, cy, 1, t.area, f);
      });
    });
    drawFooter(page, footerLeft, `${firstPage + p} / ${pageCount}`, margin, PW - margin, margin, t, f, words.draft);
  });
}
