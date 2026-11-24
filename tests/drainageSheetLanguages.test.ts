/**
 * drainageSheetLanguages.test.ts: the drainage sheet in Spanish. Every state
 * of the sheet is built; a line with no row, an English word left on a page, a
 * text off the page or a word too wide for its column fails.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { buildDrainageSheetModel, buildFlowDrainageSheetPdf, type FlowDrainageSheetOptions } from '../src/export/flowDrainageSheetPdf';
import { catchmentStudyGateText } from '../src/export/flowDrainageSheetUnits';
import { drainageWords } from '../src/export/localizeDrainage';
import { DRAINAGE_SHEET_ROWS } from '../src/i18n/deliverables/drainageSheet';
import { templateParams } from '../src/i18n/message';
import { statusLabel } from '../src/simulation/flowPulse/flowGridCursor';
import { modelLimitations, pulseFrom, catchmentFrom, runFlowPulse, FLOW_PULSE_DEFAULTS, type FlowPulseParams, type FlowPulseResult, type FlowSummary } from '../src/simulation/flowPulse/flowPulseRunner';
import { RAINFALL_DEFAULT, RUNOFF_PRESETS, rationalAssumptions } from '../src/simulation/flowPulse/rationalDischarge';
import { basisLimitations } from '../src/simulation/simulationInputBasis';
import { crsOriginOf } from '../src/science/crsOrigin';
import type { ReportLocale } from '../src/simulation/flowPulse/watershed/watershedReportModel';
import { embedReportFonts } from '../src/export/sheetKit/fonts';
import { headerCase, widthOf } from '../src/export/watershedReport/pageKit';
import { FLOW_PROJECTED_SCALE, FLOW_TEST_IDENTITY, flowDtmOf } from './helpers/flowFixtures';
import { buildValley } from './support/watershedValley';
import { encodeStoredPng } from './support/storedPng';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts');
const loadFont = async (name: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(FONT_DIR, name)));
const ES: ReportLocale = { lang: 'es', numberStyle: 'point' };
const ES_COMMA: ReportLocale = { lang: 'es', numberStyle: 'comma' };

const v = buildValley();
const outlet = v.model.sections[0]!.outlet;
const BUILD = { version: '0.0.0', commit: 'abcdef0', dirty: false, builtAt: '2026-11-07T00:00:00Z', node: 'v0', channel: 'dev' };
const base: FlowDrainageSheetOptions = {
  basename: 'valley', title: 'Sitio de prueba', dtm: v.dtm, verticalToMetres: 1, rainfall: RAINFALL_DEFAULT, verticalUnitLabel: 'm', build: BUILD,
  path: { cells: pulseFrom(v.result, 70 * 120 + 50) },
  catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet, snappedFrom: outlet + 1 },
  generationDateIso: '2026-11-07T00:00:00.000Z',
};
const placed: FlowDrainageSheetOptions = {
  ...base, crsName: 'WGS 84 / UTM zone 14N', worldOrigin: { x: 512000, y: 2150000 },
  gridFrame: { originH1: 0, originH2: 0, cellSize: 3 }, linearUnit: 'metre',
  terrainCaveat: { verdict: 'Preview', interpolatedPercent: 6 },
  sourceInterpretation: { interpretationLevel: 'VERIFIED', dataBasis: 'sampled' },
  digests: { sourceSha256: null, sourceSha256Note: 'not recorded by this export path', crsOrigin: crsOriginOf({ source: 'catalog-tile', assertedBy: 'swisstopo (LV95)', name: 'CH1903+', epsg: 2056, verticalEpsg: 5729 }) } as never,
};

/** Every English line a model prints, as the sheet composes it for the page. */
function linesOf(r: FlowPulseResult, o: FlowDrainageSheetOptions): string[] {
  const m = buildDrainageSheetModel(r, o);
  return [
    ...m.statusLines, ...(m.summary ?? []), ...(m.traced ?? []), ...(m.depressions ? [m.depressions.note, ...m.depressions.header] : []),
    ...(m.catchmentStudyWithheld ? [`Not included: ${m.catchmentStudyWithheld}`] : []),
    ...(m.map ? [`Coordinate system: ${m.map.crsText}.`, `${m.map.gridText}.`, `Flow lines, ${m.map.channelCells.toLocaleString('en-US')} cells: ${m.map.channelBasis}. Wider lines drain more cells.`] : []),
  ];
}

const flat = (over: object = {}, params: Partial<FlowPulseParams> = {}): FlowPulseResult => {
  const dtm = flowDtmOf([[5, 5, 3, 5, 5], [5, 4, 4, 4, 5], [5, 4, 0, 4, 5], [5, 4, 4, 4, 5], [5, 5, 5, 5, 5]]);
  const r = runFlowPulse({ ...dtm, ...over } as never, FLOW_PROJECTED_SCALE, { ...FLOW_PULSE_DEFAULTS, ...params }, FLOW_TEST_IDENTITY);
  if (!r.ok) throw new Error(r.code);
  return r;
};

function everyLine(): string[] {
  const out: string[] = [];
  for (const o of [base, placed, { ...base, rainfall: null, path: null, catchment: null, verticalUnitLabel: 'units' as const, verticalResolved: false },
    { ...base, path: null, catchment: null }, { ...base, verticalUnitLabel: 'ft' as const, elevationOrigin: 100, crsName: 'EPSG:2056' },
    { ...placed, crsName: null, linearUnit: 'foot' as const, digests: { ...placed.digests!, crsOrigin: crsOriginOf(null) }, terrainCaveat: { verdict: 'Blocked' as const, interpolatedPercent: 99 } },
    { ...placed, elevationOrigin: 2100, linearUnit: 'unknown' as const },
    { ...base, rainfall: { intensityMmH: 200, runoffC: 0.333 } },
    ...RUNOFF_PRESETS.map((p) => ({ ...base, rainfall: { intensityMmH: 25, runoffC: p.c, presetId: p.id } })),
    { ...base, dtm: null }]) out.push(...linesOf(v.result, o));
  for (const cov of ['sampled', 'resident-only']) out.push(...linesOf(flat({ coverageMode: cov }), {}));
  for (const conditioning of ['raw', 'priority-flood'] as const) {
    const r = flat({}, { conditioning });
    out.push(...linesOf(r, { path: { cells: pulseFrom(r, 0) }, rainfall: RAINFALL_DEFAULT }));
  }
  // A run whose horizontal scale is not resolved, with a path, a catchment and a rainfall.
  const open = flat();
  const noScale = { ...open, basis: { ...open.basis, horizontalScaleResolved: false, complete: false }, contributingAreaM2: null } as FlowPulseResult;
  out.push(...linesOf(noScale, { path: { cells: pulseFrom(open, 0) }, catchment: { mask: catchmentFrom(open, 2), outletCell: 2 }, rainfall: RAINFALL_DEFAULT }));
  // Every status a path can end on.
  for (let s = 0; s < 8; s++) {
    const status = open.routed.status.map(() => s) as typeof open.routed.status;
    out.push(...linesOf({ ...open, routed: { ...open.routed, status } } as FlowPulseResult, { path: { cells: Int32Array.of(0, 1) }, sections: { map: false, catchment: false } }));
    expect(statusLabel(s)).toBeTruthy();
  }
  // A lower bound above the rational method's area limit.
  const big = { ...v.result, grid: { ...v.result.grid, cellMetresX: 300, cellMetresY: 300 } } as FlowPulseResult;
  out.push(...linesOf(big, { ...base, dtm: null }));
  const b = v.result.basis;
  for (const over of [{ coverage: 'sampled' }, { coverage: 'resident-only' }, { withheldExcluded: false }, { withheldExcluded: null }, { horizontalScaleResolved: false }, { interpolatedCells: 12345 }, { policyExcludedCells: 7 }, { totalCells: 99999 }]) {
    out.push(...basisLimitations({ ...b, ...over } as never));
  }
  const sum = { ...v.result.summary, sinkCount: 3, flatCount: 4, cellsRaised: 9, maxFillDepth: 1.25, epsilonAbsorbed: 2, cellsUnreachable: 6 } as FlowSummary;
  for (const unit of ['m', 'ft', 'units'] as const) for (const conditioning of ['raw', 'priority-flood'] as const) {
    out.push(...modelLimitations({ ...FLOW_PULSE_DEFAULTS, conditioning, fillNoData: 'outlet' } as FlowPulseParams, sum, unit));
  }
  for (const c of ['raw', 'priority-flood'] as const) out.push(...rationalAssumptions(c));
  for (const reason of ['incomplete-coverage', 'scale-unresolved', 'raw-routing', 'no-run'] as const) out.push(`Not included: ${catchmentStudyGateText({ ok: false, reason })}`);
  for (const t of ['No watershed on the grid is large enough to study.', 'The analysed DTM was not supplied with the run.']) out.push(`Not included: ${t}`);
  return [...new Set(out)];
}

/** Draws the sheet and records every text with its place. */
async function drawn(o: FlowDrainageSheetOptions): Promise<{ texts: { text: string; page: PDFPage; x: number; y: number; right: number; width: number }[]; misses: string[]; bytes: Uint8Array }> {
  const all: { text: string; page: PDFPage; x: number; y: number; right: number; width: number }[] = [];
  const removed = new Set<PDFPage>();
  const draw = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, p?: Parameters<PDFPage['drawText']>[1]) {
    const w = p!.rotate ? 0 : p!.font!.widthOfTextAtSize(text, p!.size!);
    all.push({ text, page: this, x: p!.x!, y: p!.y!, right: p!.x! + w, width: this.getWidth() });
    return draw.call(this, text, p);
  });
  const remove = PDFDocument.prototype.removePage;
  vi.spyOn(PDFDocument.prototype, 'removePage').mockImplementation(function (this: PDFDocument, i: number) {
    removed.add(this.getPage(i));
    return remove.call(this, i);
  });
  const misses: string[] = [];
  const bytes = await buildFlowDrainageSheetPdf(v.result, o, { loadFont, encodePng: encodeStoredPng, onMiss: (t) => misses.push(t) });
  vi.restoreAllMocks();
  return { texts: all.filter((t) => !removed.has(t.page)), misses, bytes };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('drainage sheet catalog', () => {
  it('has each English row once, with the same parameters in the same order in Spanish', () => {
    const en = DRAINAGE_SHEET_ROWS.map((r) => r[0]);
    expect(new Set(en).size).toBe(en.length);
    for (const [a, b] of DRAINAGE_SHEET_ROWS) {
      expect(templateParams(b), a).toEqual(templateParams(a));
      expect(b.trim().length, a).toBeGreaterThan(0);
      expect(b, a).not.toMatch(/validad|certificad|[\u0080-\u009f ]/i);
    }
  });

  it('has a row for every line of every state, and English comes back as it was', () => {
    const misses: string[] = [];
    const es = drainageWords(ES, (t) => misses.push(t));
    const en = drainageWords({ lang: 'en', numberStyle: 'point' });
    const lines = everyLine();
    expect(lines.length).toBeGreaterThan(120);
    for (const l of lines) {
      es.line(l);
      expect(en.line(l)).toBe(l);
      // The English rows themselves reproduce the English line.
      const round = drainageWords({ lang: 'en', numberStyle: 'comma' }).line(l);
      if (!/\d[.,]\d|, (C )?\d|\(0, 0\)/.test(l)) expect(round).toBe(l);
    }
    expect(misses).toEqual([]);
  });
});

describe('number style', () => {
  const line = (loc: ReportLocale, s: string): string => drainageWords(loc).line(s);
  it('rewrites figures, separates lists with a semicolon, and leaves names and codes alone', () => {
    expect(line(ES, '# Surface')).toBe('# Superficie');
    expect(line(ES, 'Readable cells: 1,234')).toBe('Celdas legibles: 1,234');
    expect(line(ES_COMMA, 'Readable cells: 1,234')).toBe('Celdas legibles: 1 234');
    expect(line(ES_COMMA, 'Start: col 5 from the west, row 7 from the south (512,016.50, 2,150,022.50 NAD83 / 1.5 zone)'))
      .toBe('Inicio: columna 5 desde el oeste, fila 7 desde el sur (512 016,50; 2 150 022,50 NAD83 / 1.5 zone)');
    expect(line(ES_COMMA, 'At the path end (col 1 from the west, row 2 from the south): at least 28.5 L/s at 25 mm/h, C 0.2 (rational method), a lower bound.'))
      .toBe('Al final de la trayectoria (columna 1 desde el oeste, fila 2 desde el sur): al menos 28,5 L/s con 25 mm/h; C 0,2 (método racional), un valor mínimo.');
    expect(line(ES_COMMA, 'Method: a.method-1.5@1, D8 single-flow-direction routing')).toContain('a.method-1.5@1');
    expect(line(ES_COMMA, 'Source file: survey 1.5 v2,000.laz')).toBe('Archivo de origen: survey 1.5 v2,000.laz');
    expect(line(ES_COMMA, 'CRS: not georeferenced; local grid coordinates from (0, 0)')).toContain('(0; 0)');
    expect(line({ lang: 'en', numberStyle: 'comma' }, 'Readable cells: 1,234')).toBe('Readable cells: 1 234');
  });
});

describe('the Spanish sheet', () => {
  for (const [name, o] of [['local', base], ['placed', placed], ['comma', { ...placed, locale: ES_COMMA }]] as const) {
    it(`prints no English line and nothing off the page (${name})`, async () => {
      const { texts, misses, bytes } = await drawn({ locale: ES, ...o });
      if (process.env.DRAINAGE_ES_OUT) (await import('node:fs')).writeFileSync(`${process.env.DRAINAGE_ES_OUT}-${name}.pdf`, bytes);
      expect(misses).toEqual([]);
      const pages = [...new Set(texts.map((t) => t.page))];
      for (const t of texts) expect(t.right, `${t.text} at ${t.x}`).toBeLessThanOrEqual(t.width - 28);
      const all = texts.map((t) => t.text).join(' ');
      // A method id (olv.simulation...) is a code, not English prose.
      const english = all.replace(/olv\.\S+/g, '').match(/\b(the|catchment|outlets?|cells|from|with|flow|scale|drainage|depressions|built|not|of|your|north|routed|units)\b/gi) ?? [];
      expect(english).toEqual([]);
      expect(all).toContain('sin calidad topográfica');
      if (o !== base) expect(all).toContain('VISTA PREVIA - sin calidad topográfica hasta validarse con control.');
      // The draft notice is on every page.
      for (const p of pages) expect(texts.some((t) => t.page === p && t.text === 'Español (México) (traducción pendiente de revisión)')).toBe(true);
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      expect(String(doc.catalog.get(doc.context.obj('Lang') as never))).toContain('es-MX');
      expect(doc.getPageCount()).toBe(pages.length);
    }, 240_000);
  }

  it('keeps every Spanish header word within its column', async () => {
    const fonts = await embedReportFonts(await PDFDocument.create(), loadFont);
    const shares = [0.08, 0.1, 0.14, 0.17, 0.25, 0.13, 0.13];
    const header = buildDrainageSheetModel(v.result, { ...base, verticalUnitLabel: 'units', verticalResolved: false }).depressions!.header;
    const w = drainageWords(ES);
    header.forEach((h, i) => {
      const room = Math.floor((612 - 34 - 26 - 30) * shares[i]!) - 6;
      for (const word of headerCase(w.line(h)).split(' ')) expect(widthOf(word, fonts.bodyBold, 10.5, fonts), word).toBeLessThanOrEqual(room);
    });
  });
});
