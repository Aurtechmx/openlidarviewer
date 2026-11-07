/**
 * pageKit.ts: page furniture for the watershed report (spine, headings,
 * wrapped paragraphs, tables, KPI rows, verdict chips, callouts).
 *
 * Every text helper splits runs so characters in SYMBOL_ONLY_CHARS are drawn
 * with `fonts.symbol` and measured with it. Lines wrap at ordinary spaces only,
 * never at U+00A0. Helpers return a new cursor and start a continuation page
 * when the next block would cross the bottom margin.
 *
 * Belongs to the report's lazy chunk.
 */
import { PDFDocument, rgb, degrees } from 'pdf-lib';
import type { PDFFont, PDFPage, RGB } from 'pdf-lib';
import type { Verdict } from '../../simulation/flowPulse/watershed/catchmentQuality';
import { SYMBOL_ONLY_CHARS } from './reportFonts';
import type { ReportFonts } from './reportFonts';

export interface Box { x: number; y: number; width: number; height: number }

const hex = (h: number): RGB => rgb(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);

export const PALETTE: {
  readonly ink: RGB; readonly ink2: RGB; readonly paper: RGB; readonly rule: RGB; readonly water: RGB;
  readonly water2: RGB; readonly earth: RGB; readonly ochre: RGB; readonly teal: RGB; readonly mute: RGB;
} = {
  ink: hex(0x1f2a37), ink2: hex(0x3b4a5c), paper: hex(0xffffff), rule: hex(0xd5d9de), water: hex(0x2b6f8f),
  water2: hex(0x9fc5d6), earth: hex(0xb5541f), ochre: hex(0xb88a2e), teal: hex(0x2e7d6f), mute: hex(0x6b7280),
};

export type PageSize = 'letter' | 'a4';

export interface PageCursor {
  page: PDFPage;
  y: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  /** Document, size, spine and footer, so helpers can start continuation pages. */
  readonly ctx: PageContext;
}

const SIZES: Record<PageSize, readonly [number, number]> = { letter: [612, 792], a4: [595.28, 841.89] };
const SPINE_W = 34;
const MARGIN_LEFT = 26;
const MARGIN_RIGHT = 30;
const MARGIN_TOP = 40;
const BOTTOM = 54;
// Captions and labels are 1.4 times, and table text 1.25 times, their earlier sizes. Body text and
// section titles were raised just enough to stay above them.
const SZ = { pageTitle: 18, section: 12, body: 11, table: 10.6, caption: 10.5 } as const;
const LEAD = 1.4;

export interface PageContext {
  readonly doc: PDFDocument;
  readonly size: PageSize;
  readonly spine: { readonly id: string; readonly section: string; readonly pageNo: number; readonly status?: string | null };
  readonly fonts: ReportFonts;
  readonly footer: string;
}

// --- Run splitting ---------------------------------------------------------

/** `sup` runs are exponents, drawn smaller and raised. */
export interface Run { readonly text: string; readonly font: PDFFont; readonly sup?: boolean }

/** Exponent size and rise, as fractions of the line's size. */
export const SUP_SCALE = 0.7;
const SUP_RISE = 0.36;

/**
 * Splits `text` into runs: characters in SYMBOL_ONLY_CHARS go to the Symbol
 * font, and `^{...}` marks an exponent (for example `L^{0.77}`).
 */
export function splitRuns(text: string, font: PDFFont, fonts: ReportFonts): Run[] {
  const out: Run[] = [];
  const re = /\^\{([^}]*)\}/g;
  let last = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push(...plainRuns(text.slice(last, m.index), font, fonts));
    out.push(...plainRuns(m[1]!, font, fonts).map((r) => ({ ...r, sup: true })));
    last = m.index + m[0].length;
  }
  out.push(...plainRuns(text.slice(last), font, fonts));
  return out;
}

function plainRuns(text: string, font: PDFFont, fonts: ReportFonts): Run[] {
  const runs: Run[] = [];
  let buf = '';
  for (const ch of text) {
    if (SYMBOL_ONLY_CHARS.includes(ch)) {
      if (buf) runs.push({ text: buf, font });
      buf = '';
      runs.push({ text: ch, font: fonts.symbol });
    } else buf += ch;
  }
  if (buf) runs.push({ text: buf, font });
  return runs;
}

export function widthOf(text: string, font: PDFFont, size: number, fonts: ReportFonts): number {
  let w = 0;
  for (const r of splitRuns(text, font, fonts)) w += r.font.widthOfTextAtSize(r.text, r.sup ? size * SUP_SCALE : size);
  return w;
}

export interface DrawOpts { readonly font: PDFFont; readonly size: number; readonly color: RGB }

/** Draws `text` starting at x; returns the x after it. */
export function drawRuns(page: PDFPage, text: string, x: number, y: number, o: DrawOpts, fonts: ReportFonts): number {
  let cx = x;
  for (const r of splitRuns(text, o.font, fonts)) {
    const size = r.sup ? o.size * SUP_SCALE : o.size;
    page.drawText(r.text, { x: cx, y: r.sup ? y + o.size * SUP_RISE : y, font: r.font, size, color: o.color });
    cx += r.font.widthOfTextAtSize(r.text, size);
  }
  return cx;
}

export function drawRight(page: PDFPage, text: string, rightX: number, y: number, o: DrawOpts, fonts: ReportFonts): void {
  drawRuns(page, text, rightX - widthOf(text, o.font, o.size, fonts), y, o, fonts);
}

// --- Wrapping --------------------------------------------------------------

interface Word { readonly text: string; readonly font: PDFFont }

/** Breaks only at ordinary spaces; a word wider than the line is split by character. */
function wrapWords(words: readonly Word[], width: number, size: number, fonts: ReportFonts, spaceFont: PDFFont): Word[][] {
  const space = widthOf(' ', spaceFont, size, fonts);
  const lines: Word[][] = [];
  let line: Word[] = [];
  let used = 0;
  const flush = () => { if (line.length) lines.push(line); line = []; used = 0; };
  for (const word of words) {
    let w = widthOf(word.text, word.font, size, fonts);
    if (w > width) {
      flush();
      let chunk = '';
      for (const ch of word.text) {
        if (chunk && widthOf(chunk + ch, word.font, size, fonts) > width) {
          lines.push([{ text: chunk, font: word.font }]);
          chunk = '';
        }
        chunk += ch;
      }
      line = [{ text: chunk, font: word.font }];
      used = widthOf(chunk, word.font, size, fonts);
      continue;
    }
    const add = line.length ? space + w : w;
    if (line.length && used + add > width) {
      flush();
      w = widthOf(word.text, word.font, size, fonts);
      line = [word];
      used = w;
    } else {
      line.push(word);
      used += add;
    }
  }
  flush();
  return lines;
}

function toWords(text: string, font: PDFFont): Word[] {
  return text.split(' ').filter((w) => w.length > 0).map((w) => ({ text: w, font }));
}

function drawLine(page: PDFPage, line: readonly Word[], x: number, y: number, size: number, color: RGB, fonts: ReportFonts, spaceFont: PDFFont): void {
  const space = widthOf(' ', spaceFont, size, fonts);
  let cx = x;
  line.forEach((w, i) => {
    if (i > 0) cx += space;
    cx = drawRuns(page, w.text, cx, y, { font: w.font, size, color }, fonts);
  });
}

/** Upper case outside parentheses, so a unit such as (m²) keeps its case. */
export function headerCase(text: string): string {
  return text.replace(/\([^)]*\)|[^(]+/g, (part) => (part.startsWith('(') ? part : part.toUpperCase()));
}

// --- Pages -----------------------------------------------------------------

const SPINE_TOP_GAP = 70;
const SPINE_TEXT = 11.9;
const SPINE_BOTTOM = 62;

/** `spine.pageNo` is advisory: the number printed is the page's position in `doc`, so numbers never repeat. */
export function newPage(
  doc: PDFDocument,
  size: PageSize,
  spine: { readonly id: string; readonly section: string; readonly pageNo: number; readonly status?: string | null },
  fonts: ReportFonts,
  footer: string,
): PageCursor {
  const [w, h] = SIZES[size];
  const page = doc.addPage([w, h]);
  const ctx: PageContext = { doc, size, spine, fonts, footer };
  page.drawRectangle({ x: 0, y: 0, width: w, height: h, color: PALETTE.paper });
  page.drawRectangle({ x: 0, y: 0, width: SPINE_W, height: h, color: PALETTE.ink });
  const light = hex(0xb9c2cc);
  const id = spine.id;
  drawRuns(page, id, (SPINE_W - widthOf(id, fonts.titleBold, 17, fonts)) / 2, h - 40, { font: fonts.titleBold, size: 17, color: PALETTE.paper }, fonts);
  // Section rotated 90 degrees, tracked 14 %, reading upward, clamped to the space under the id.
  const track = SPINE_TEXT * 0.14;
  const room = h - SPINE_TOP_GAP - SPINE_BOTTOM;
  const trackedWidth = (t: string) => widthOf(t, fonts.body, SPINE_TEXT, fonts) + track * [...t].length;
  let sec = spine.section.toUpperCase();
  if (trackedWidth(sec) > room) {
    let chars = [...sec];
    while (chars.length > 0 && trackedWidth(chars.join('') + '...') > room) chars = chars.slice(0, -1);
    sec = chars.join('') + '...';
  }
  let along = SPINE_BOTTOM;
  for (const r of splitRuns(sec, fonts.body, fonts)) {
    for (const ch of r.text) {
      page.drawText(ch, { x: SPINE_W / 2 + 4.5, y: along, font: r.font, size: SPINE_TEXT, color: light, rotate: degrees(90) });
      along += r.font.widthOfTextAtSize(ch, SPINE_TEXT) + track;
    }
  }
  const pn = String(doc.getPageCount());
  drawRuns(page, pn, (SPINE_W - widthOf(pn, fonts.body, 12.6, fonts)) / 2, 14, { font: fonts.body, size: 12.6, color: light }, fonts);
  const left = SPINE_W + MARGIN_LEFT;
  const right = w - MARGIN_RIGHT;
  page.drawLine({ start: { x: left, y: 40 }, end: { x: right, y: 40 }, thickness: 0.5, color: PALETTE.rule });
  drawRuns(page, footer, left, 28, { font: fonts.body, size: SZ.caption, color: PALETTE.mute }, fonts);
  // The terrain status (PREVIEW / not survey-grade) on every page, right-aligned in the footer.
  if (spine.status) drawRight(page, spine.status, right, 28, { font: fonts.bodyBold, size: SZ.caption, color: PALETTE.earth }, fonts);
  return { page, y: h - MARGIN_TOP, left, right, bottom: BOTTOM, ctx };
}

function need(c: PageCursor): PageContext {
  if (!c.ctx) throw new Error('pageKit: cursor has no page context; create it with newPage');
  return c.ctx;
}

function nextPage(c: PageCursor): PageCursor {
  const x = need(c);
  return newPage(x.doc, x.size, x.spine, x.fonts, x.footer);
}

/** Starts the next page of the same section when `needed` points do not fit. */
function ensure(c: PageCursor, needed: number): PageCursor {
  need(c);
  return c.y - needed >= c.bottom ? c : nextPage(c);
}

/** Wraps each newline-separated block into lines. */
function wrapBlocks(text: string, width: number, size: number, fonts: ReportFonts, font: PDFFont, lead?: string): Word[][] {
  const out: Word[][] = [];
  text.split('\n').forEach((block, i) => {
    const words = [...(i === 0 && lead ? toWords(lead, fonts.bodyBold) : []), ...toWords(block, font)];
    out.push(...wrapWords(words, width, size, fonts, fonts.body));
  });
  return out;
}

// --- Blocks ----------------------------------------------------------------

export function heading(c: PageCursor, kicker: string, title: string, lede: string | null, fonts: ReportFonts): PageCursor {
  const ledeSize = 11;
  const titleBlock = SZ.caption + SZ.pageTitle + 4 + 10;
  // Keep the title with the first line of the lede.
  let cur = ensure(c, titleBlock + (lede ? ledeSize * LEAD : 0) + 4);
  let y = cur.y - SZ.caption;
  drawRuns(cur.page, kicker.toUpperCase(), cur.left, y, { font: fonts.bodyBold, size: SZ.caption, color: PALETTE.water }, fonts);
  y -= SZ.pageTitle + 4;
  drawRuns(cur.page, title, cur.left, y, { font: fonts.titleBold, size: SZ.pageTitle, color: PALETTE.ink }, fonts);
  y -= 10;
  cur = { ...cur, y };
  if (lede) cur = paragraph(cur, lede, fonts, { size: ledeSize });
  return { ...cur, y: cur.y - 6 };
}

/** Section title at 12.5 pt with a 1.5 pt water rule beneath; kept with the next body line. */
export function sectionTitle(c: PageCursor, text: string, fonts: ReportFonts): PageCursor {
  const cur = ensure(c, SZ.section + 14 + SZ.body * LEAD + 4);
  const y = cur.y - SZ.section;
  drawRuns(cur.page, text, cur.left, y, { font: fonts.titleBold, size: SZ.section, color: PALETTE.ink }, fonts);
  cur.page.drawLine({ start: { x: cur.left, y: y - 4 }, end: { x: cur.right, y: y - 4 }, thickness: 0.5, color: PALETTE.rule });
  return { ...cur, y: y - 14 };
}

export function paragraph(c: PageCursor, text: string, fonts: ReportFonts, opts?: { lead?: string; size?: number }): PageCursor {
  need(c);
  const size = opts?.size ?? SZ.body;
  const step = size * LEAD;
  let cur = c;
  for (const line of wrapBlocks(text, c.right - c.left, size, fonts, fonts.body, opts?.lead)) {
    cur = ensure(cur, step);
    drawLine(cur.page, line, cur.left, cur.y - size, size, PALETTE.ink, fonts, fonts.body);
    cur = { ...cur, y: cur.y - step };
  }
  return { ...cur, y: cur.y - 4 };
}

const CELL_GUTTER = 6;

export function table(
  c: PageCursor,
  columns: readonly { readonly title: string; readonly align: 'left' | 'right'; readonly width: number }[],
  rows: readonly (readonly string[])[],
  fonts: ReportFonts,
  opts?: { readonly size?: number },
): PageCursor {
  need(c);
  // Body size of the cells; the line step scales with it from 9.5 pt on 12.5 pt.
  const bodySize = opts?.size ?? SZ.table;
  const TABLE_LINE = bodySize * 1.32;
  const total = columns.reduce((a, col) => a + col.width, 0);
  if (total > c.right - c.left + 0.01) {
    throw new Error(`pageKit.table: columns total ${total} pt, wider than the ${c.right - c.left} pt text area`);
  }
  rows.forEach((row, i) => {
    if (row.length !== columns.length) {
      throw new Error(`pageKit.table: row ${i} has ${row.length} cells for ${columns.length} columns`);
    }
  });
  const xs: number[] = [];
  let x = c.left;
  for (const col of columns) { xs.push(x); x += col.width; }
  const rule = (page: PDFPage, y: number, thickness: number, color: RGB) =>
    page.drawLine({ start: { x: c.left, y }, end: { x: c.left + total, y }, thickness, color });
  /** Draws one wrapped row whose top is `top`; returns its height. */
  const drawRow = (page: PDFPage, texts: readonly string[], top: number, font: PDFFont, size: number, color: RGB, upper: boolean): number => {
    const cells = texts.map((t, i) =>
      wrapBlocks(upper ? headerCase(t) : t, Math.max(1, columns[i]!.width - CELL_GUTTER), size, fonts, font));
    const n = Math.max(1, ...cells.map((l) => l.length));
    cells.forEach((lines, i) => {
      const col = columns[i]!;
      lines.forEach((line, k) => {
        const y = top - 2 - size - k * TABLE_LINE;
        const text = line.map((w) => w.text).join(' ');
        const o = { font, size, color };
        if (col.align === 'right') drawRight(page, text, xs[i]! + col.width, y, o, fonts);
        else drawRuns(page, text, xs[i]!, y, o, fonts);
      });
    });
    return n * TABLE_LINE + 4;
  };
  const measure = (texts: readonly string[], font: PDFFont, size: number, upper: boolean): number =>
    Math.max(1, ...texts.map((t, i) =>
      wrapBlocks(upper ? headerCase(t) : t, Math.max(1, columns[i]!.width - CELL_GUTTER), size, fonts, font).length)) * TABLE_LINE + 4;
  const titles = columns.map((col) => col.title);
  const header = (cur: PageCursor): PageCursor => {
    const h = drawRow(cur.page, titles, cur.y, fonts.bodyBold, SZ.caption, PALETTE.mute, true);
    rule(cur.page, cur.y - h + 2, 0.8, PALETTE.ink);
    return { ...cur, y: cur.y - h };
  };
  const hdrH = measure(titles, fonts.bodyBold, SZ.caption, true);
  const firstH = rows.length ? measure(rows[0]!, fonts.body, bodySize, false) : 0;
  let cur = header(ensure(c, hdrH + firstH));
  for (const row of rows) {
    const h = measure(row, fonts.body, bodySize, false);
    if (cur.y - h < cur.bottom) cur = header(nextPage(cur));
    drawRow(cur.page, row, cur.y, fonts.body, bodySize, PALETTE.ink, false);
    rule(cur.page, cur.y - h + 3, 0.4, PALETTE.rule);
    cur = { ...cur, y: cur.y - h };
  }
  return { ...cur, y: cur.y - 6 };
}

export function kpiRow(
  c: PageCursor,
  items: readonly { readonly value: string; readonly label: string; readonly detail: string }[],
  fonts: ReportFonts,
  opts?: { readonly muted?: boolean },
): PageCursor {
  need(c);
  const perRow = 4;
  const gap = 14;
  const cellW = (c.right - c.left - gap * (perRow - 1)) / perRow;
  const lay = (it: (typeof items)[number]) => ({
    v: wrapBlocks(it.value, cellW, 16, fonts, fonts.titleBold),
    l: wrapBlocks(it.label.toUpperCase(), cellW, SZ.caption, fonts, fonts.body),
    d: wrapBlocks(it.detail, cellW, 11.25, fonts, fonts.body),
  });
  let cur = c;
  for (let i = 0; i < items.length; i += perRow) {
    const group = items.slice(i, i + perRow).map(lay);
    // Values, labels and details each start on a common line across the row.
    const vMax = Math.max(...group.map((g) => g.v.length));
    const lMax = Math.max(...group.map((g) => g.l.length));
    const rowH = vMax * 19 + lMax * 14 + Math.max(...group.map((g) => g.d.length)) * 14.5 + 6;
    cur = ensure(cur, rowH);
    group.forEach((g, j) => {
      const x = cur.left + j * (cellW + gap);
      let y = cur.y;
      const put = (lines: Word[][], size: number, step: number, font: PDFFont, color: RGB, lift: number) => {
        for (const line of lines) {
          y -= lift;
          drawLine(cur.page, line, x, y, size, color, fonts, font);
          y -= step - lift;
        }
      };
      put(g.v, 16, 19, fonts.titleBold, opts?.muted ? PALETTE.mute : PALETTE.ink, 16);
      y = cur.y - vMax * 19;
      put(g.l, SZ.caption, 14, fonts.body, PALETTE.mute, 11);
      y = cur.y - vMax * 19 - lMax * 14;
      put(g.d, 11.25, 14.5, fonts.body, PALETTE.ink2, 11.25);
    });
    cur = { ...cur, y: cur.y - rowH };
  }
  return { ...cur, y: cur.y - 4 };
}

const CHIP_COLOUR: Record<Verdict, RGB> = { supported: PALETTE.water, limited: PALETTE.ink2, 'not-supported': PALETTE.earth };
/** White on teal and earth is above 4.5:1; white on ochre is 3.3:1, so that chip uses ink text (4.6:1). */
const CHIP_TEXT: Record<Verdict, RGB> = { supported: rgb(1, 1, 1), limited: rgb(1, 1, 1), 'not-supported': rgb(1, 1, 1) };

/** Draws a verdict chip with its text baseline at y; returns the chip width. */
export function chip(page: PDFPage, x: number, y: number, verdict: Verdict, label: string, fonts: ReportFonts): number {
  const padX = 6;
  const w = widthOf(label, fonts.bodyBold, SZ.caption, fonts) + padX * 2;
  page.drawRectangle({ x, y: y - 4, width: w, height: 15, color: CHIP_COLOUR[verdict] });
  drawRuns(page, label, x + padX, y, { font: fonts.bodyBold, size: SZ.caption, color: CHIP_TEXT[verdict] }, fonts);
  return w;
}

export function callout(c: PageCursor, text: string, tone: 'info' | 'warn', fonts: ReportFonts): PageCursor {
  need(c);
  const pad = 8;
  // A thin left rule only; no fill.
  const bar = tone === 'warn' ? PALETTE.ink : PALETTE.water;
  const size = SZ.body - 0.5;
  const step = size * LEAD;
  const lines = wrapBlocks(text, c.right - c.left - pad * 2 - 3, size, fonts, fonts.body);
  let cur = ensure(c, pad * 2 + size);
  let i = 0;
  let lastBaseline = cur.y;
  while (i < lines.length) {
    const fit = Math.floor((cur.y - cur.bottom - pad * 2 - size) / step) + 1;
    const n = Math.max(1, Math.min(fit, lines.length - i));
    const top = cur.y;
    lastBaseline = top - pad - size - (n - 1) * step;
    const bottom = lastBaseline - pad;
    // Fill and bar are drawn per page, flush with that page's last line.
    cur.page.drawRectangle({ x: cur.left, y: bottom, width: 1.2, height: top - bottom, color: bar });
    for (let k = 0; k < n; k++) {
      drawLine(cur.page, lines[i + k]!, cur.left + pad + 3, top - pad - size - k * step, size, PALETTE.ink, fonts, fonts.body);
    }
    i += n;
    cur = { ...cur, y: bottom };
    if (i < lines.length) cur = nextPage(cur);
  }
  return { ...cur, y: lastBaseline - pad - 8 };
}
