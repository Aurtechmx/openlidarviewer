/**
 * terrainReportLanguages.test.ts: the terrain intelligence report and the
 * Contour Studio PDF in every export language and number style. Every state
 * they can print is drawn; a sentence with no translation, an English word
 * left on a page, a lost character, a split word or a text off the page or
 * over its neighbour column fails. The modules whose sentences the report
 * prints are read, and each of their sentences needs a row.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseAst } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument, PDFName, PDFPage } from 'pdf-lib';
import { buildTerrainReportPdf } from '../src/render/measure/terrainReportPdf';
import { buildContourStudioPdf } from '../src/terrain/export/contourStudioPdf';
import { buildContourPdfModel } from '../src/terrain/contourStudio/contourDeliverablePdfModel';
import { buildTerrainReportContent, type TerrainReportContent } from '../src/terrain/export/terrainReportContent';
import { localizeTerrainReport } from '../src/terrain/export/localizeTerrainReport';
import { reportWords } from '../src/terrain/export/reportWords';
import { METRIC_TOOLTIPS, blockedTreatmentContrast } from '../src/terrain/contour/contourCopy';
import { analysedBasisLine, type AnalysedBasis } from '../src/terrain/export/analysedBasis';
import { EVIDENCE_GATE_NOTE } from '../src/terrain/export/exportProvenance';
import { EVIDENCE_LEVELS, evidenceLabel } from '../src/validation/evidenceLevel';
import { dtmCellsEvidenceText } from '../src/validation/scopedEvidence';
import { tpiClassLabel, SLOPE_ASPECT_CONVENTION_NOTE } from '../src/terrain/complexity/complexitySummary';
import { TPI_CLASS, type TpiClassName } from '../src/terrain/complexity/terrainPositionIndex';
import { complexityLabel, densityLabel, groundVisibilityLabel } from '../src/terrain/datasetIntelligence';
import { CONTOUR_SHAPE_STYLES } from '../src/terrain/contour/contourShapeStyle';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { buildContourDeliverableFromResultAsync } from '../src/terrain/export/contourDeliverableBuild';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import { checkGridBudget } from '../src/terrain/quality/gridBudget';
import type { CrsSource } from '../src/geo/CoordinateTypes';
import type { InterpretationLevel } from '../src/io/probe/formatProbes';
import * as DIGEST_NOTES from '../src/science/exportDigestRecord';
import { TERRAIN_REPORT_TEXT, type TerrainReportKey } from '../src/i18n/deliverables/terrainReport';
import { EXPORT_LANGUAGES, languageInfo } from '../src/i18n/languages';
import { templateParams } from '../src/i18n/message';
import type { ExportLocale } from '../src/i18n/exportLocale';
import type { NumberStyle } from '../src/i18n/numberStyle';
import { winAnsiSafe } from '../src/winAnsiText';
import { REPORT_OPTS, REPORT_STATES, STUDIO_STATES, terrainState } from './helpers/terrainReportStates';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const FOREIGN = EXPORT_LANGUAGES.map((l) => l.id).filter((l) => l !== 'en');
const LOCALES: ExportLocale[] = FOREIGN.flatMap((lang) => (['point', 'comma'] as NumberStyle[]).map((numberStyle) => ({ lang, numberStyle })));
const KEYS = Object.keys(TERRAIN_REPORT_TEXT) as TerrainReportKey[];
const content = (name: string): TerrainReportContent => {
  const { r, o } = REPORT_STATES[name]!;
  return buildTerrainReportContent(r, { ...REPORT_OPTS, ...o });
};
const allText = (c: TerrainReportContent): string[] => [
  c.title, c.subtitle, ...c.sections.flatMap((s) => [s.title, ...s.rows.flatMap((r) => [r.label, r.value])]),
  ...c.warnings, ...c.howToImprove, ...c.provenanceLines, c.notSurveyGrade, ...c.definitions,
];
afterEach(() => { vi.restoreAllMocks(); });

/** English words that no row in another language uses. */
const ENGLISH = /(?<!\p{L})(the|and|with|from|which|returns|ground|grid|cells?|not|only|was|were|is|are|of|unknown|height|quality|readiness|preview|blocked|available|good|ready|generated|coverage|sampled|measured|interpolated|evidence|level|warnings|none|yes|unit|vertical datum|language)(?!\p{L})/iu;
/** Copied on purpose, or the same word in that language. */
const copied = (t: string): string => t
  .replace(/OpenLiDARViewer \S+|olv\.\S+|WGS 84 \/ UTM zone 10N|My grid|trustGroundClassification|Git commit|site-42|EGM2008 height|E\d_[A-Z_]+/g, '')
  .replace(/\b(Software|Scan|Scans|Contour Studio|Datum|Verdict|Index|Build|Manifest|Note|Source|sources?|Interpretation|RMSE\w*|Median|Radius|Smart|Motif|vertical|horizontal)\b/g, '');

describe('the catalog', () => {
  it.each(KEYS)('%s: the same parameters and figures in every language, none empty, no character lost', (key) => {
    const row = TERRAIN_REPORT_TEXT[key];
    const digits = (s: string): string[] => (s.replace(/\{\w+\}/g, '').match(/\d+(?:\.\d+)?/g) ?? []).sort();
    row.forEach((text, i) => {
      if (key === 'X_languageFallback' && i > 0) return;
      expect(text.trim()).not.toBe('');
      expect(templateParams(text)).toEqual(templateParams(row[0]));
      expect(digits(text)).toEqual(digits(row[0]));
      expect(winAnsiSafe(text)).not.toContain('?');
    });
  });

  it('a negated or withheld claim stays negated', () => {
    const negative = /\b(not|never|neither|none|no|unavailable|unknown|unregistered)\b/i;
    const said: Record<string, RegExp> = {
      es: /\b(no|sin|ni|ningun[oa]?|ningún|nunca|desconocid[oa]s?|antes|fuera)\b/i,
      pt: /\b(não|sem|nem|nenhum[a]?|nunca|desconhecid[oa]s?|indisponível|fora)\b|inválid/i,
      fr: /\b(pas|non|ni|sans|aucune?|jamais|inconnue?s?|indisponible|hors)\b|n'/i,
      de: /\b(nicht|kein\w*|ohne|unbekannte?r?|nie\w*|weder|außer\w*|un\w+|sofern)\b/i,
    };
    let checked = 0;
    for (const key of KEYS) {
      const row = TERRAIN_REPORT_TEXT[key];
      if (!negative.test(row[0]) || ['no', 'tcNone'].includes(key) || key.startsWith('X_')) continue;
      checked++;
      FOREIGN.forEach((lang) => {
        const text = row[EXPORT_LANGUAGES.findIndex((l) => l.id === lang)]!;
        expect(said[lang]!.test(text), `${lang}.${key}: ${text}`).toBe(true);
      });
    }
    expect(checked).toBeGreaterThan(40);
  });
});

describe('every state of the terrain report', () => {
  it('in English with point decimals is the content as built', () => {
    for (const name of Object.keys(REPORT_STATES)) {
      const c = content(name);
      expect(localizeTerrainReport(c).content).toBe(c);
    }
  });

  it.each(Object.keys(REPORT_STATES))('%s has every sentence in every language and number style', (name) => {
    const c = content(name);
    const english = allText(c);
    for (const locale of [...LOCALES, { lang: 'en', numberStyle: 'comma' } as ExportLocale]) {
      const { content: t, missed, words } = localizeTerrainReport(c, locale);
      expect(missed).toBeNull();
      expect(words.locale).toEqual(locale);
      const out = allText(t);
      if (locale.lang === 'en') {
        // English text with only its figures rewritten.
        const bare = (s: string): string => s.replace(/[\d., ]/g, '');
        expect(out.map(bare)).toEqual(english.map(bare));
        continue;
      }
      for (const s of out) {
        if (c.provenance.source !== null && s === c.title) continue;
        expect(copied(s), s).not.toMatch(ENGLISH);
      }
      // The same figures, in whatever order the sentence puts them.
      if (locale.numberStyle === 'point') {
        const figures = (list: readonly string[]): string[] => list.join(' ').match(/\d+(?:[.,]\d+)*/g)!.sort();
        expect(figures(t.provenanceLines.slice(0, c.provenanceLines.length))).toEqual(figures(c.provenanceLines));
        expect(figures(t.sections.flatMap((x) => x.rows.map((r) => r.value)))).toEqual(figures(c.sections.flatMap((x) => x.rows.map((r) => r.value))));
      }
    }
  });

  it('writes comma figures, and leaves versions, codes, times and DOIs alone', () => {
    const { content: t } = localizeTerrainReport(buildTerrainReportContent(terrainState({
      complexity: undefined, warnings: ['point density 1.5 pts/m² is below the ≥4 pts/m² reliability threshold reported for detailed terrain/vegetation complexity (Münzinger et al. 2022, doi:10.1016/j.ufug.2022.127637); treat complexity as indicative'],
    }), REPORT_OPTS), { lang: 'fr', numberStyle: 'comma' });
    const all = allText(t).join('\n');
    expect(all).toContain('0,14 m');
    expect(all).toContain('1 200 000');
    expect(all).toContain('1,5 pts/m²');
    expect(all).toContain('1,96 × RMSEz');
    expect(all).toContain('doi:10.1016/j.ufug.2022.127637');
    expect(all).toContain('OpenLiDARViewer 9.9.9');
    expect(all).toContain('v0.4.1');
    expect(all).toContain('2026-06-05T00:00:00.000Z');
  });

  it('says an unrecorded software version in the language', () => {
    const { content: t } = localizeTerrainReport(buildTerrainReportContent(terrainState(), { ...REPORT_OPTS, softwareVersion: null, metricVersion: null }), { lang: 'es', numberStyle: 'point' });
    expect(t.provenanceLines[0]).toMatch(/OpenLiDARViewer desconocido$/);
    expect(t.provenanceLines).toContainEqual(expect.stringMatching(/^Versión de métricas +desconocido$/));
  });

  it('copies names that read like report words', () => {
    const r = terrainState({ dtm: { crs: 'not georeferenced', verticalDatum: 'unknown' } });
    const { content: t, missed } = localizeTerrainReport(buildTerrainReportContent(r, { ...REPORT_OPTS, basename: 'Good' }), { lang: 'de', numberStyle: 'comma' });
    const value = (label: string): string | undefined => t.sections.flatMap((s) => s.rows).find((x) => x.capLabel === label)?.value;
    expect(missed).toBeNull();
    expect(t.title).toBe('Good');
    expect(value('Scan')).toBe('Good');
    expect(value('Horizontal CRS')).toBe('not georeferenced');
    expect(value('Vertical datum')).toBe('unknown');
    expect(t.provenanceLines).toContainEqual(expect.stringMatching(/^Quelle +Good$/));
  });

  it('stays wholly in English, and says so, when one sentence has no translation', async () => {
    const c = buildTerrainReportContent(terrainState({ warnings: ['A new warning nobody translated.'] }), REPORT_OPTS);
    const { content: t, missed, words } = localizeTerrainReport(c, { lang: 'es', numberStyle: 'comma' });
    expect(missed).toBe('A new warning nobody translated.');
    expect(words.plain).toBe(true);
    expect(t.sections).toBe(c.sections);
    expect(t.provenanceLines.at(-1)).toMatch(/^Language +English \(this report has a sentence with no Español \(México\) text\)$/);
    const doc = await PDFDocument.load(await buildTerrainReportPdf(c, undefined, { locale: { lang: 'es', numberStyle: 'comma' } }));
    expect(String(doc.catalog.get(PDFName.of('Lang')))).toContain('en-US');
    // A class scope is written from class names, which have no rows.
    expect(localizeTerrainReport(buildTerrainReportContent(terrainState(), { ...REPORT_OPTS, classScope: 'Ground + Water · 2 of 5 classes' }), { lang: 'fr', numberStyle: 'comma' }).missed).not.toBeNull();
  });
});

interface Drawn { text: string; size: number; x: number; y: number; right: number; page: PDFPage }
async function drawing(build: () => Promise<Uint8Array>): Promise<{ ts: Drawn[]; bytes: Uint8Array }> {
  const ts_: Drawn[] = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { size?: number; x?: number; y?: number; font?: { widthOfTextAtSize(a: string, b: number): number }; rotate?: unknown }) {
    if (!o?.rotate) ts_.push({ text: t, size: o?.size ?? 0, x: o?.x ?? 0, y: o?.y ?? 0, right: (o?.x ?? 0) + (o?.font?.widthOfTextAtSize(t, o.size ?? 0) ?? 0), page: this });
    return orig.call(this, t, o as never);
  });
  const bytes = await build();
  vi.restoreAllMocks();
  return { ts: ts_, bytes };
}
function noOverlap(drawn: readonly Drawn[]): void {
  for (const p of new Set(drawn.map((t) => t.page))) {
    const on = drawn.filter((t) => t.page === p && t.text.trim() !== '');
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
      const a = on[i]!, b = on[j]!;
      const x = Math.min(a.right, b.right) - Math.max(a.x, b.x), y = Math.min(a.y + a.size * 0.7, b.y + b.size * 0.7) - Math.max(a.y, b.y);
      expect(x > 0.5 && y > 0.5, `${a.text} | ${b.text}`).toBe(false);
    }
  }
}
/** Every drawn word is a whole word of the source text, so nothing was cut in two. */
function wholeWords(drawn: readonly Drawn[], source: readonly string[]): void {
  const words = new Set(source.flatMap((s) => winAnsiSafe(s).split(/\s+/)));
  for (const t of drawn) for (const w of t.text.split(/\s+/)) if (w !== '' && w !== '-' && !/^[0-9a-f]{16,}$/.test(w)) expect(words.has(w), `${w} in: ${t.text}`).toBe(true);
}

const LONGEST = ['full', 'limited', 'resident', 'trusted', 'transform', 'geographic', 'scopedOutside', 'noCrs', 'unresolvedZ', 'blockedEmpty', 'gatePreview', 'intelHigh'];
const CHROME: TerrainReportKey[] = ['hWarnings', 'noWarnings', 'hImprove', 'hDefinitions', 'hProvenance', 'continued'];
describe.each(['classic', 'light', 'dark'] as const)('%s pages', (style) => {
  it.each(LOCALES.filter((l) => l.numberStyle === languageInfo(l.lang).numberStyle))('$lang: the terrain report fits, in whole words, with nothing overprinted', async (locale) => {
    for (const name of LONGEST) {
      const { r, o } = REPORT_STATES[name]!;
      const warnings = name === 'full' ? PRODUCED.slice(0, 40) : r.warnings;
      const opts = { ...REPORT_OPTS, ...o };
      const { ts: drawn, bytes } = await drawing(() => buildTerrainReportPdf({ ...r, warnings } as typeof r, opts, { style, loadFont, locale }));
      const t = localizeTerrainReport(buildTerrainReportContent({ ...r, warnings } as typeof r, opts), locale);
      expect(t.missed).toBeNull();
      const w = reportWords(locale);
      wholeWords(drawn, [...allText(t.content), ...CHROME.map((k) => w.say(k))]);
      noOverlap(drawn);
      for (const d of drawn) {
        expect(d.text).not.toContain('?');
        expect(d.x, d.text).toBeGreaterThanOrEqual(47);
        expect(d.right, d.text).toBeLessThanOrEqual(595.28 - 47);
        expect(d.y, d.text).toBeGreaterThanOrEqual(18);
      }
      const doc = await PDFDocument.load(bytes);
      expect(String(doc.catalog.get(PDFName.of('Lang')))).toContain(languageInfo(locale.lang).tag);
      expect(drawn.map((d) => d.text).join(' ')).toContain(winAnsiSafe(languageInfo(locale.lang).name));
    }
  }, 240_000);

  it.each(LOCALES)('$lang $numberStyle: the Contour Studio PDF in every state', async (locale) => {
    for (const [name, state] of Object.entries(STUDIO_STATES)) {
      const model = buildContourPdfModel({ ...state, name: 'site-42' }, locale);
      expect(model.languageTag, name).toBe(languageInfo(locale.lang).tag);
      const { ts: drawn, bytes } = await drawing(() => buildContourStudioPdf(model, { style, loadFont }));
      const source = [...model.titleBlock, model.evidenceBadge, ...model.pages.flatMap((p) => [p.title, ...p.lines])];
      wholeWords(drawn.filter((d) => !/^\d \/ \d$/.test(d.text)), source);
      noOverlap(drawn);
      for (const d of drawn) {
        expect(copied(d.text), d.text).not.toMatch(ENGLISH);
        expect(d.text).not.toContain('?');
        expect(d.right, d.text).toBeLessThanOrEqual(612 - 53);
        expect(d.y, d.text).toBeGreaterThanOrEqual(30);
      }
      const all = drawn.map((d) => d.text).join(' ');
      for (const word of winAnsiSafe(reportWords(locale).draft!).split(' ')) expect(all).toContain(word);
      const doc = await PDFDocument.load(bytes);
      expect(String(doc.catalog.get(PDFName.of('Lang')))).toContain(languageInfo(locale.lang).tag);
      expect(doc.getTitle()).toContain('site-42');
    }
  }, 120_000);
});

describe('the Contour Studio PDF', () => {
  it('prints its watermark inside the page in every language', async () => {
    for (const lang of FOREIGN) {
      const marks: { text: string; x: number; y: number; w: number }[] = [];
      const orig = PDFPage.prototype.drawText;
      vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { x?: number; y?: number; size?: number; font?: { widthOfTextAtSize(a: string, b: number): number }; rotate?: unknown }) {
        if (o?.rotate) marks.push({ text: t, x: o.x!, y: o.y!, w: o.font!.widthOfTextAtSize(t, o.size!) });
        return orig.call(this, t, o as never);
      });
      const model = buildContourPdfModel(STUDIO_STATES.cartographic!, { lang, numberStyle: 'point' });
      await buildContourStudioPdf(model);
      vi.restoreAllMocks();
      expect(marks.length).toBe(model.pages.length);
      for (const m of marks) {
        expect(m.text).not.toBe('EXPLORATORY');
        expect(m.x).toBeGreaterThan(10);
        expect(m.x + m.w * Math.SQRT1_2).toBeLessThan(602);
        expect(m.y + m.w * Math.SQRT1_2).toBeLessThan(782);
      }
    }
  });

  it('copies a CRS and datum, writes comma figures, and stays in English when a text has no translation', () => {
    const base = STUDIO_STATES.cartographic!;
    const es = buildContourPdfModel(base, { lang: 'es', numberStyle: 'comma' }).pages.flatMap((p) => p.lines);
    expect(es).toContain('SRC: EPSG:32610');
    expect(es).toContain('Datum vertical: EGM2008 height');
    expect(es).toContain('Medido: 80,123%');
    expect(es).toContain('RMSE: 0,123 m');
    expect(es).toContain('Cuadrícula: 10x10 @ 1,25 m');
    const odd = buildContourPdfModel({ ...base, validation: { ...base.validation, mode: 'new-mode' } }, { lang: 'es', numberStyle: 'comma' });
    expect(odd.languageTag).toBeUndefined();
    expect(odd.pages.flatMap((p) => p.lines)).toContain('Measured: 80.123%');
    expect(odd.titleBlock.at(-1)).toBe('Language: English (this report has a sentence with no Español (México) text)');
    expect(buildContourPdfModel({ ...base, name: 'a' }).titleBlock[0]).toBe('a - Contour deliverable');
  });
});

describe('real analysis runs', () => {
  const hill = (n: number, gap = false): TerrainPoint[] => {
    const out: TerrainPoint[] = [];
    for (let x = 0; x <= n; x++) for (let y = 0; y <= n; y++) if (!gap || x < n / 3 || x > n / 2) out.push({ x, y, z: 8 * Math.exp(-((x - n / 2) ** 2 + (y - n / 2) ** 2) / 400) });
    return out;
  };
  const classes = (pts: readonly TerrainPoint[], f: (i: number) => number): Uint8Array => Uint8Array.from(pts, (_, i) => f(i));
  const pts = hill(50);
  const runs: Record<string, ReturnType<typeof analyseContours>> = {
    plain: analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' }),
    resident: analyseContours(pts, { cellSizeM: 2, crs: null, residentOnly: true }),
    gap: analyseContours(hill(40, true), { cellSizeM: 1, crs: 'EPSG:32610' }),
    geographic: analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:4326', isGeographic: true }),
    flat: analyseContours(pts.map((p) => ({ ...p, z: 5 })), { cellSizeM: 2, crs: 'EPSG:32610' }),
    thinned: analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', intervalM: 0.01 }),
    sparse: analyseContours(pts.slice(0, 12), { cellSizeM: 1, crs: null }),
    scaled: analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', samplePointScale: 4, classification: classes(pts, (i) => (i % 5 ? 2 : 5)) }),
    refused: analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', classification: classes(pts, () => 1), trustGroundClassification: true }),
  };
  it.each(Object.keys(runs))('%s: the report has every sentence in every language', (name) => {
    for (const o of [{}, { verticalUnitToMetres: null, digests: null }]) {
      const c = buildTerrainReportContent(runs[name]!, { ...REPORT_OPTS, ...o });
      for (const locale of LOCALES) expect(localizeTerrainReport(c, locale).missed).toBeNull();
    }
  });

  it('the deliverable package writes its PDF in the language and keeps its other files in English', async () => {
    const opts = { decision: STUDIO_STATES.cartographic!.decision, basename: 'site-42', softwareVersion: '9.9.9', metricVersion: 'v', generatedAt: new Date('2026-06-05T00:00:00Z'), exportPermit: null };
    const en = Buffer.from(await buildContourDeliverableFromResultAsync(runs.plain!, opts));
    const de = Buffer.from(await buildContourDeliverableFromResultAsync(runs.plain!, { ...opts, locale: { lang: 'de', numberStyle: 'comma' } }));
    const files = (zip: Buffer): Map<string, Buffer> => {
      const out = new Map<string, Buffer>();
      for (let at = 0; zip.readUInt32LE(at) === 0x04034b50;) {
        const size = zip.readUInt32LE(at + 18), name = zip.readUInt16LE(at + 26), start = at + 30 + name + zip.readUInt16LE(at + 28);
        out.set(zip.toString('utf8', at + 30, at + 30 + name), zip.subarray(start, start + size));
        at = start + size;
      }
      return out;
    };
    const a = files(en), b = files(de);
    expect([...b.keys()]).toEqual([...a.keys()]);
    const changed = [...a.keys()].filter((k) => !a.get(k)!.equals(b.get(k)!));
    const pdf = changed.find((k) => k.endsWith('.pdf'))!;
    // The checksum list follows the PDF; nothing else differs.
    expect(changed.filter((k) => k !== pdf && !/SHA256SUMS/.test(k))).toEqual([]);
    expect(a.size).toBeGreaterThan(5);
    const doc = await PDFDocument.load(b.get(pdf)!);
    expect(String(doc.catalog.get(PDFName.of('Lang')))).toContain('de-DE');
    expect(doc.getTitle()).toBe('site-42 - Höhenlinien-Lieferung');
    expect((await PDFDocument.load(a.get(pdf)!)).getTitle()).toBe('site-42 - Contour deliverable');
  }, 60_000);
});

// ── the modules whose sentences the report prints ──────────────────────────

const CAUSES = [
  'was projected to cost 1,234M search steps, above the 60M ceiling', 'reached the 60M search-step ceiling before it finished',
];
const TOP_GAPS = ['', '; the top level is kept as the summit contour, so the highest gap is 3× the requested interval instead of 4×', '; the top level is kept as the summit contour, so the highest gap differs from the others'];
const BUDGET = [checkGridBudget({ cols: 20_000, rows: 1000 }).reason, checkGridBudget({ cols: 5000, rows: 4000, bytesPerCell: 30 }).reason];
const REFUSED = [checkGridBudget({ cols: 0.5, rows: 3 }).reason, checkGridBudget({ cols: 20_000, rows: 20_000 }).reason];
/** What a `${...}` in a pushed sentence can be, where it is not a figure. */
const HOLES: Record<string, readonly string[]> = { cause: CAUSES, topGapNote: TOP_GAPS, 'budget.reason': REFUSED, 'String(params.windowCells)': ['NaN'], 'String(params.radiusCells)': ['NaN'] };
const CONSTANTS: Record<string, string> = {};
for (const f of ['src/terrain/contour/analyseContours.ts', 'src/terrain/ground/cellConfidence.ts']) {
  for (const m of readFileSync(f, 'utf8').matchAll(/export const ([A-Z_]+) =\s*\n\s*'([^'\n]+)';/g)) CONSTANTS[m[1]!] = m[2]!;
}

/** An ESTree node, as far as this reader looks. */
interface Node { type: string; start: number; end: number; [k: string]: unknown }
interface Module { readonly src: string; readonly root: Node }
function moduleOf(file: string): Module {
  const src = readFileSync(file, 'utf8');
  return { src, root: parseAst(src, { lang: 'ts' }) as unknown as Node };
}
function walk(n: unknown, visit: (n: Node, parent: Node | null) => void, parent: Node | null = null): void {
  if (Array.isArray(n)) { for (const c of n) walk(c, visit, parent); return; }
  if (n === null || typeof n !== 'object') return;
  const node = n as Node;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [k, v] of Object.entries(node)) if (k !== 'parent' && typeof v === 'object') walk(v, visit, typeof node.type === 'string' ? node : parent);
}
const code = (n: Node, m: Module): string => m.src.slice(n.start, n.end);

/** Every text an expression can be, with a figure in each hole. */
function texts(e: Node, m: Module): string[] | null {
  if (e.type === 'Literal') return typeof e.value === 'string' ? [e.value] : null;
  if (e.type === 'ParenthesizedExpression') return texts(e.expression as Node, m);
  if (e.type === 'Identifier') return CONSTANTS[e.name as string] ? [CONSTANTS[e.name as string]!] : null;
  if (e.type === 'ConditionalExpression') {
    const a = texts(e.consequent as Node, m), b = texts(e.alternate as Node, m);
    return a && b && [...a, ...b];
  }
  if (e.type === 'BinaryExpression' && e.operator === '+') {
    const a = texts(e.left as Node, m), b = texts(e.right as Node, m);
    return a && b && a.flatMap((x) => b.map((y) => x + y));
  }
  if (e.type === 'TemplateLiteral') {
    const quasis = (e.quasis as { value: { cooked: string } }[]).map((q) => q.value.cooked);
    return (e.expressions as Node[]).reduce<string[]>((acc, x, i) => {
      const at = code(x, m);
      const fills = HOLES[at] ?? [/pct\(|pctStr\(/.test(at) ? '12%' : '12'];
      return acc.flatMap((t) => fills.map((f) => t + f + quasis[i + 1]!));
    }, [quasis[0]!]);
  }
  return null;
}
/** The texts pushed onto the named lists in a module; an expression that is not a sentence is returned as code. */
function pushed(file: string, lists: readonly string[]): { texts: string[]; other: string[] } {
  const m = moduleOf(file);
  const out = { texts: [] as string[], other: [] as string[] };
  walk(m.root, (n) => {
    const callee = n.callee as Node | undefined;
    if (n.type !== 'CallExpression' || callee?.type !== 'MemberExpression' || (callee.property as Node).name !== 'push' || !lists.includes(code(callee.object as Node, m))) return;
    for (const a of n.arguments as Node[]) {
      const t = texts(a, m);
      if (t) out.texts.push(...t); else out.other.push(code(a, m));
    }
  });
  return out;
}
/** Module, the lists it fills, and the pushes that pass on another module's list (checked there) or a value checked below. */
const PRODUCERS: ReadonlyArray<readonly [file: string, lists: readonly string[], passed: readonly string[]]> = [
  ['src/terrain/contour/analyseContours.ts', ['warnings'], ['...gf.warnings', '...gf.warnings', '...dtm.warnings', '...contours.warnings']],
  ['src/terrain/contour/contoursAt.ts', ['warnings'], []],
  ['src/terrain/ground/rasterizeDtm.ts', ['warnings'], ['budget.reason']],
  ['src/terrain/ground/cellConfidence.ts', ['warnings'], []],
  ['src/terrain/ground/groundFilter.ts', ['warnings'], []],
  ['src/terrain/ground/surfaceFromRaster.ts', ['warnings'], []],
  ['src/terrain/complexity/vectorRuggedness.ts', ['warnings'], []],
  ['src/terrain/complexity/terrainPositionIndex.ts', ['warnings'], []],
  ['src/terrain/complexity/complexityEnvelope.ts', ['warnings'], []],
  ['src/terrain/complexity/complexitySummary.ts', ['warnings'], ['w', 'caveat']],
];
const PRODUCED = [...new Set(PRODUCERS.flatMap(([f, l]) => pushed(f, l).texts)), ...BUDGET,
  'point density 12 pts/m² is below the ≥4 pts/m² reliability threshold reported for detailed terrain/vegetation complexity (Münzinger et al. 2022, doi:10.1016/j.ufug.2022.127637); treat complexity as indicative'];

describe('every sentence another module can put in the report has a row', () => {
  const say = LOCALES.map((l) => reportWords(l));
  const check = (text: string): void => {
    for (const w of say) {
      const got = w.translate(text);
      expect(got, `${w.locale.lang}: ${text}`).not.toBeNull();
      if (/[a-z]{4}/i.test(text)) expect(copied(got!), text).not.toMatch(ENGLISH);
    }
  };

  it.each(PRODUCERS)('%s', (file, lists, passed) => {
    const p = pushed(file, lists);
    expect(p.other.sort()).toEqual([...passed].sort());
    p.texts.forEach(check);
  });
  it('finds the sentences it is meant to read', () => { expect(PRODUCED.length).toBeGreaterThan(45); });
  it('grid budget, density caveat and void-fill variants', () => { PRODUCED.forEach(check); });

  it('the quality gate, the verdict and the readiness engine', () => {
    const gate = 'src/terrain/quality/dtmQualityGate.ts';
    pushed(gate, ['reasons']).texts.filter((t) => !t.includes('Preview only')).forEach(check);
    const literals = (file: string): string[] => {
      const m = moduleOf(file);
      const out: string[] = [];
      walk(m.root, (n, parent) => {
        if (parent?.type === 'ImportDeclaration' || parent?.type === 'TSLiteralType') return;
        if (n.type === 'Literal' || n.type === 'TemplateLiteral') out.push(...(texts(n, m) ?? []));
      });
      // Sentences and phrases: two words or more.
      return [...new Set(out)].filter((t) => /[A-Za-z]{2,} [A-Za-z]{2,}/.test(t));
    };
    const skip = new Set([
      // Shown on screen only.
      'resident-only', 'terrain products are preliminary — validate independently before relying on them', 'the surface is too incomplete for reliable terrain products', 'do not build terrain products from this scan',
      'uses that legally require certified survey data', 'outputs requiring independent validation', 'terrain products, DEM export, contour generation',
      'Scan scope', 'Empty cells', 'Boundary share', 'display sample', 'DTM quality', 'Vertical RMSE', 'DTM quality 12 is rated poor', 'vertical RMSE 12 is rated poor',
      // Joined with other phrases; checked as a list below.
      'Preview only: 12.', 'Insufficient quality for reliable terrain products — 12.', 'surface quality is below export grade; 12 — validate before hand-off',
    ]);
    for (const f of [gate, 'src/terrain/contour/terrainAssessment.ts', 'src/terrain/quality/readinessEngine.ts', 'src/terrain/contour/recommendedWorkflow.ts', 'src/terrain/contour/terrainProducts.ts', 'src/terrain/contour/whyNotReasons.ts']) {
      const found = literals(f).filter((t) => !skip.has(t) && !/^12\/100$|pts\/m²$/.test(t));
      expect(found.length, f).toBeGreaterThan(2);
      found.forEach(check);
    }
    // Every combination of the joined phrases.
    const failed = pushedPhrases(gate);
    expect(failed.length).toBe(5);
    for (let mask = 1; mask < 32; mask++) check(`Preview only: ${list(failed.filter((_, i) => mask & (1 << i)))}.`);
    const caps = pushed('src/terrain/contour/terrainAssessment.ts', ['caps']).texts;
    expect(caps.length).toBe(6);
    for (let mask = 1; mask < 64; mask++) {
      const l = list(caps.filter((_, i) => mask & (1 << i)));
      check(`Insufficient quality for reliable terrain products — ${l}.`);
      check(`${l[0]!.toUpperCase()}${l.slice(1)}.`);
    }
    const gaps = ['CRS unknown', 'vertical datum unknown', 'CRS unknown and vertical datum unknown'];
    for (const g of gaps) { check(g); check(`surface quality is below export grade; ${g} — validate before hand-off`); }
  });

  it('the basis line, the accuracy scopes, the evidence text, the tooltips and the notes', () => {
    const bases: AnalysedBasis[] = (['full', 'partial', 'resident-only', 'sampled'] as const).flatMap((coverage) => [null, 90_000].flatMap((declaredPointCount) => [undefined, 4000].flatMap((residentPointCount) => [null, 6].map((loadStride) => ({ analysedPointCount: 1200, declaredPointCount, coverage, loadStride, ...(residentPointCount ? { residentPointCount } : {}) })))));
    bases.forEach((b) => check(analysedBasisLine(b)));
    const scopes = ['whole-cloud', 'train-only', 'fixed-source-classification'] as const;
    for (const a of scopes) for (const b of scopes) check(blockedTreatmentContrast(a, b));
    for (const l of EVIDENCE_LEVELS) { check(`${l.slice(0, 2)} — ${evidenceLabel(l)} (baseline)`); check(`${l.slice(0, 2)} (${evidenceLabel(l)}) on measured cells; ${l.slice(0, 2)} on filled cells by the registered studies`); }
    check('unregistered (E0)');
    check(dtmCellsEvidenceText(null));
    check(dtmCellsEvidenceText({ cellSizeM: 1, origin: 'data-minimum' }));
    check(EVIDENCE_GATE_NOTE);
    // All three branches of the evidence note, whichever the register selects.
    const src = readFileSync('src/terrain/export/exportProvenance.ts', 'utf8');
    const notes = [...src.slice(src.indexOf('EVIDENCE_GATE_NOTE'), src.indexOf('export interface ExportProvenanceComplexity')).matchAll(/'(Evidence: [^']+)'/g)].map((m) => m[1]!);
    expect(notes.length).toBe(3);
    notes.forEach(check);
    Object.values(METRIC_TOOLTIPS).forEach(check);
    const digestNotes = Object.entries(DIGEST_NOTES).filter(([k, v]) => /_NOTE$/.test(k) && k !== 'NO_ANALYSIS_NOTE' && typeof v === 'string').map(([, v]) => v as string);
    expect(digestNotes.length).toBe(6);
    digestNotes.forEach(check);
    check(SLOPE_ASPECT_CONVENTION_NOTE);
    for (const c of Object.keys(TPI_CLASS) as TpiClassName[]) check(tpiClassLabel(c));
  });

  it('the one-field words', () => {
    const crs: Record<CrsSource, 1> = { 'las-vlr': 1, 'las-evlr': 1, 'copc-meta': 1, 'ept-srs': 1, 'tileset-region': 1, 'catalog-tile': 1, 'user-override': 1, 'format-specification': 1, 'default-assumption': 1 };
    const levels: Record<InterpretationLevel, 1> = { VERIFIED: 1, COMPATIBLE: 1, PROBABLE: 1, RECOVERED: 1, PREVIEW_ONLY: 1, OPAQUE: 1, NOT_POINT_CLOUD: 1 };
    const fields: Record<string, readonly string[]> = {
      CRS: [...Object.keys(crs), 'unknown'], IL: [...Object.keys(levels), 'not-probed', 'not-recorded'], COV: ['full', 'sampled', 'resident-only', 'partial', 'unknown'],
      DE: (['sparse', 'moderate', 'dense', 'very-dense'] as const).map(densityLabel), CX: (['low', 'moderate', 'high', 'very-high'] as const).map(complexityLabel),
      GV: (['poor', 'fair', 'good', 'excellent'] as const).map(groundVisibilityLabel), ST: [...CONTOUR_SHAPE_STYLES.map((s) => s.label), 'unknown'],
      RS: ['validated-in-scope', 'external-evidence-out-of-scope', 'applicability-unknown', 'cross-implementation', 'exploratory', 'refused'],
      SQ: ['Good', 'Preview', 'Limited', 'Blocked'], ER: ['Ready', 'Preview', 'Blocked'], AV: ['Available', 'Preview', 'Blocked'], MODE: ['holdout-cross-validation'], UNIT: ['m', 'ft', 'units', 'degrees', 'unknown'],
    };
    for (const w of say) for (const [prefix, list_] of Object.entries(fields)) for (const t of list_) expect(w.word(prefix, t), `${prefix} ${t}`).not.toBeNull();
  });
});

function list(parts: readonly string[]): string {
  if (parts.length < 3) return parts.join(' and ');
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}
/** The gate's preview phrases: the second item of each `readyChecks` pair. */
function pushedPhrases(file: string): string[] {
  const m = moduleOf(file);
  const out: string[] = [];
  walk(m.root, (n) => {
    if (n.type !== 'VariableDeclarator' || (n.id as Node).name !== 'readyChecks') return;
    for (const e of (n.init as { elements: { elements: Node[] }[] }).elements) out.push(...(texts(e.elements[1]!, m) ?? []));
  });
  return out;
}
