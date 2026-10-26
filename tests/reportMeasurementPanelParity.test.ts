/**
 * reportMeasurementPanelParity.test.ts
 *
 * A PDF measurement row reads exactly as the Measurements panel row does. The
 * report export (`generateReportPdf`) runs for real against a live
 * MeasureController; only the scan store and the PDF engine are stubbed, and
 * the rows come from the real `composeReportInputs`.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateReportPdf, type ReportExportDeps } from '../src/app/reportExport';
import { composeReportInputs } from '../src/report/ReportAssetComposer';
import { resolveExportDigests } from '../src/export/exportDigests';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import type { Measurement, MeasurementKind, UnitSystem, Vec3 } from '../src/render/measure/types';
import type { Viewer } from '../src/render/Viewer';
import { installFakeDom } from './support/measurePanelDom';
import { stubDownloadGlobals } from './helpers/downloadGlobalsStub';
import { measurementRowText } from '../src/app/measureResultModel';

beforeAll(() => installFakeDom({ ns: true }));

const UP: Vec3 = [0, 0, 1];
const FT = 0.3048;

function mk(id: string, kind: MeasurementKind, points: Vec3[]): Measurement {
  return { id, kind, name: id, points, closed: kind === 'area' } as Measurement;
}

const FIXTURES: Measurement[] = [
  mk('d', 'distance', [[0, 0, 0], [3, 4, 10]]),
  mk('short', 'distance', [[0, 0, 0], [0.0021, 0, 0]]),
  mk('p', 'polyline', [[0, 0, 0], [3, 4, 10], [8, 4, -5]]),
  mk('a', 'area', [[0, 0, 0], [10, 0, 10], [10, 10, 10], [0, 10, 0]]),
  mk('h', 'height', [[0, 0, 0], [3, 4, 0.2]]),
  mk('an', 'angle', [[10, 0, 0], [0, 0, 0], [10, 0, 10]]),
  mk('s', 'slope', [[0, 0, 0], [3, 4, 1]]),
  mk('pr', 'profile', [[0, 0, 0], [3, 4, 10]]),
  mk('b', 'box', [[0, 0, 0], [1, 0.5, 0.9]]),
  mk('bigbox', 'box', [[0, 0, 0], [12, 7, 3]]),
];

interface Frame { label: string; h: number; v: number; units: UnitSystem; crsKnown: boolean }
const FRAMES: Frame[] = [
  { label: 'metric', h: 1, v: 1, units: 'metric', crsKnown: true },
  { label: 'imperial', h: 1, v: 1, units: 'imperial', crsKnown: true },
  { label: 'metre horizontal, foot heights', h: 1, v: FT, units: 'metric', crsKnown: true },
  { label: 'no confirmed unit', h: 1, v: 1, units: 'metric', crsKnown: false },
];

async function makeController(f: Frame): Promise<MC> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({
    onExit: () => {}, getPickRay: () => null, getPointAt: () => null,
  } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: UP, origin: null });
  measure.setCrsKnown(f.crsKnown);
  measure.setUnitToMetres(f.h);
  measure.setVerticalUnitToMetres(f.v);
  measure.setUnitSystem(f.units);
  measure.loadMeasurements(FIXTURES.map((m) => structuredClone(m)));
  return measure;
}

// The controllers need the fake DOM; the download stub below replaces
// `document`, so they are built first.
const controllers = new Map<string, MC>();
beforeAll(async () => {
  for (const f of FRAMES) controllers.set(f.label, await makeController(f));
});
stubDownloadGlobals('blob:panel-parity');

/** What the real report export hands the composer for this controller. */
async function capturedInputs(measure: MC): Promise<Parameters<typeof composeReportInputs>[0]> {
  const compose = vi.fn((i: unknown) => i);
  const reportStub = {
    normalizeReportTemplateId: (id: string) => id,
    resolveExportDigests,
    DEFAULT_TEMPLATE_ID: 'survey-summary',
    getReportTemplate: (id: string) => ({ label: id }),
    composeReportInputs: compose,
    generateReport: async () => ({ blob: new Blob(['%PDF-1.7']), failedSections: [] }),
  };
  const cloud = {
    name: 'scan.las', sourceFormat: 'las', pointCount: 100,
    bounds: () => ({ min: [0, 0, 0], max: [10, 10, 10] }),
    colors: null, intensity: null, classification: null, metadata: {},
  };
  const viewer = {
    get streamingCloud() { return null; },
    annotate: { getAnnotations: () => [] },
    measure,
  } as unknown as Viewer;
  const deps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    scans: { activeId: 'a', activeCloud: () => cloud },
    crsCurrent: () => null,
    classScopeStamp: () => '',
    baseName: (n: string) => n,
    loadReportEngine: async () => reportStub,
    dropZone: { setError: vi.fn() },
    debug: false,
  } as unknown as ReportExportDeps;
  await generateReportPdf('survey-summary', deps);
  const input = compose.mock.calls[0]![0] as Parameters<typeof composeReportInputs>[0];
  return { ...input, title: 'Survey Summary' };
}

describe('PDF measurement rows read as the panel does', () => {
  for (const f of FRAMES) {
    it(`every kind, ${f.label}`, async () => {
      const measure = controllers.get(f.label)!;
      // The row as the panel prints it: the headline, with a volume's base level under it.
      const panel = new Map(measure.getSummaries().map((s) => [s.id, measurementRowText(s)]));
      const rows = composeReportInputs(await capturedInputs(measure)).measurements;
      expect(rows.map((r) => r.name)).toEqual(FIXTURES.map((m) => m.id));
      for (const r of rows) expect(r.value, `${r.kind} ${r.name}`).toBe(panel.get(r.name));
    });
  }

  it('the report alone formats differently, which is why it takes the panel text', async () => {
    const measure = controllers.get(FRAMES[0]!.label)!;
    const panel = new Map(measure.getSummaries().map((s) => [s.id, s.value]));
    const { measurementValues: _dropped, ...alone } = await capturedInputs(measure);
    const rows = composeReportInputs(alone).measurements;
    expect(rows.some((r) => r.value !== panel.get(r.name))).toBe(true);
  });
});
