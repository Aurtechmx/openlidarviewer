/**
 * watershedReportFonts.test.ts: the report embeds Newsreader and Figtree as
 * four subset TrueType fonts and can draw Spanish text with them.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { embedReportFonts, REPORT_FONT_FILES, SYMBOL_ONLY_CHARS } from '../src/export/watershedReport/reportFonts';
import { CATALOG } from '../src/simulation/flowPulse/watershed/watershedStrings';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'watershedReport', 'fonts');
const fromDisk = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));

const SPANISH = 'Tiempo de concentración, cañada, ≥ 4,8 ha, 2 067,4 m³';

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Every character the report prints, other than ASCII. */
const REPORT_CHARS = 'áéíóúñÑüÜÁÉÍÓÚ¿¡≥≤±×³²°·–—\u00A0';

describe('glyph coverage', () => {
  for (const file of REPORT_FONT_FILES) {
    it(`${file} has a glyph for every report character`, async () => {
      const font = fontkit.create(Buffer.from(await fromDisk(file)));
      const missing = [...REPORT_CHARS].filter((c) => !font.hasGlyphForCodePoint(c.codePointAt(0)!));
      expect(missing.map((c) => 'U+' + c.codePointAt(0)!.toString(16))).toEqual([]);
    });
  }

  it('the only characters missing from a family are the documented symbol-only ones, which the Symbol font draws', async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedReportFonts(doc, fromDisk);
    expect(SYMBOL_ONLY_CHARS).toEqual(['\u221A', '\u03C0', '\u03A3']);
    for (const file of REPORT_FONT_FILES) {
      const font = fontkit.create(Buffer.from(await fromDisk(file)));
      for (const c of SYMBOL_ONLY_CHARS) expect(font.hasGlyphForCodePoint(c.codePointAt(0)!)).toBe(false);
    }
    for (const c of SYMBOL_ONLY_CHARS) expect(() => doc.addPage().drawText(c, { x: 10, y: 10, size: 10, font: fonts.symbol })).not.toThrow();
  });

  it('the body family or the Symbol font can draw every character of the watershed catalog', async () => {
    const chars = new Set<string>();
    for (const lang of ['en', 'es'] as const) for (const s of Object.values(CATALOG[lang])) for (const c of s) chars.add(c);
    for (const file of REPORT_FONT_FILES.filter((f) => f.startsWith('figtree/'))) {
      const font = fontkit.create(Buffer.from(await fromDisk(file)));
      const missing = [...chars].filter((c) => !SYMBOL_ONLY_CHARS.includes(c) && !font.hasGlyphForCodePoint(c.codePointAt(0)!));
      expect(missing.map((c) => `${c} U+${c.codePointAt(0)!.toString(16)}`), file).toEqual([]);
    }
  });
});

describe('embedReportFonts', () => {
  it('embeds all four fonts subset and renders Spanish glyphs', async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedReportFonts(doc, fromDisk);
    const page = doc.addPage([400, 300]);
    let y = 260;
    for (const f of [fonts.title, fonts.titleBold, fonts.body, fonts.bodyBold]) {
      expect(() => page.drawText(SPANISH, { x: 20, y, size: 10, font: f })).not.toThrow();
      expect(f.widthOfTextAtSize(SPANISH, 10)).toBeGreaterThan(50);
      y -= 20;
    }
    const bytes = await doc.save({ useObjectStreams: false });
    const text = Buffer.from(bytes).toString('latin1');
    expect(count(text, '/FontFile2')).toBe(4);
    for (const n of ['Newsreader-Regular', 'Newsreader-Bold', 'Figtree-Regular', 'Figtree-Bold']) {
      expect(text).toContain(`/BaseFont /${n}`);
    }
    // Subsetting keeps the file far below the four whole fonts (about 320 kB).
    expect(bytes.length).toBeLessThan(120_000);
  });

  it('saves byte-identical output for identical input', async () => {
    const build = async (): Promise<Uint8Array> => {
      const doc = await PDFDocument.create();
      doc.setCreationDate(new Date(0));
      doc.setModificationDate(new Date(0));
      const fonts = await embedReportFonts(doc, fromDisk);
      doc.addPage().drawText(SPANISH, { x: 20, y: 700, size: 10, font: fonts.body });
      return doc.save();
    };
    expect(Buffer.from(await build()).equals(Buffer.from(await build()))).toBe(true);
  });

  it('asks the loader for exactly the four listed files', async () => {
    const asked: string[] = [];
    const doc = await PDFDocument.create();
    await embedReportFonts(doc, async (name) => {
      asked.push(name);
      return fromDisk(name);
    });
    expect(asked.sort()).toEqual([...REPORT_FONT_FILES].sort());
  });
});
