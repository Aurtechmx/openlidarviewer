/**
 * watershedReportPdf.test.ts: the page sequence of the watershed study, its
 * determinism, its wording in both languages and how it prints withheld
 * figures.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFPage } from 'pdf-lib';
import {
  buildWatershedReportPdf,
  renderWatershedReport,
  watershedReportFilename,
  type ReportPageTag,
} from '../src/export/watershedReport/watershedReportPdf';
import { CATALOG, formatArea, t, type StringKey } from '../src/simulation/flowPulse/watershed/watershedStrings';
import { formatPercent, withheldText } from '../src/simulation/flowPulse/watershed/watershedNarrative';
import type { CatchmentSection, ReportLanguage, WatershedReportModel } from '../src/simulation/flowPulse/watershed/watershedReportModel';
import { buildValley, type Valley } from './support/watershedValley';
import { embedReportFonts } from '../src/export/watershedReport/reportFonts';
import { PALETTE, drawRuns } from '../src/export/watershedReport/pageKit';
import { encodeStoredPng } from './support/storedPng';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'watershedReport', 'fonts');
const loadFont = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));

const valleys: Partial<Record<ReportLanguage, Valley>> = {};
beforeAll(() => {
  valleys.en = buildValley({ language: 'en' });
  valleys.es = buildValley({ language: 'es', crsName: 'WGS 84 / UTM zone 14N' });
});

function opts(v: Valley) {
  return {
    size: 'letter' as const,
    encodePng: encodeStoredPng,
    loadFont,
    raster: { grid: v.result.grid, coverage: v.dtm.coverage, filled: v.result.filled },
  };
}

/** Renders the report and records every string drawn on the pages it keeps, in order. */
async function drawnTexts(model: WatershedReportModel, v: Valley): Promise<string[]> {
  const drawn: { text: string; page: PDFPage }[] = [];
  const removed = new Set<PDFPage>();
  const orig = PDFPage.prototype.drawText;
  const spy = vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, o?: object) {
    drawn.push({ text, page: this });
    return orig.call(this, text, o as never);
  });
  // A part that overflows is drawn again with a smaller map; ignore the pages it discards.
  const origRemove = PDFDocument.prototype.removePage;
  const spyRemove = vi.spyOn(PDFDocument.prototype, 'removePage').mockImplementation(function (this: PDFDocument, i: number) {
    removed.add(this.getPage(i));
    return origRemove.call(this, i);
  });
  try {
    await buildWatershedReportPdf(model, opts(v));
  } finally {
    spy.mockRestore();
    spyRemove.mockRestore();
  }
  return drawn.filter((d) => !removed.has(d.page)).map((d) => d.text);
}

const joined = (texts: readonly string[]) => texts.join(' ').replace(/\s+/g, ' ');

afterEach(() => { vi.restoreAllMocks(); });

describe('buildWatershedReportPdf', () => {
  it('is byte-identical for the same model and date', async () => {
    const v = valleys.en!;
    const a = await buildWatershedReportPdf(v.model, opts(v));
    const b = await buildWatershedReportPdf(v.model, opts(v));
    expect(a.length).toBeGreaterThan(10_000);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  }, 60_000);

  it('has one page each for the cover, the guide with the site map, quality and the appendix, and two per catchment', async () => {
    const v = valleys.en!;
    expect(v.model.sections).toHaveLength(2);
    const { bytes, pages } = await renderWatershedReport(v.model, opts(v));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(pages.length);
    const expected: ReportPageTag[] = [
      { part: 'cover', label: null }, { part: 'guide', label: null },
      ...v.model.sections.flatMap((s) => (['summary', 'details'] as const).map((part) => ({ part, label: s.label }))),
      { part: 'quality', label: null }, { part: 'appendix', label: null },
    ];
    expect(pages).toEqual(expected);
    expect(pages).toHaveLength(8);
  }, 60_000);

  it('sets the document metadata from the model', async () => {
    const v = valleys.es!;
    const doc = await PDFDocument.load(await buildWatershedReportPdf(v.model, opts(v)), { updateMetadata: false });
    expect(doc.getTitle()).toBe(v.model.title);
    expect(doc.getAuthor()).toBe('OpenLiDARViewer');
    expect(doc.getCreationDate()?.toISOString()).toBe(v.model.provenance.generatedAt.toISOString());
    expect(doc.getModificationDate()?.toISOString()).toBe(v.model.provenance.generatedAt.toISOString());
    const lang = doc.catalog.get(doc.context.obj('Lang') as never);
    expect(String(lang)).toContain('es-MX');
  }, 60_000);

  it('never contains survey-grade, certified or design-flow wording in either language', async () => {
    const forbidden = /survey[- ]grade|certif|design flow|design discharge|validated|grado topogr|certificad|caudal de diseño|gasto de diseño|validad/i;
    for (const lang of ['en', 'es'] as const) {
      const v = valleys[lang]!;
      const all = joined(await drawnTexts(v.model, v));
      expect(all.length).toBeGreaterThan(5_000);
      expect(all).not.toMatch(forbidden);
      expect(all).not.toContain('—');
    }
  }, 120_000);

  it('a Spanish report draws no English catalog string', async () => {
    const v = valleys.es!;
    const all = joined(await drawnTexts(v.model, v));
    const keys = Object.keys(CATALOG.en) as StringKey[];
    const english = keys
      .map((k) => CATALOG.en[k])
      .filter((s, i) => s !== CATALOG.es[keys[i]!] && !/\{/.test(s) && s.length >= 8);
    for (const s of english) expect(all, s).not.toContain(s);
    // Page furniture is translated too.
    // The spine draws its section label one character at a time.
    expect(all.replace(/ /g, '')).toContain(t('es', 'spine.summary').toUpperCase().replace(/ /g, ''));
    expect(all).toContain(t('es', 'footer.report', { title: v.model.title }).split(' ')[0]!);
  }, 60_000);

  it('prints withheld reasons, or a dash explained by the open-catchment note, never a bare dash', async () => {
    const v = valleys.en!;
    const s = v.model.sections[0]!;
    const open = { withheld: 'open-catchment' as const };
    type Mutable = Record<string, unknown>;
    const openSection = {
      ...s,
      morph: { ...(s.morph as unknown as Mutable), gravelius: open, elongation: open, circularity: open, formFactor: open, hypsometry: open },
      channel: { ...(s.channel as unknown as Mutable), slope1085: open, slopeTaylorSchwarz: open, reachSlopes: [] },
      quality: { ...s.quality, complete: false, verdict: 'limited', reasons: ['catchment-open'] },
    } as unknown as CatchmentSection;
    const model = { ...v.model, sections: [openSection] } as WatershedReportModel;
    const texts = await drawnTexts(model, v);
    const all = joined(texts);
    // KPIs that cannot be derived for an open catchment show a dash, and the footnote under the row says why.
    expect(all).toContain(t('en', 'summary.kpi.openNote').replace(/\s+/g, ' '));
    expect(all).toContain(t('en', 'figures.openNote'));
    const dashes = texts.filter((x) => ['-', '–', '—', '−'].includes(x.trim()));
    expect(dashes.length).toBeGreaterThan(0);
    expect(dashes.length).toBeLessThanOrEqual(4);
  }, 60_000);

  it('a Spanish report uses decimal commas on its KPIs', async () => {
    const v = valleys.es!;
    const texts = await drawnTexts(v.model, v);
    const a = v.model.sections[0]!.morph.areaM2;
    if (!('value' in a)) throw new Error('fixture area withheld');
    const area = formatArea('es', a.value);
    expect(area).toMatch(/\d,\d\d ha$/);
    // A Not supported catchment marks each figure with "~".
    const mark = v.model.sections[0]!.quality.verdict === 'not-supported' ? '~\u00a0' : '';
    expect(texts).toContain(`${mark}${area}`);
    const en = await drawnTexts(valleys.en!.model, valleys.en!);
    expect(en).toContain(`${mark}${formatArea('en', a.value)}`);
  }, 60_000);

  it('marks every printed figure of a Not supported catchment and explains the mark', async () => {
    const v = valleys.en!;
    const s = v.model.sections.find((x) => x.quality.verdict === 'not-supported');
    if (!s) throw new Error('fixture has no Not supported catchment');
    const all = joined(await drawnTexts(v.model, v)).replace(/\u00a0/g, ' ');
    expect(all).toContain('Values marked ~ belong to a catchment the data do not support.');
    const a = s.morph.areaM2;
    if (!('value' in a)) throw new Error('fixture area withheld');
    expect(all).toContain(`~ ${formatArea('en', a.value).replace(/\u00a0/g, ' ')}`);
    const supported = v.model.sections.find((x) => x.quality.verdict === 'supported');
    if (supported && 'value' in supported.morph.areaM2) expect(all).not.toContain(`~ ${formatArea('en', supported.morph.areaM2.value).replace(/\u00a0/g, ' ')}`);
  }, 60_000);

  it('counts unlisted hollows by the depth criterion and labels the rank as the site rank', async () => {
    const v = valleys.en!;
    const all = joined(await drawnTexts(v.model, v)).replace(/\u00a0/g, ' ');
    expect(all).not.toMatch(/plus \d+ smaller/);
    expect(all).toMatch(/SITE RANK|Site rank/);
    const s = v.model.sections[0]!;
    const shallow = s.depressions.filter((d) => d.maxFillDepth !== null && d.maxFillDepth < 0.1).length;
    const deep = s.depressions.length - shallow;
    if (deep > 0 && shallow > 0) expect(all).toContain(`plus ${shallow} shallower than 0.1 m`);
  }, 60_000);
});

describe('open catchments and withheld densities', () => {
  for (const lang of ['en', 'es'] as const) {
    it(`prints bounds and withheld reasons for an open catchment (${lang})`, async () => {
      const v = buildValley({ language: lang, withOpen: true });
      const c3 = v.model.sections.find((x) => x.label === 'C3')!;
      expect(c3.quality.complete).toBe(false);
      expect(c3.edgeInflowShare).toBeGreaterThan(0);
      const { pages } = await renderWatershedReport(v.model, opts(v));
      expect(pages.filter((p) => p.label === 'C3').map((p) => p.part)).toEqual(['summary', 'details']);
      const texts = await drawnTexts(v.model, v);
      const all = joined(texts);
      const a = c3.morph.areaM2;
      if (!('value' in a)) throw new Error('fixture area withheld');
      expect(a.bound).toBe('minimum');
      expect(all).toContain(`≥ ${formatArea(lang, a.value)}`.replace(/\s+/g, ' '));
      // Shape ratios, slopes and hypsometry are withheld; the report says so once per page, not per figure.
      for (const g of [c3.morph.gravelius, c3.morph.meanSlopePct, c3.morph.hypsometry, c3.channel.slope1085]) expect('withheld' in g).toBe(true);
      expect(all).not.toContain(withheldText(lang, 'open-catchment'));
      const once = (needle: string) => all.split(needle.replace(/\s+/g, ' ')).length - 1;
      expect(once(t(lang, 'figures.openNote'))).toBe(1);
      expect(once(t(lang, 'summary.kpi.openNote'))).toBe(1);
      // The edge share appears under the headline and on the quality page.
      expect(once(t(lang, 'summary.edgeShare', { share: formatPercent(lang, c3.edgeInflowShare, 0) }))).toBe(2);
    }, 120_000);
  }

  it('withholds the point density with a reason when no ground-return counts were recorded', async () => {
    const v = valleys.en!;
    expect(v.model.sections[0]!.quality.groundPointsPerM2).toBeGreaterThan(0);
    const all = joined(await drawnTexts(v.model, v));
    expect(all).not.toContain(t('en', 'quality.noCounts'));
    const s = v.model.sections[0]!;
    const zero = { ...v.model, sections: [{ ...s, quality: { ...s.quality, groundPointsPerM2: 0 } }] } as WatershedReportModel;
    expect(joined(await drawnTexts(zero, v))).toContain(t('en', 'quality.noCounts'));
  }, 60_000);

  it('states no time of concentration, peak flow or travel time in either language', async () => {
    for (const lang of ['en', 'es'] as const) {
      const v = valleys[lang]!;
      const all = joined(await drawnTexts(v.model, v));
      expect(all).not.toMatch(/Kirpich|Témez|rational method|método racional|m³\/s|minut/i);
      expect(all).toContain(t(lang, 'limits.notComputed').replace(/\s+/g, ' '));
    }
  }, 120_000);

  it('draws an exponent smaller and raised', async () => {
    const doc = await PDFDocument.create();
    const fonts = await embedReportFonts(doc, loadFont);
    const page = doc.addPage();
    const calls: { text: string; size: number; y: number }[] = [];
    const orig = page.drawText.bind(page);
    page.drawText = ((text: string, o: { size: number; y: number }) => { calls.push({ text, size: o.size, y: o.y }); return orig(text, o as never); }) as typeof page.drawText;
    drawRuns(page, 'L^{0.77}', 10, 100, { font: fonts.body, size: 10, color: PALETTE.ink }, fonts);
    expect(calls.map((c) => c.text)).toEqual(['L', '0.77']);
    expect(calls[1]!.size).toBeLessThan(calls[0]!.size);
    expect(calls[1]!.y).toBeGreaterThan(calls[0]!.y);
  });
});

describe('editable export options', () => {
  it('prints notes, the preparer and checker, and catchment names; keeps the label as the key', async () => {
    const v = valleys.en!;
    const texts: string[] = [];
    const orig = PDFPage.prototype.drawText;
    const spy = vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, o?: { y?: number }) {
      texts.push(text);
      expect(o?.y ?? 0).toBeGreaterThanOrEqual(0);
      return orig.call(this, text, o as never);
    });
    try {
      await buildWatershedReportPdf(v.model, {
        ...opts(v),
        projectNotes: 'Drainage review ahead of a fence line. '.repeat(30),
        preparedBy: 'A. Surveyor',
        checkedBy: 'B. Reviewer',
        catchmentNames: { C1: 'Lower valley' },
      });
    } finally {
      spy.mockRestore();
    }
    const all = joined(texts);
    expect(all).toContain('A. Surveyor');
    expect(all).toContain('B. Reviewer');
    expect(all).toContain('C1 · Lower valley');
    expect(all).toContain('Drainage review ahead of a fence line.');
    // The note is clamped to 400 characters on the cover.
    expect(all.split('Drainage review').length - 1).toBeLessThanOrEqual(11);
  }, 60_000);

  for (const size of ['letter', 'a4'] as const) {
    it(`keeps the 2-catchment report to 8 pages on ${size}`, async () => {
      const v = valleys.en!;
      const { pages } = await renderWatershedReport(v.model, { ...opts(v), size });
      expect(pages).toHaveLength(8);
    }, 60_000);
  }
});

describe('watershedReportFilename', () => {
  it('names the file by base and language', () => {
    expect(watershedReportFilename('site', 'en')).toBe('site-watershed-report-en.pdf');
    expect(watershedReportFilename('site', 'es')).toBe('site-watershed-report-es.pdf');
  });
});
