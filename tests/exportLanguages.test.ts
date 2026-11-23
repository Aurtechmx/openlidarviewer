/**
 * exportLanguages.test.ts
 *
 * Export languages and number styles: the catalogs agree with English, the
 * number writers never read the host locale, the session choice behaves, and
 * the space report comes out in each language with nothing left in English
 * that should be translated.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { EXPORT_LANGUAGES, asExportLanguage, languageInfo, type ExportLanguage } from '../src/i18n/languages';
import { fixed, grouped, withDecimalMark, asNumberStyle } from '../src/i18n/numberStyle';
import { fill, templateParams } from '../src/i18n/message';
import { exportLocale, onExportLocaleChange, setExportLanguage, setExportNumberStyle } from '../src/i18n/exportLocale';
import { SPACE_REPORT_TEXT, type SpaceReportKey } from '../src/i18n/deliverables/spaceReport';
import { pdfParagraphs, winAnsiSafe, wrapToWidth } from '../src/winAnsiText';
import {
  ANGULAR_COVERAGE_HINT,
  ANGULAR_COVERAGE_LABEL,
  OBJECT_ENVELOPE_VOLUME_HINT,
  OBJECT_ORIENTED_UNVALIDATED_HINT,
  OBJECT_SURFACE_AREA_HINT,
  objectMetrics,
} from '../src/terrain/objectMetrics';
import { NOT_SURVEY_GRADE_NOTE } from '../src/terrain/export/exportNotes';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { buildSpaceReportContent, noteText, spaceReportWords } from '../src/terrain/space/spaceReportLayout';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';

const loadFont = async (n: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const OTHERS = EXPORT_LANGUAGES.map((l) => l.id).filter((id) => id !== 'en');
const NBSP = ' ';

function room(W = 6, D = 5, H = 2.5, step = 0.1): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) t.push(x, y, 0, x, y, H);
  for (let z = 0; z <= H; z += step) for (let x = 0; x <= W; x += step) t.push(x, 0, z, x, D, z);
  for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) t.push(0, y, z, W, y, z);
  return Float32Array.from(t);
}
function cube(): Float32Array {
  const t: number[] = [];
  for (let u = 0; u <= 4; u += 0.25)
    for (let w = 0; w <= 4; w += 0.25) t.push(u, w, 0, u, w, 4, u, 0, w, u, 4, w, 0, u, w, 4, u, w);
  return Float32Array.from(t);
}
const roomPos = room();
const interior = spaceMetrics(roomPos, { upAxis: 'z', spaceKind: 'interior', hasRgb: true, maxSamples: 4_000, unitToMetres: 1, unitKnown: true });
const plan = extractFloorPlan(roomPos, { upAxis: 'z' });
const cubePos = cube();
const object = { space: spaceMetrics(cubePos, { upAxis: 'z', spaceKind: 'object' }), object: objectMetrics(cubePos) };
const AT = '2026-06-05T12:00:00.000Z';

describe('catalogs', () => {
  const en = SPACE_REPORT_TEXT.en;
  const keys = Object.keys(en) as SpaceReportKey[];

  it.each(OTHERS)('%s has every English entry, with the same parameters, none empty', (lang) => {
    const cat = SPACE_REPORT_TEXT[lang];
    expect(Object.keys(cat).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(cat[k].trim().length, k).toBeGreaterThan(0);
      expect(templateParams(cat[k]), k).toEqual(templateParams(en[k]));
    }
  });

  it.each(OTHERS)('%s survives the Classic PDF fonts with no character lost', (lang) => {
    for (const [k, v] of Object.entries(SPACE_REPORT_TEXT[lang])) {
      expect(winAnsiSafe(v).includes('?') && !v.includes('?'), `${lang}.${k}`).toBe(false);
    }
  });

  it('English holds the sentences the panel and the metrics already print', () => {
    expect(en.hintLargest).toBe(OBJECT_ORIENTED_UNVALIDATED_HINT);
    expect(en.hintEnvelopeVolume).toBe(OBJECT_ENVELOPE_VOLUME_HINT);
    expect(en.hintBoundingSurface).toBe(OBJECT_SURFACE_AREA_HINT);
    expect(en.hintAngular).toBe(ANGULAR_COVERAGE_HINT);
    expect(en.angularCoverage).toBe(ANGULAR_COVERAGE_LABEL);
    expect(en.notSurveyGrade).toBe(NOT_SURVEY_GRADE_NOTE);
  });

  it('every coded note, said in English, is the sentence the metrics wrote', () => {
    const w = spaceReportWords();
    const unknown = spaceMetrics(roomPos, { upAxis: 'z', spaceKind: 'interior', unitKnown: false, maxSamples: 4_000 });
    const partial = spaceMetrics(roomPos, { upAxis: 'z', spaceKind: 'interior', residentOnly: true });
    const blank = spaceMetrics(new Float32Array(9), { upAxis: 'z', spaceKind: 'interior' });
    for (const m of [interior, object.space, unknown, partial, blank]) {
      expect(m.notes?.length).toBe(m.reasons.length);
      expect(m.notes!.map((n) => noteText(n, w))).toEqual(m.reasons);
    }
  });

  it('only English is marked reviewed until a reviewer signs a language off', () => {
    expect(EXPORT_LANGUAGES.filter((l) => l.reviewed).map((l) => l.id)).toEqual(['en']);
    expect(languageInfo('xx').id).toBe('en');
    expect(asExportLanguage('es')).toBe('es');
    expect(asExportLanguage('zz')).toBe('en');
  });
});

describe('number styles', () => {
  it('write decimals and thousands without reading the host locale', () => {
    expect(fixed('point', 1234.5, 2)).toBe('1234.50');
    expect(fixed('comma', 1234.5, 2)).toBe('1234,50');
    expect(grouped('point', 357192)).toBe('357,192');
    expect(grouped('comma', 357192)).toBe(`357${NBSP}192`);
    expect(grouped('point', -1234567)).toBe('-1,234,567');
    expect(grouped('point', 999)).toBe('999');
    expect(withDecimalMark('comma', '3.13 x 2.94 m (10.3 ft)')).toBe('3,13 x 2,94 m (10,3 ft)');
    expect(asNumberStyle('comma')).toBe('comma');
    expect(asNumberStyle('x')).toBe('point');
  });

  it('fill throws on a missing parameter rather than print a hole', () => {
    expect(fill('{a} and {b}', { a: 1, b: 2 })).toBe('1 and 2');
    expect(() => fill('{a} and {b}', { a: 1 }, 'k')).toThrow(/k: missing parameter b/);
  });
});

describe('the session export language', () => {
  afterEach(() => setExportLanguage('en'));

  it('starts in English with point decimals; a language brings its usual number style', () => {
    expect(exportLocale()).toEqual({ lang: 'en', numberStyle: 'point' });
    setExportLanguage('es');
    expect(exportLocale()).toEqual({ lang: 'es', numberStyle: 'point' });
    setExportLanguage('de');
    expect(exportLocale()).toEqual({ lang: 'de', numberStyle: 'comma' });
  });

  it('the number style can be changed on its own, and listeners hear each change once', () => {
    const seen: string[] = [];
    const off = onExportLocaleChange((l) => seen.push(`${l.lang}/${l.numberStyle}`));
    setExportLanguage('pt');
    setExportNumberStyle('point');
    setExportNumberStyle('point');
    off();
    setExportLanguage('fr');
    expect(seen).toEqual(['pt/comma', 'pt/point']);
  });
});

describe('the space report in each language', () => {
  const englishLabels = (lang: ExportLanguage): string[] => {
    const c = buildSpaceReportContent({ ...object, name: 'Box', generatedAt: AT, locale: { lang, numberStyle: 'point' } });
    return c.sections.flatMap((s) => [s.title, ...s.rows.map((r) => r.label)]);
  };

  it.each(OTHERS)('%s translates every section title and row label', (lang) => {
    const en = new Set(englishLabels('en'));
    const words = englishLabels(lang).filter((x) => en.has(x));
    // Titles and labels the languages share with English are proper nouns or symbols.
    expect(words.every((x) => /^(Dimensions|Points|Status|Software)$|\(RGB\)$/.test(x)), words.join(' | ')).toBe(true);
  });

  it('says the translation is not reviewed yet, and English adds no language line', () => {
    const es = buildSpaceReportContent({ space: interior, name: 'Cuarto', generatedAt: AT, locale: { lang: 'es', numberStyle: 'point' } });
    expect(es.provenanceLines.some((l) => /^Idioma\s+Español \(México\) \(traducción pendiente de revisión\)$/.test(l))).toBe(true);
    expect(es.provenance.notSurveyGrade).toMatch(/^Aptitud: no tiene calidad topográfica/);
    const en = buildSpaceReportContent({ space: interior, name: 'Room', generatedAt: AT });
    expect(en.provenanceLines.some((l) => l.startsWith('Language'))).toBe(false);
  });

  it('writes numbers in the chosen style, apart from the language', () => {
    const rows = (numberStyle: 'point' | 'comma') =>
      buildSpaceReportContent({ space: interior, name: 'Room', generatedAt: AT, locale: { lang: 'es', numberStyle } })
        .sections.flatMap((s) => s.rows.map((r) => r.value)).join(' | ');
    expect(rows('point')).toMatch(/\d\.\d{2} x \d\.\d{2} x \d\.\d{2} m/);
    expect(rows('comma')).toMatch(/\d,\d{2} x \d,\d{2} x \d,\d{2} m/);
    expect(rows('comma')).not.toMatch(/\d\.\d/);
  });

  it('translates the caveats from their codes', () => {
    const fr = buildSpaceReportContent({ space: interior, name: 'Pièce', generatedAt: AT, locale: { lang: 'fr', numberStyle: 'comma' } });
    expect(fr.caveats.length).toBe(interior.reasons.length);
    expect(fr.caveats.join(' ')).toMatch(/plafond|Calculé/);
    expect(fr.caveats.join(' ')).not.toMatch(/\b(the|and|are)\b/);
  });

  it.each(OTHERS)('%s builds in every sheet style, tagged with its language, with nothing replaced by ?', async (lang) => {
    const { pdfText } = await import('./e2e/pdfText');
    const tag = languageInfo(lang).tag;
    for (const style of ['classic', 'light', 'dark'] as const) {
      const locale = { lang, numberStyle: languageInfo(lang).numberStyle };
      const bytes = await buildSpaceReportPdf(
        { space: interior, name: 'Room', generatedAt: AT, floorPlan: plan, locale },
        style === 'classic' ? {} : { style, loadFont },
      );
      const doc = await PDFDocument.load(bytes);
      expect(String(doc.catalog.get(PDFName.of('Lang')))).toContain(tag);
      const text = await pdfText(bytes);
      expect(text, `${lang} ${style}`).not.toMatch(/\?/);
    }
  }, 120_000);
});

describe('large figures and grouped digits', () => {
  it.each(['de', 'fr', 'pt', 'en'] as const)('%s with comma decimals never leaves a grouping comma in a figure', (lang) => {
    const big = cubePos.map((v) => v * 6.25);
    const content = buildSpaceReportContent({
      name: 's', space: spaceMetrics(big, { upAxis: 'z', spaceKind: 'object', unitToMetres: 1, unitKnown: true }), object: objectMetrics(big),
      generatedAt: AT, locale: { lang, numberStyle: 'comma' },
    });
    const volume = content.sections.flatMap((s) => s.rows).map((r) => r.value).find((v) => v.includes('m³'))!;
    expect(volume).toBe(`15${NBSP}625 m³ (551${NBSP}792 ft³)`);
    for (const r of content.sections.flatMap((s) => s.rows)) expect(r.value).not.toMatch(/\d,\d{3}(?!\d)/);
  });

  it('keeps the digits of a figure on one line', () => {
    const text = `loaded 1${NBSP}234${NBSP}567 points`;
    expect(pdfParagraphs(text)).toEqual([text]);
    expect(wrapToWidth(text, (s) => s.length, 10)).toEqual(['loaded', `1${NBSP}234${NBSP}567`, 'points']);
  });

  it('marks an unreviewed floor plan and writes its band in the number style', () => {
    const svg = floorPlanSvg(plan, { locale: { lang: 'de', numberStyle: 'comma' } });
    expect(svg).toContain('Übersetzung noch nicht geprüft.');
    expect(floorPlanSvg(plan, {})).not.toContain('Translation not yet reviewed');
    const refused = extractFloorPlan(roomPos, { upAxis: 'z', unitKnown: false });
    const text = (numberStyle: 'point' | 'comma') => floorPlanSvg(refused, { locale: { lang: 'es', numberStyle } }).replace(/<[^>]+>/g, ' ');
    expect(text('comma')).toMatch(/0,7 a\s+1,8/);
    expect(text('point')).toMatch(/0\.7 a\s+1\.8/);
  });
});
