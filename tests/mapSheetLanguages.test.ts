/**
 * mapSheetLanguages.test.ts: the Light and Dark contour map sheet in every
 * export language. Each state of the sheet is drawn; a sentence with no
 * translation, an English word left on the sheet, a text off the page or over
 * another fails. The modules that write a measurement's figure, its support
 * and the provenance lines are run too, so a sentence they can write without a
 * row fails here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFFont, PDFName, PDFPage, type PDFString } from 'pdf-lib';
import { buildContourSheetPdf } from '../src/render/measure/mapSheetStyled';
import { mapSheetEvidenceLine, mapSheetEvidenceNote, purposeAppendixContent, readinessNote, type MapSheetInput } from '../src/render/measure/mapSheetPdf';
import { MAP_SHEET_TEXT, type MapSheetKey } from '../src/i18n/deliverables/mapSheet';
import { EXPORT_LANGUAGES } from '../src/i18n/languages';
import { templateParams } from '../src/i18n/message';
import { mapSheetWords } from '../src/export/localizeMapSheet';
import type { ExportLocale } from '../src/i18n/exportLocale';
import { supportWord } from '../src/export/sheetKit/sheetMeasurement';
import { gradeMeasurement, type MeasurementTrustInput } from '../src/render/measure/measurementTrust';
import {
  formatArea, formatArmAngle, formatBoxHeadline, formatFramedBearing, formatGrade, formatLength, formatProfileHeadline, formatUnitUnverified, formatVolume,
  volumeBaseLevelClause, volumeCaveatClauses, volumeWithheldClause,
} from '../src/render/measure/format';
import { CROSS_FRAME_MEASUREMENT, GEOGRAPHIC_NOT_AVAILABLE, UNRESOLVED_UNIT_FRAME, UP_AXIS_CONFLICT, VERTICAL_NOT_AVAILABLE, VERTICAL_SCALE_NOT_AVAILABLE, type VolumeRecord } from '../src/render/measure/types';
import { unresolvedHeadline } from '../src/render/measure/geometry';
import { describeValidity, type PolygonValidity } from '../src/render/measure/polygonHygiene';
import { areaRingVerdict } from '../src/render/measure/areaValidity';
import { gltfUnderCrsAxisReason } from '../src/geo/frame/layerUpFrame';
import { stockpileAuthority } from '../src/render/measure/stockpilePresenter';
import { interpolationVerdict } from '../src/render/measure/volume';
import { NO_USABLE_COVERAGE_REASON } from '../src/render/measure/measureDerivations';
import { CONTOUR_SHAPE_STYLES } from '../src/terrain/contour/contourShapeStyle';
import { PURPOSE_META } from '../src/terrain/contourStudio/contourStudioPurpose';
import { EVIDENCE_REGISTRY } from '../src/validation/evidenceRegistry';
import { MAP_STATES, MEASUREMENTS, mapInput } from './helpers/mapSheetStates';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const FOREIGN: ExportLocale[] = EXPORT_LANGUAGES.filter((l) => l.id !== 'en').map((l) => ({ lang: l.id, numberStyle: l.numberStyle }));

interface Drawn { text: string; size: number; x: number; y: number; right: number; rotated: boolean; page: PDFPage }
async function drawn(input: MapSheetInput, font = loadFont): Promise<{ ts: Drawn[]; missed: string[]; bytes: Uint8Array }> {
  const ts: Drawn[] = [], missed: string[] = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { size?: number; x?: number; y?: number; rotate?: unknown; font?: PDFFont }) {
    ts.push({ text: t, size: o?.size ?? 0, x: o?.x ?? 0, y: o?.y ?? 0, right: (o?.x ?? 0) + (o?.font?.widthOfTextAtSize(t, o.size ?? 0) ?? 0), rotated: o?.rotate !== undefined, page: this });
    return orig.call(this, t, o as never);
  });
  const bytes = await buildContourSheetPdf({ ...input, onUntranslated: (m) => missed.push(m) }, { loadFont: font });
  vi.restoreAllMocks();
  return { ts, missed, bytes };
}
afterEach(() => { vi.restoreAllMocks(); });

/** English words no other language's row uses, so one on a sheet is a missed translation. */
const ENGLISH_ONLY = /\b(the|and|with|from|which|contours?|ground|measured|filled|labelled|cells|scale|units|style|labels|elevation|listed|sheet|points|survey|accuracy|evidence|support|unverified|preview|index|none|yes|off|every|footprint|height|issues|warnings|north|grid|generated|prepared|shading|legend|highest|lowest)\b/i;
/** What the fixtures type or name, which is copied on purpose, and words two languages share. */
const COPIED = /Elevation - Grid 1\.5|Cut and fill, north|Scour at outlet 1\.5|Depth 2\.5 m, 1,200 stones|Soft ground|Depth and height notes 1\.5|A\. Person and Sons|Distance 1|OpenLiDARViewer|Culvert 12|\bRoad\b/gi;
const english = (s: string): string => s.replace(COPIED, '').replace(/\bpoints\b|\bcontour\)|\bStyle\b|\bIndex\b/gi, '');

/** English catalog phrases left on a sheet: whole drawn words, or a phrase of two words or more anywhere in the running text. */
function leftInEnglish(ts: readonly Drawn[], column: number): string[] {
  const drawnWords = new Set(ts.map((t) => t.text.toLowerCase()));
  const running = ` ${english(ts.map((t) => t.text).join(' ')).toLowerCase()} `;
  return Object.values(MAP_SHEET_TEXT).flatMap((row) => {
    if (row[column] === row[0]) return [];
    return row[0].toLowerCase().split(/\{\w+\}/).map((p) => p.trim()).filter((p) => /[a-z]{3}/.test(p) && !row[column]!.toLowerCase().includes(p))
      .filter((p) => (/[a-z]\s+[a-z]/.test(p) ? running.includes(` ${p} `) : drawnWords.has(p)));
  });
}

const inMap = (t: Drawn): boolean => t.rotated || /^[\d\s.,−-]+( [EN])?$/.test(t.text) || /^[A-Z]{1,2}$|^\d+$/.test(t.text);
function overlaps(ts: readonly Drawn[]): string[] {
  const out: string[] = [];
  for (const p of new Set(ts.map((t) => t.page))) {
    const on = ts.filter((t) => t.page === p && t.text.trim() !== '' && !inMap(t));
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
      const a = on[i]!, b = on[j]!;
      const x = Math.min(a.right, b.right) - Math.max(a.x, b.x), y = Math.min(a.y + a.size * 0.7, b.y + b.size * 0.7) - Math.max(a.y, b.y);
      if (x > 0.5 && y > 0.5) out.push(`${a.text} | ${b.text}`);
    }
  }
  return out;
}

describe('the map sheet in every export language', () => {
  for (const locale of FOREIGN) {
    for (const [name, over] of Object.entries(MAP_STATES)) {
      it(`${locale.lang} ${name}`, async () => {
        const { ts, missed } = await drawn(mapInput({ ...over, locale }));
        expect(missed).toEqual([]);
        const bad = ts.filter((t) => !t.rotated).flatMap((t) => [
          ...(t.text.includes('?') ? [`? in ${t.text}`] : []),
          ...(ENGLISH_ONLY.test(english(t.text)) ? [`English: ${t.text}`] : []),
          ...(t.right > t.page.getWidth() - 28 || t.x < 6 || t.y < 19.9 ? [`off the page: ${t.text}`] : []),
        ]);
        expect([...bad, ...overlaps(ts), ...leftInEnglish(ts, EXPORT_LANGUAGES.findIndex((l) => l.id === locale.lang))]).toEqual([]);
        const draft = mapSheetWords(locale).draft!;
        const pages = new Set(ts.map((t) => t.page));
        expect(ts.filter((t) => t.text === draft)).toHaveLength(pages.size);
      }, 60_000);
    }
  }
});

describe('what is never translated or renumbered', () => {
  for (const locale of FOREIGN) it(locale.lang, async () => {
    const { ts } = await drawn(mapInput({ ...MAP_STATES.measured, locale, title: 'Elevation 1,200.5', crs: 'units', verticalDatum: 'unknown', preparedBy: 'Legend 2.5' }));
    const all = ts.map((t) => t.text);
    for (const v of ['Elevation 1,200.5', 'units', 'unknown', 'Legend 2.5', 'Distance 1', 'EPSG:4326', 'Cut and fill, north', 'Depth and height notes 1.5', '1. Scour at outlet 1.5: Depth 2.5 m, 1,200 stones'].filter((x) => x !== 'Distance 1')) {
      expect(all.join(' '), v).toContain(v);
    }
  }, 60_000);

  it('a map sheet from a scan with no CRS says so in the language', async () => {
    const { ts } = await drawn(mapInput({ ...MAP_STATES.georefUnknown, locale: { lang: 'es', numberStyle: 'point' } }));
    const all = ts.map((t) => t.text);
    expect(all).toContain('sin georreferencia');
    expect(all).toContain('desconocido');
    expect(all).toContain('norte verdadero desconocido');
  }, 60_000);
});

describe('numbers', () => {
  it('follow the number style, with coordinates, codes and times as they were', async () => {
    const de = (await drawn(mapInput({ ...MAP_STATES.ready, locale: { lang: 'de', numberStyle: 'comma' } }))).ts.map((t) => t.text);
    expect(de).toContain('0,03 m');
    expect(de.some((t) => /^1:\d{1,3}(\u00a0\d{3})* auf Letter quer$/.test(t))).toBe(true);
    expect(de.join(' ')).toContain('2026-11-20 12:00 UTC');
    expect(de.join(' ')).toContain('EPSG:32612');
    expect(de.some((t) => /\d\.\d/.test(t.replace(/v0\.7\.2|Grid 1\.5|95\. Perz/g, '')))).toBe(false);
    const en = (await drawn(mapInput({ locale: { lang: 'en', numberStyle: 'comma' } }))).ts.map((t) => t.text);
    expect(en).toContain('Legend'.toUpperCase());
    expect(en.some((t) => /^\d+,\d+ % measured/.test(t))).toBe(true);
  }, 60_000);

  it('the scale ratio does not depend on the machine it was made on', async () => {
    const spy = vi.spyOn(Number.prototype, 'toLocaleString').mockReturnValue('2.500');
    const { ts } = await drawn(mapInput({ locale: { lang: 'fr', numberStyle: 'comma' } }));
    spy.mockRestore();
    expect(ts.some((t) => t.text.startsWith('1:2.500'))).toBe(false);
  }, 60_000);
});

describe('the document', () => {
  it('names its language, and its title when none was typed', async () => {
    for (const l of EXPORT_LANGUAGES) {
      const { bytes } = await drawn(mapInput({ title: undefined, locale: { lang: l.id, numberStyle: l.numberStyle } }));
      const doc = await PDFDocument.load(bytes);
      expect((doc.catalog.lookup(PDFName.of('Lang')) as PDFString).decodeText()).toBe(l.tag);
      expect(doc.getTitle()).toBe(mapSheetWords({ lang: l.id, numberStyle: l.numberStyle }).say('title'));
    }
  }, 60_000);

  it('is the same file with English asked for as with no language', async () => {
    const a = await buildContourSheetPdf(mapInput(MAP_STATES.measured), { loadFont });
    const b = await buildContourSheetPdf(mapInput({ ...MAP_STATES.measured, locale: { lang: 'en', numberStyle: 'point' } }), { loadFont });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  }, 60_000);

  it('Classic stays in English, byte for byte', async () => {
    const a = await buildContourSheetPdf(mapInput({ ...MAP_STATES.survey, style: 'classic' }));
    const b = await buildContourSheetPdf(mapInput({ ...MAP_STATES.survey, style: 'classic', locale: { lang: 'de', numberStyle: 'comma' } }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  }, 60_000);

  it('is drawn whole without the font files', async () => {
    for (const locale of FOREIGN) {
      const { ts, missed } = await drawn(mapInput({ ...MAP_STATES.measured, locale }), async () => { throw new Error('offline'); });
      expect(missed).toEqual([]);
      for (const t of ts) expect(t.text).not.toContain('?');
    }
  }, 60_000);
});

describe('the sentences other modules write', () => {
  const volume = (over: object): VolumeRecord => ({ interpolatedFraction: 0.31, excludedFraction: 0.04, ...over }) as never;
  const scope = { sourceComplete: true, sampled: false, streaming: false };
  const reasons = [
    stockpileAuthority('refused', scope as never).reason, stockpileAuthority('preview', scope as never).reason,
    stockpileAuthority('full' as never, { ...scope, sourceComplete: false } as never).reason,
    stockpileAuthority('full' as never, { ...scope, sourceComplete: false, streaming: true } as never).reason,
    stockpileAuthority('full' as never, { ...scope, sampled: true } as never).reason,
    interpolationVerdict(0.62).reason!, NO_USABLE_COVERAGE_REASON, 'too much of the footprint interpolated',
  ];
  const trust = (over: Partial<MeasurementTrustInput>): string =>
    gradeMeasurement({ vertices: [{ snappedToPoint: true, pointsWithinRadius: 99 }], crsKnown: true, ...over }).caption;
  const supports = [
    trust({}), trust({ crsKnown: false }), trust({ vertices: [] }), trust({ vertices: [{ snappedToPoint: false, pointsWithinRadius: 0 }] }),
    trust({ vertices: [{ snappedToPoint: true, pointsWithinRadius: 99, onReducedSample: true }] }), trust({ upConflict: true }), trust({ upRefusal: 'x' }),
    trust({ verticalRefused: true }), trust({ geographicCrs: true }), trust({ verticalScaleInvalid: true }),
    ...(['green', 'yellow', 'red', null] as const).map(supportWord),
  ];
  const values = [
    ...MEASUREMENTS.map((m) => m.value),
    ...[0.3, 40, 4000].flatMap((v) => (['metric', 'imperial'] as const).flatMap((u) => [formatLength(v, u), formatArea(v * 1000, u), formatVolume(v, u), formatProfileHeadline(v, -1, 3, u), formatBoxHeadline(v, 2, 1, 4, u)])),
    formatBoxHeadline(3, 2, Number.NaN, Number.NaN, 'metric'), formatBoxHeadline(3, 2, 1, Number.NaN, 'metric'), formatBoxHeadline(3, 2, 1, 6, 'metric', formatUnitUnverified, formatUnitUnverified),
    formatArmAngle(Number.NaN), `${formatGrade(Number.POSITIVE_INFINITY)} · 90.0°`, `3 m · ${formatFramedBearing(42, 'grid')}`, `3 m · ${formatFramedBearing(42, 'local')}`,
    `${formatUnitUnverified(12.5)} footprint · cut/fill —`,
    ...reasons.flatMap((gridAuthorityReason) => [`3 m² · ${volumeWithheldClause(volume({ gridAuthorityReason }))}`, ...volumeCaveatClauses(volume({ gridAuthority: 'preview', gridAuthorityReason }))]),
    volumeWithheldClause(volume({})), ...volumeCaveatClauses(volume({ interpolatedFraction: 0.1, gridAuthority: 'preview' })),
    ...volumeCaveatClauses(volume({ withheld: { noiseExcluded: 1234, exclusionUnavailable: 'reduced-sample' } })), ...volumeCaveatClauses(volume({ withheld: { noiseExcluded: 1 } })),
    '3 m² · +3.1 m³ fill · −2.1 m³ cut · net 1 m³ cut', '3 m² · +3.1 m³ fill · −4.1 m³ cut · net 1 m³ fill',
    ...(['too-few-vertices', 'non-finite-vertex', 'zero-area', 'degenerate-bbox', 'self-intersecting'] as PolygonValidity[]).map((v) => `no area: ${describeValidity(v)}`),
    `no area: ${(areaRingVerdict([[0, 0, 0], [10, 0, 9], [10, 10, 0], [0, 10, 9]]) as { text?: string }).text}`,
    GEOGRAPHIC_NOT_AVAILABLE, VERTICAL_NOT_AVAILABLE, VERTICAL_SCALE_NOT_AVAILABLE, CROSS_FRAME_MEASUREMENT, UP_AXIS_CONFLICT, UNRESOLVED_UNIT_FRAME.upRefusal!,
    `not available: no up axis; ${gltfUnderCrsAxisReason('EPSG:32612')}`,
    unresolvedHeadline({ x: 0.5, y: 0.5, z: 0.5 }, [0, 0, 1], 1), unresolvedHeadline({ x: Number.NaN, y: 0, z: 0 }, [0, 0, 1], 1),
  ];
  const sentences = [
    ...supports, ...CONTOUR_SHAPE_STYLES.map((s) => s.label), ...CONTOUR_SHAPE_STYLES.map((s) => `${s.label} (current view, not recorded)`),
    ...Object.values(PURPOSE_META).flatMap((p) => [`Deliverable - ${p.label}`, p.label, p.summary]),
    ...Object.keys(EVIDENCE_REGISTRY).flatMap((id) => [mapSheetEvidenceLine(id), mapSheetEvidenceNote(id)]), mapSheetEvidenceLine('NONE'), mapSheetEvidenceNote('NONE'),
    ...(['ready', 'previewOnly', 'blocked'] as const).map(readinessNote),
    volumeBaseLevelClause('101.20 m', true), volumeBaseLevelClause('3 (unit unverified)', false),
    ...Object.values(MAP_STATES).flatMap((s) => (s.purpose ? purposeAppendixContent(s.purpose, mapInput(s), { hillshade: true, tint: false }).settings.flatMap(([k, v]) => [k, v]) : [])),
  ];
  for (const locale of FOREIGN) it(locale.lang, () => {
    const missed: string[] = [];
    const w = mapSheetWords(locale, (m) => missed.push(m));
    for (const v of values) {
      const got = w.value(v);
      if (locale.numberStyle === 'comma') expect(got.replace('EPSG:32612', ''), v).not.toMatch(/\d\.\d/);
    }
    for (const s of sentences) w.translate(s);
    expect(missed).toEqual([]);
  });
  it('a name or a reason with no row is reported', () => {
    const missed: string[] = [];
    mapSheetWords({ lang: 'fr', numberStyle: 'comma' }, (m) => missed.push(m)).translate('A sentence nobody translated');
    expect(missed).toEqual(['A sentence nobody translated']);
  });
});

describe('the catalog', () => {
  const keys = Object.keys(MAP_SHEET_TEXT) as MapSheetKey[];
  it('every language uses the English parameters, and no entry is empty', () => {
    for (const k of keys) for (const t of MAP_SHEET_TEXT[k]) {
      expect(t.trim().length, k).toBeGreaterThan(0);
      expect(templateParams(t), k).toEqual(templateParams(MAP_SHEET_TEXT[k][0]));
    }
  });
  it('every English sentence finds its own row', () => {
    const w = mapSheetWords({ lang: 'de', numberStyle: 'point' });
    for (const k of keys) {
      const en = MAP_SHEET_TEXT[k][0];
      if (/\{/.test(en)) continue;
      const first = keys.find((q) => MAP_SHEET_TEXT[q][0] === en)!;
      expect(w.translate(en), k).toBe(MAP_SHEET_TEXT[first][4]);
    }
  });
  it('a statement that denies or hedges still does in every language', () => {
    const denies = [/\b(no|sin|ni|denegada)\b/i, /\b(não|sem|nem|NÃO|recusada)\b/i, /\b(pas|ni|aucune|non|PAS|refusé)\b/, /\b(keine|nicht|KEINE|NICHT|verweigert|unter)\b/i];
    const below = [/por debajo|\bno\b|sin/, /abaixo|não|sem/i, /sous|pas|non/, /unter|nicht|keine/];
    const rowsOf: MapSheetKey[] = ['ready', 'preview', 'evValidated', 'evGeometry', 'evRefused', 'valDisclaimer', 'valCross', 'valNone', 'valRefused', 'psSurvey', 'bSubOf', 'bPointsOf', 'bPoints', 'accNotOnSample', 'vUnverified', 'vertUnverified', 'notGeoref', 'vWithheld', 'noteUnit', 'rGeographic', 'rVertical', 'rScale', 'rCross'];
    for (const k of rowsOf) MAP_SHEET_TEXT[k].slice(1).forEach((t, i) => {
      expect(denies[i]!.test(t) || below[i]!.test(t) || /ungeprüft|zurückgehalten/.test(t), `${k}: ${t}`).toBe(true);
    });
    MAP_SHEET_TEXT.evExploratory.slice(1).forEach((t, i) => expect(t).toMatch(below[i]!));
    for (const t of [MAP_SHEET_TEXT.preview, MAP_SHEET_TEXT.evValidated]) {
      expect(t[1]).toMatch(/sin calidad topográfica/); expect(t[2]).toMatch(/sem qualidade topográfica/); expect(t[3]).toMatch(/pas de qualité topographique/); expect(t[4]).toMatch(/keine Vermessungsqualität/);
    }
  });
});

describe('the title and notes the app makes', () => {
  it.each(['es', 'pt', 'fr', 'de'] as const)('are in the sheet\'s language (%s), and typed text is as typed', async (lang) => {
    const { defaultMapNotes, defaultMapTitle } = await import('../src/render/measure/mapSheetExportOptions');
    const locale = { lang, numberStyle: 'point' as const };
    for (const unit of [1, 0.3048, null]) {
      const title = defaultMapTitle({ title: 'reach — Contours', basename: 'reach' });
      const notes = defaultMapNotes({ basename: 'reach', intervalM: 0.5, crs: unit ? 'EPSG:6346' : null, verticalUnitToMetres: unit });
      const { ts, missed } = await drawn(mapInput({ ...MAP_STATES.measured, locale, title, notes }));
      const all = ts.map((t) => t.text).join(' ');
      expect(missed).toEqual([]);
      expect(all).not.toMatch(/— Contours|Contours from|interval|no CRS|unit unverified/);
      expect(all).toContain('reach —');
    }
    const typed = await drawn(mapInput({ ...MAP_STATES.measured, locale, title: 'My Contours', notes: 'Contours from my drone · by hand' }));
    expect(typed.ts.map((t) => t.text).join(' ')).toContain('My Contours');
    expect(typed.ts.map((t) => t.text).join(' ')).toContain('Contours from my drone');
  });
});
