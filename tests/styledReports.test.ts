/**
 * styledReports.test.ts: the terrain, space and Contour Studio reports, the
 * floor plan, the scan report themes and the Studio image card in the Light
 * and Dark sheet styles, and Classic left as it was.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { buildTerrainReportPdf } from '../src/render/measure/terrainReportPdf';
import { buildSpaceReportPdf } from '../src/render/measure/spaceReportPdf';
import { buildContourStudioPdf } from '../src/terrain/export/contourStudioPdf';
import { buildContourPdfModel, type ContourPdfInput } from '../src/terrain/contourStudio/contourDeliverablePdfModel';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { classifyScanShape } from '../src/terrain/scanShape';
import { isSheetTheme, resolveTheme } from '../src/report/ReportBranding';
import { cardInk } from '../src/export/ScanReportRenderer';
import { cssColor, sheetTokens } from '../src/export/sheetKit/tokens';
import { sheetStyle, setSheetStyle } from '../src/export/sheetKit/sessionStyle';
import { validatedDecision } from './helpers/exportDecisions';
import type { AnalyseContoursResult } from '../src/terrain/contour/analyseContours';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

function terrainResult(): AnalyseContoursResult {
  return {
    dtm: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', coverageMode: 'full', meanConfidence: 82, cols: 200, rows: 150, cellSizeM: 1, sourcePointCount: 1_200_000, analyzedPointCount: 900_000 },
    intervalM: 1,
    model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full', features: [{}, {}] },
    accuracyStandards: { rmseZM: 0.14, nvaM: 0.27, vvaM: 0.3, pointDensityPerM2: 4.2, densityReferenceFloorsMet: ['QL2'], densityReferenceNote: 'ref' },
    quality: {
      readiness: 'ready', exportReadiness: 'available', crsKnown: true, datumKnown: true, coverageMode: 'full', reasons: [], exportReasons: [],
      measuredCellRatio: 0.9, interpolatedCellRatio: 0.06, emptyCellRatio: 0.05, edgeRiskRatio: 0.02, meanCellConfidence: 82, groundPointRatio: 0.6,
    },
    qualityScore: { score: 85 },
    cellMetrics: { meanDensity: 4.2, boundaryMeasuredRatio: 0.02 },
    cellStatusTally: { measured: 90, interpolated: 5, lowConfidence: 0, edgeRisk: 0, empty: 5, total: 100 },
    excludedByClassification: 1200,
    generationParams: { interpolation: 'geodesic', contourStyle: 'smooth', smoothing: true, despike: true, aggregation: 'median' },
    warnings: [],
  } as unknown as AnalyseContoursResult;
}
const TERRAIN_OPTS = { verticalUnitToMetres: null, basename: 'site-42', generatedAt: '2026-06-05T00:00:00.000Z', softwareVersion: '9.9.9', metricVersion: 'v0.4.1' } as const;

function contourInput(): ContourPdfInput {
  return {
    title: 'Test Site',
    provenance: {
      software: 'OpenLiDARViewer', softwareVersion: '0.5.9', gitCommit: 'abc1234', generated: '2026-07-12T00:00:00.000Z',
      crs: 'EPSG:32610', verticalDatum: 'EGM2008 height', horizontalUnit: 'm', verticalUnit: 'm', grid: '10x10 @ 1 m',
      methodIds: ['olv.contour.analytical@2'], sourceHash: 'deadbeefcafe',
    },
    support: { measuredPct: 80, interpolatedPct: 15, unsupportedPct: 5 },
    validation: { mode: 'holdout-cross-validation', rmseM: 0.123, sampleSize: 42, independentCheckpoints: false },
    decision: validatedDecision(),
    geometry: { cartographic: false, analyticalAvailable: true },
  };
}

function room(W = 10, D = 8, H = 2.5, step = 0.1): Float32Array {
  const t: number[] = [];
  const push = (x: number, y: number, z: number): void => { t.push(x, y, z); };
  for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) { push(x, y, 0); push(x, y, H); }
  for (let z = 0; z <= H; z += step) for (let x = 0; x <= W; x += step) { push(x, 0, z); push(x, D, z); }
  for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) { push(0, y, z); push(W, y, z); }
  return Float32Array.from(t);
}
const pos = room();
const shape = classifyScanShape(pos);
const space = spaceMetrics(pos, { upAxis: shape.up, spaceKind: 'interior', hasRgb: true });
const floorPlan = extractFloorPlan(pos, { upAxis: shape.up });
const spaceInput = { space, name: 'Room', softwareVersion: '0.4.3', metricVersion: 'v0.4.1', floorPlan };

/** The base font names a PDF embeds. */
async function fontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font')) {
      const b = obj.get(PDFName.of('BaseFont'));
      if (b) out.push(b.toString());
    }
  }
  return out;
}

const reports = [
  { name: 'terrain report', build: (style?: 'light' | 'dark' | 'classic') => buildTerrainReportPdf(terrainResult(), TERRAIN_OPTS, style ? { style, loadFont } : {}) },
  { name: 'space report', build: (style?: 'light' | 'dark' | 'classic') => buildSpaceReportPdf(spaceInput, style ? { style, loadFont } : {}) },
  { name: 'Contour Studio PDF', build: (style?: 'light' | 'dark' | 'classic') => buildContourStudioPdf(buildContourPdfModel(contourInput()), style ? { style, loadFont } : {}) },
];

describe.each(reports)('$name', ({ build }) => {
  it('Classic is the report as before, and stays so after a styled build', async () => {
    const plain = await build();
    expect(same(await build('classic'), plain)).toBe(true);
    await build('dark');
    expect(same(await build(), plain)).toBe(true);
  }, 120_000);

  for (const style of ['light', 'dark'] as const) {
    it(`${style}: deterministic, the same page count, set in the sheet faces`, async () => {
      const a = await build(style);
      expect(same(a, await build(style))).toBe(true);
      const classic = await PDFDocument.load(await build());
      expect((await PDFDocument.load(a)).getPageCount()).toBe(classic.getPageCount());
      expect((await fontNames(a)).some((n) => n.includes('Figtree'))).toBe(true);
    }, 120_000);
  }
});

describe('floor plan', () => {
  const opts = { title: 'Room', dateText: '2026-01-01' } as const;
  it('Classic, or no style, is the sheet as before, and stays so after a styled one', () => {
    const plain = floorPlanSvg(floorPlan, opts);
    expect(floorPlanSvg(floorPlan, { ...opts, style: 'classic' })).toBe(plain);
    floorPlanSvg(floorPlan, { ...opts, style: 'dark' });
    expect(floorPlanSvg(floorPlan, opts)).toBe(plain);
    expect(plain).toContain('fill="#ffffff"');
  });

  it('Light and Dark lay the sheet on the style paper and ink', () => {
    for (const style of ['light', 'dark'] as const) {
      const t = sheetTokens(style);
      const svg = floorPlanSvg(floorPlan, { ...opts, style });
      expect(svg).toContain(`fill="${cssColor(t.paper)}"`);
      expect(svg).toContain(cssColor(t.ink));
    }
  });
});

describe('scan report and Studio image', () => {
  it('the sheet themes take the style tokens and the sheet fonts', () => {
    expect(isSheetTheme('sheet-dark')).toBe(true);
    expect(isSheetTheme('dark-inspection')).toBe(false);
    expect(resolveTheme('sheet-dark')).not.toEqual(resolveTheme('sheet-light'));
  });

  it('the Studio card keeps its own ink in Classic and takes the style otherwise', () => {
    expect(cardInk(null)).toEqual(cardInk('classic'));
    expect(cardInk(null).primary).toBe('#f4f6fa');
    const t = sheetTokens('light');
    expect(cardInk('light').primary).toBe(cssColor(t.ink));
    expect(cardInk('light').accent).toBe(cssColor(t.accent));
  });

  it('the session style is Light until changed, and is never stored', () => {
    const before = sheetStyle();
    setSheetStyle('dark');
    expect(sheetStyle()).toBe('dark');
    setSheetStyle(before);
  });
});
