/**
 * studioCardLanguages.test.ts
 *
 * The Studio image card in each export language. Every exporter is run over
 * several frames, the card each would draw is built, and the localized card is
 * checked for English words the catalog translates. English comes back as it
 * went in. Numbers follow the number style.
 */
import { describe, expect, it, vi } from 'vitest';

const captured: { title: string; mode: string; rows: { label: string; value: string }[] }[] = [];
vi.mock('../src/export/BaseExportMode', async (orig) => {
  const real = await orig<typeof import('../src/export/BaseExportMode')>();
  return {
    ...real,
    runStudioExport: vi.fn(async (_c, mode, title, colorMode, _o, rows) => {
      captured.push({ title, mode: colorMode, rows });
      return { blob: new Blob(), mode, width: 1, height: 1, mimeType: 'image/png' };
    }),
  };
});

import { buildScanReport, MIXED_VERTICAL_FRAME_NOTE } from '../src/export/BaseExportMode';
import { classificationExporter } from '../src/export/ClassificationExporter';
import { contourMapExporter } from '../src/export/ContourMapExporter';
import { depthMapExporter } from '../src/export/DepthMapExporter';
import { heightMapExporter } from '../src/export/HeightMapExporter';
import { intensityExporter } from '../src/export/IntensityExporter';
import { normalMapExporter } from '../src/export/NormalMapExporter';
import { orthographicRgbExporter } from '../src/export/OrthographicRgbExporter';
import { buildExportAdapter } from '../src/render/exportAdapter';
import type { ExportAdapterCloud, ExportAdapterHost } from '../src/render/exportAdapter';
import { resolvedExportCrs } from '../src/app/exportCrsResolver';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import type { CrsInfo } from '../src/io/crs';
import type { ScanReportData } from '../src/export/ScanReportRenderer';
import { classScopeBannerText, localizeScanReport } from '../src/export/localizeCard';
import { restyleNumbers } from '../src/i18n/numberStyle';
import { STUDIO_CARD_TEXT } from '../src/i18n/deliverables/studioCard';
import { EXPORT_LANGUAGES, languageInfo, type ExportLanguage } from '../src/i18n/languages';
import { DERIVED_COLOR_NOTE, CLASSIFICATION_COLOR_NOTE } from '../src/render/colorModeProvenance';
import { GEOCENTRIC_REASON, WEB_MERCATOR_REASON } from '../src/geo/CrsValidation';

const OTHERS = EXPORT_LANGUAGES.map((l) => l.id).filter((id) => id !== 'en');
const UTM: CrsInfo = { source: 'epsg', name: 'WGS 84 / UTM zone 15N', epsg: 32615, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false };
const MERC: CrsInfo = { source: 'epsg', name: 'WGS 84 / Pseudo-Mercator', epsg: 3857, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false };
const GEOC: CrsInfo = { source: 'epsg', name: 'WGS 84 (geocentric)', epsg: 4978, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false, geocentric: true };

function adapterFor(crs: CrsInfo | null, extra: Partial<ExportAdapterHost> = {}) {
  const entry = {
    mode: 'elevation', visible: true, placement: null,
    cloud: { name: 'scan', pointCount: 1_250_000, sourceOrigin: [0, 0, 100], bounds: () => ({ min: [0, 0, 0], max: [1234.5, 987.6, 54.3] }) },
  } as unknown as ExportAdapterCloud;
  return buildExportAdapter({
    clouds: () => new Map([['a', entry]]),
    streaming: () => null,
    resolveCloudCrs: () => resolvedExportCrs(crs ? resolvedFromCrsInfo(crs, 'las-vlr') : null),
    elevationUnitLabel: () => 'm',
    ...extra,
  } as ExportAdapterHost);
}

async function cardsFor(adapter: ReturnType<typeof adapterFor>): Promise<ScanReportData[]> {
  captured.length = 0;
  const context = { adapter, canvas: { width: 800, height: 600 } } as never;
  for (const exporter of [heightMapExporter, depthMapExporter, contourMapExporter, classificationExporter, intensityExporter, normalMapExporter, orthographicRgbExporter]) {
    try { await exporter.render(context, {} as never); } catch { /* an exporter that needs more of the scene is covered by the others */ }
  }
  return captured.map((c) => buildScanReport(c.title, adapter, c.rows, '', c.mode as never));
}

/** Synthetic rows for the values a real scene above does not reach. */
function syntheticCard(): ScanReportData {
  const rows = [
    { label: 'Rendered from', value: '2,271,607 of 210,887,303 points (display sample)' },
    { label: 'Classification', value: 'Present, classified (51.0 % coverage of the display sample)' },
    { label: 'Classification', value: 'Present, unclassified (0.0 % coverage)' },
    { label: 'Units', value: `Not ground metres. ${WEB_MERCATOR_REASON}` },
    { label: 'Units', value: `Not ground metres. ${GEOCENTRIC_REASON}` },
    { label: 'Z range', value: MIXED_VERTICAL_FRAME_NOTE },
    { label: 'Colour', value: DERIVED_COLOR_NOTE },
    { label: 'Colour', value: CLASSIFICATION_COLOR_NOTE },
    { label: 'Class filter', value: 'Ground + Building · 2 of 5 classes' },
    { label: 'Class filter', value: 'full cloud (header) — not class-scoped' },
    { label: 'Density', value: '37655.0 pts/units² (bounding-box estimate)' },
    { label: 'Width', value: '3.2 units' },
    { label: 'Points', value: 'Unknown' },
    ...['Unknown capture type', 'Phone / handheld LiDAR', 'Drone-mounted LiDAR (UAV ALS)', 'Terrestrial Laser Scan (TLS)', 'Mobile SLAM scanner', 'Aerial / airborne LiDAR (ALS)', 'Spaceborne LiDAR']
      .flatMap((label) => ['low', 'medium', 'high'].map((c) => ({ label: 'Capture', value: `${label} (${c})` }))),
  ];
  return { title: 'Height Map', scanName: 'scan', rows, footer: 'OpenLiDARViewer v0 · 2026-01-01 00:00 UTC' };
}

/** Words of the English card text the target language changes. */
function translatedEnglishWords(lang: ExportLanguage): Set<string> {
  const words = (s: string): string[] => s.match(/[A-Za-z]{3,}/g) ?? [];
  const en = STUDIO_CARD_TEXT.en;
  const target = STUDIO_CARD_TEXT[lang];
  const targetWords = new Set([...Object.values(target.exact), ...Object.values(target.templates)].flatMap(words));
  const englishWords = [...Object.values(en.exact), ...Object.values(en.templates)].flatMap(words);
  return new Set(englishWords.filter((w) => !targetWords.has(w)));
}

let scenes: ScanReportData[] = [];

describe('the Studio card in each language', () => {
  it('builds cards from every exporter over several frames', async () => {
    scenes = [
      ...(await cardsFor(adapterFor(UTM))),
      ...(await cardsFor(adapterFor(MERC))),
      ...(await cardsFor(adapterFor(GEOC))),
      ...(await cardsFor(adapterFor(null))),
      syntheticCard(),
    ];
    expect(new Set(scenes.map((s) => s.title)).size).toBeGreaterThanOrEqual(6);
  });

  it('leaves English as it is', () => {
    for (const card of scenes) expect(localizeScanReport(card, { lang: 'en', numberStyle: 'point' })).toBe(card);
  });

  it.each(OTHERS)('%s leaves no translated English word on any card', (lang) => {
    const banned = translatedEnglishWords(lang);
    const locale = { lang, numberStyle: languageInfo(lang).numberStyle };
    for (const card of scenes) {
      const out = localizeScanReport(card, locale);
      const texts = [out.title, ...out.rows.flatMap((r) => [r.label, r.value])];
      const left = texts.flatMap((t) => (t.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => banned.has(w)).map((w) => `${w} in "${t}"`));
      // Class names inside a class filter stay English by design.
      expect(left.filter((x) => !/Ground|Building/.test(x)), left.join('\n')).toEqual([]);
    }
  });

  it('writes numbers in the export number style, names and encodings as they are', () => {
    const card: ScanReportData = {
      title: 'Height Map', scanName: 's', footer: 'f',
      rows: [
        { label: 'Points', value: '1,250,000' },
        { label: 'Width', value: '1.23 km' },
        { label: 'CRS', value: 'WGS 84 / UTM zone 15N' },
        { label: 'Encoding', value: 'RGB · (n + 1) / 2' },
      ],
    };
    const comma = localizeScanReport(card, { lang: 'es', numberStyle: 'comma' });
    expect(comma.rows.map((r) => r.value)).toEqual(['1 250 000', '1,23 km', 'WGS 84 / UTM zone 15N', 'RGB · (n + 1) / 2']);
    const point = localizeScanReport(card, { lang: 'es', numberStyle: 'point' });
    expect(point.rows[0].value).toBe('1,250,000');
    expect(restyleNumbers('Z 1.27 m – 1.34 m', 'comma')).toBe('Z 1,27 m – 1,34 m');
  });

  it('says the class filter banner in the language, and in English as before', () => {
    expect(classScopeBannerText('Ground · 1 of 3 classes', { lang: 'en', numberStyle: 'point' })).toBe('Class filter active — Ground · 1 of 3 classes');
    expect(classScopeBannerText('Ground · 1 of 3 classes', { lang: 'es', numberStyle: 'point' })).toBe('Filtro de clases activo: Ground · 1 de 3 clases');
  });

  const one = (label: string, value: string, lang: ExportLanguage, numberStyle: 'point' | 'comma' = 'comma'): string =>
    localizeScanReport({ title: 'Height Map', scanName: 's', footer: 'f', rows: [{ label, value }] }, { lang, numberStyle }).rows[0].value;

  it('follows the number style in English too', () => {
    expect(one('Points', '1,250,000', 'en')).toBe('1\u00a0250\u00a0000');
    expect(one('Width', '1.23 km', 'en')).toBe('1,23 km');
  });

  it('leaves CRS names alone and translates only the placeholder', () => {
    for (const name of ['unknown', 'Custom grid units', 'units of 0.5 m']) expect(one('CRS', name, 'de')).toBe(name);
    expect(one('CRS', 'Unknown CRS', 'de')).toBe('Unbekanntes KBS');
  });

  it('translates undetermined and declared capture types, quoting the declared value', () => {
    expect(one('Capture', 'Capture method not determined (low)', 'de')).toBe('Erfassungsmethode nicht bestimmt (Konfidenz gering)');
    expect(one('Capture', 'Declared: Sim (v2) (from file metadata) (high)', 'es')).toBe('Declarado: Sim (v2) (según los metadatos del archivo) (confianza alta)');
  });

  it('translates every colour mode', () => {
    for (const lang of OTHERS) for (const mode of ['coverage', 'confidence']) expect(one('Mode', mode, lang)).not.toBe(mode);
  });

  it('says the class filter with every class hidden', () => {
    expect(one('Class filter', '· 0 of 5 classes', 'de')).toBe('0 von 5 Klassen');
    expect(classScopeBannerText('· 0 of 5 classes', { lang: 'fr', numberStyle: 'comma' })).toContain('0 sur 5 classes');
  });

  it('marks an unreviewed language in the card footer, never English', () => {
    for (const lang of OTHERS) expect(localizeScanReport(syntheticCard(), { lang, numberStyle: 'point' }).footer).toContain(STUDIO_CARD_TEXT[lang].templates.draft);
    expect(localizeScanReport(syntheticCard(), { lang: 'en', numberStyle: 'comma' }).footer).toBe(syntheticCard().footer);
  });
});
