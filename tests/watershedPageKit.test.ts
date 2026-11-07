/**
 * watershedPageKit.test.ts: the page kit wraps and paginates text inside the
 * margins, right-aligns numbers, colours verdict chips and draws symbol-only
 * characters with the symbol font.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import { embedReportFonts } from '../src/export/watershedReport/reportFonts';
import type { ReportFonts } from '../src/export/watershedReport/reportFonts';
import { PALETTE, newPage, heading, paragraph, table, kpiRow, chip, callout } from '../src/export/watershedReport/pageKit';
import type { PageCursor } from '../src/export/watershedReport/pageKit';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'watershedReport', 'fonts');
const fromDisk = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));

interface TextCall { text: string; x: number; y: number; font: PDFFont; size: number; rotated: boolean; color: { red: number; green: number; blue: number } }
interface RectCall { color: unknown; width?: number }

function spy(doc: PDFDocument) {
  const texts: TextCall[] = [];
  const rects: RectCall[] = [];
  const wrap = (page: PDFPage): PDFPage => {
    const dt = page.drawText.bind(page);
    page.drawText = ((text: string, o: { x: number; y: number; font: PDFFont; size: number; rotate?: unknown; color: never }) => {
      texts.push({ text, x: o.x, y: o.y, font: o.font, size: o.size, rotated: o.rotate !== undefined, color: o.color });
      return dt(text, o as never);
    }) as typeof page.drawText;
    const dr = page.drawRectangle.bind(page);
    page.drawRectangle = ((o: { color?: unknown; width?: number }) => {
      rects.push({ color: o.color, width: o.width });
      return dr(o as never);
    }) as typeof page.drawRectangle;
    return page;
  };
  const add = doc.addPage.bind(doc);
  doc.addPage = ((...a: never[]) => wrap(add(...a))) as typeof doc.addPage;
  return { texts, rects, wrap };
}

const SPINE = { id: '03', section: 'Cuenca', pageNo: 3 };
let doc: PDFDocument;
let fonts: ReportFonts;
let s: ReturnType<typeof spy>;
let cursor: PageCursor;

beforeAll(async () => {
  doc = await PDFDocument.create();
  fonts = await embedReportFonts(doc, fromDisk);
});

function fresh(size: 'letter' | 'a4' = 'letter') {
  s = spy(doc);
  cursor = newPage(doc, size, SPINE, fonts, 'Pie de página');
}

const SPANISH =
  'La cuenca drena hacia el sur por el cauce principal, con un tiempo de concentración estimado entre nueve y catorce minutos. ' +
  'El coeficiente de compacidad de Gravelius indica una forma alargada, y la pendiente media del terreno es moderada. ';

describe('page kit', () => {
  it('wraps and paginates a long Spanish paragraph without drawing below the bottom margin', () => {
    fresh();
    const pagesBefore = doc.getPageCount();
    const out = paragraph(cursor, SPANISH.repeat(40), fonts);
    expect(doc.getPageCount()).toBeGreaterThan(pagesBefore);
    const body = s.texts.filter((t) => !t.rotated && t.size === 11);
    expect(body.length).toBeGreaterThan(40);
    for (const t of body) {
      expect(t.y).toBeGreaterThanOrEqual(cursor.bottom);
      expect(t.x).toBeGreaterThanOrEqual(cursor.left);
    }
    expect(out.y).toBeGreaterThanOrEqual(out.bottom);
  });

  it('keeps text inside the right margin', () => {
    fresh('a4');
    paragraph(cursor, SPANISH.repeat(5), fonts);
    for (const t of s.texts.filter((x) => !x.rotated && x.size === 11)) {
      expect(t.x + t.font.widthOfTextAtSize(t.text, t.size)).toBeLessThanOrEqual(cursor.right + 0.01);
    }
  });

  it('right-aligns numeric table cells', () => {
    fresh();
    const cols = [
      { title: 'Nombre', align: 'left' as const, width: 200 },
      { title: 'Área (ha)', align: 'right' as const, width: 100 },
    ];
    table(cursor, cols, [['Norte', '4,82'], ['Sur', '1 203,5']], fonts);
    const colRight = cursor.left + 300;
    for (const v of ['4,82', '1 203,5']) {
      const call = s.texts.find((t) => t.text === v.replace(' ', ' ') || t.text === v);
      expect(call, v).toBeDefined();
      expect(call!.x + call!.font.widthOfTextAtSize(call!.text, call!.size)).toBeCloseTo(colRight, 1);
    }
    const left = s.texts.find((t) => t.text === 'Norte')!;
    expect(left.x).toBeCloseTo(cursor.left, 0);
  });

  it('chip colours: supported water, limited slate, not-supported earth', () => {
    fresh();
    const page = cursor.page;
    const expected = { supported: PALETTE.water, limited: PALETTE.ink2, 'not-supported': PALETTE.earth } as const;
    for (const v of ['supported', 'limited', 'not-supported'] as const) {
      const before = s.rects.length;
      const w = chip(page, 100, 400, v, v, fonts);
      expect(w).toBeGreaterThan(10);
      expect(s.rects[before]!.color).toEqual(expected[v]);
    }
  });

  it('draws symbol-only characters with the symbol font and measured widths', () => {
    fresh();
    paragraph(cursor, 'ab√cd', fonts);
    const runs = s.texts.filter((t) => !t.rotated && t.size === 11);
    expect(runs.map((r) => r.text)).toEqual(['ab', '√', 'cd']);
    expect(runs[1]!.font).toBe(fonts.symbol);
    expect(runs[0]!.font).not.toBe(fonts.symbol);
    expect(runs[2]!.x).toBeCloseTo(
      runs[1]!.x + fonts.symbol.widthOfTextAtSize('√', 11),
      4,
    );
    expect(runs[1]!.x).toBeCloseTo(runs[0]!.x + runs[0]!.font.widthOfTextAtSize('ab', 11), 4);
  });

  it('draws the symbol in table cells, headings and chips too', () => {
    fresh();
    table(cursor, [{ title: '√A', align: 'right', width: 120 }], [['√2']], fonts);
    heading(cursor, 'k', 'T√', 'lede √', fonts);
    kpiRow(cursor, [{ value: '√4', label: 'l', detail: 'd' }], fonts);
    callout(cursor, '√', 'info', fonts);
    chip(cursor.page, 80, 300, 'limited', '√', fonts);
    const bad = s.texts.filter((t) => t.text.includes('√') && t.font !== fonts.symbol && t.text !== '√');
    expect(bad).toEqual([]);
    expect(s.texts.filter((t) => t.text === '√').every((t) => t.font === fonts.symbol)).toBe(true);
    expect(s.texts.some((t) => t.text === '√')).toBe(true);
  });

  it('never breaks a line at a no-break space', () => {
    const token = '2 067,4 m';
    for (let n = 0; n < 40; n++) {
      fresh();
      paragraph(cursor, `${'palabra '.repeat(n)}${token} fin`, fonts);
      const lines = new Map<number, string>();
      for (const t of s.texts.filter((x) => !x.rotated && x.size === 11)) {
        lines.set(t.y, (lines.get(t.y) ?? '') + t.text);
      }
      expect([...lines.values()].some((l) => l.includes(token)), `n=${n}`).toBe(true);
    }
  });

  it('draws the spine, heading, KPI row and callout on a new page', () => {
    fresh();
    let c = heading(cursor, 'Cuenca 1', 'Resumen', 'Una frase de contexto.', fonts);
    c = kpiRow(c, [
      { value: '4,82 ha', label: 'Área', detail: '± 0,06' },
      { value: '412 m', label: 'Cauce', detail: 'pendiente 3,1 %' },
    ], fonts);
    c = callout(c, 'Revisar en sitio.', 'warn', fonts);
    expect(c.y).toBeLessThan(cursor.y);
    expect(s.texts.some((t) => t.rotated)).toBe(true);
    expect(s.texts.some((t) => t.text === 'Pie de página')).toBe(true);
  });

  it('wraps a long table cell inside its column and grows the row', () => {
    fresh();
    const cols = [
      { title: 'Nota', align: 'left' as const, width: 90 },
      { title: 'Valor', align: 'right' as const, width: 60 },
    ];
    const out = table(cursor, cols, [['Una descripción larga que no cabe en una sola línea', '1']], fonts);
    const cells = s.texts.filter((t) => t.x < cursor.left + 90 && t.size === 10.6);
    expect(new Set(cells.map((t) => t.y)).size).toBeGreaterThan(2);
    for (const t of cells) expect(t.x + t.font.widthOfTextAtSize(t.text, t.size)).toBeLessThanOrEqual(cursor.left + 90 + 0.01);
    expect(cursor.y - out.y).toBeGreaterThan(40);
  });

  it('paginates table rows and repeats the header', () => {
    fresh();
    const cols = [{ title: 'Cuenca', align: 'left' as const, width: 200 }, { title: 'Área', align: 'right' as const, width: 80 }];
    const rows = Array.from({ length: 120 }, (_, i) => [`Fila ${i}`, `${i},5`]);
    const before = doc.getPageCount();
    table(cursor, cols, rows, fonts);
    const added = doc.getPageCount() - before;
    expect(added).toBeGreaterThanOrEqual(2);
    expect(s.texts.filter((t) => t.text === 'CUENCA').length).toBe(added + 1);
    for (const t of s.texts.filter((x) => !x.rotated && x.size === 11)) expect(t.y).toBeGreaterThanOrEqual(cursor.bottom);
  });

  it('throws on a column-count mismatch and on columns wider than the text area', () => {
    fresh();
    const cols = [{ title: 'A', align: 'left' as const, width: 100 }, { title: 'B', align: 'right' as const, width: 50 }];
    expect(() => table(cursor, cols, [['solo']], fonts)).toThrow(/cells/);
    expect(() => table(cursor, [{ title: 'A', align: 'left', width: 900 }], [['x']], fonts)).toThrow(/wider/);
  });

  it('fails on the first helper call when the cursor has no page context', () => {
    fresh();
    const bare = { ...cursor, ctx: undefined } as unknown as PageCursor;
    expect(() => paragraph(bare, 'x', fonts)).toThrow(/context/);
    expect(() => callout(bare, 'x', 'info', fonts)).toThrow(/context/);
  });

  it('wraps KPI value, label and detail inside the cell width', () => {
    fresh();
    const long = 'Detalle muy largo que necesita varias líneas dentro de la celda';
    kpiRow(cursor, [{ value: '1 234 567,89 m³ acumulados', label: 'Etiqueta muy larga de la celda', detail: long }], fonts);
    const cellW = (cursor.right - cursor.left - 14 * 3) / 4;
    const kpi = s.texts.filter((t) => !t.rotated && t.size !== 11 && t.y > cursor.bottom + 100 && t.x < cursor.left + cellW + 1 && (t.size === 16 || t.size === 11.25 || t.size === 10.5) && t.y > 400);
    expect(kpi.length).toBeGreaterThan(3);
    for (const t of kpi) expect(t.x + t.font.widthOfTextAtSize(t.text, t.size)).toBeLessThanOrEqual(cursor.left + cellW + 0.01);
    expect(new Set(kpi.filter((t) => t.size === 11.25).map((t) => t.y)).size).toBeGreaterThan(1);
  });

  it('spans a tall warn callout over two pages with a thin left rule on both, no fill and no gap after it', () => {
    fresh();
    const rectsBefore = s.rects.length;
    const before = doc.getPageCount();
    const out = callout(cursor, 'Revisar en sitio la depresión del cauce. '.repeat(300), 'warn', fonts);
    expect(doc.getPageCount()).toBeGreaterThan(before);
    const drawn = s.rects.slice(rectsBefore) as { color: unknown }[];
    // Thin ink rules; the wide ink rectangles are the page spines.
    const bars = (drawn as { color: unknown; width?: number }[]).filter((r) => JSON.stringify(r.color) === JSON.stringify(PALETTE.ink) && (r.width ?? 0) <= 1.5);
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(drawn.filter((r) => JSON.stringify(r.color) !== JSON.stringify(PALETTE.ink) && JSON.stringify(r.color) !== JSON.stringify(PALETTE.paper))).toHaveLength(0);
    const lastLine = Math.min(...s.texts.filter((t) => !t.rotated && t.size === 10.5).map((t) => t.y));
    expect(out.y).toBeGreaterThanOrEqual(out.bottom - 1);
    expect(lastLine - out.y).toBeLessThan(20);
  });

  it('numbers continuation pages uniquely', () => {
    fresh();
    paragraph(cursor, SPANISH.repeat(60), fonts);
    const nums = s.texts.filter((t) => t.size === 12.6 && t.x < 34).map((t) => t.text);
    expect(nums.length).toBeGreaterThanOrEqual(3);
    expect(new Set(nums).size).toBe(nums.length);
  });

  it('truncates a long spine section with an ellipsis', () => {
    fresh();
    s.texts.length = 0;
    newPage(doc, 'letter', { id: '01', section: 'Sección '.repeat(40), pageNo: 1 }, fonts, 'f');
    const rot = s.texts.filter((t) => t.rotated);
    expect(rot.at(-1)!.text).toBe('.');
    expect(Math.max(...rot.map((t) => t.y))).toBeLessThan(792 - 60);
  });

  it('gives every verdict chip text at least 4.5:1 contrast', () => {
    const lum = (c: { red: number; green: number; blue: number }) => {
      const f = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(c.red) + 0.7152 * f(c.green) + 0.0722 * f(c.blue);
    };
    fresh();
    for (const v of ['supported', 'limited', 'not-supported'] as const) {
      s.rects.length = 0;
      s.texts.length = 0;
      chip(cursor.page, 100, 300, v, 'x', fonts);
      const bg = lum(s.rects[0]!.color as never);
      const fgColor = s.texts.find((t) => t.text === 'x')!.color;
      const fg = lum(fgColor);
      const best = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      expect(best).toBeGreaterThanOrEqual(4.5);
    }
  });
});
