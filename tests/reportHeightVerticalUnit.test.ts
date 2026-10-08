/**
 * reportHeightVerticalUnit.test.ts
 *
 * The PDF dataset summary resolves Height from the vertical unit, the same way
 * the on-screen Scan Report does. Width and Depth follow the horizontal unit.
 * A metre CRS with no declared vertical unit prints Height in source units and
 * says why, word for word with the Scan Report. Also covers the "CRS origin"
 * row's wording when no vertical datum is declared.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildDatasetSummary, extentRows } from '../src/report/ReportMetadataSection';
import { generateReportPdf, type ReportExportDeps } from '../src/app/reportExport';
import { scanReportUnitBasis } from '../src/analysis/modules/scanReport';
import { streamingExtentRows } from '../src/analysis/streamingExtentRows';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { resolvedFromCrsInfo, type ResolvedCrs } from '../src/geo/CoordinateTypes';
import { resolveExportDigests } from '../src/export/exportDigests';
import { crsOriginLine, crsOriginOf } from '../src/science/crsOrigin';
import { exportDigests } from '../src/science/exportDigestRecord';
import type { CrsInfo } from '../src/io/crs';
import type { Viewer } from '../src/render/Viewer';
import { stubDownloadGlobals } from './helpers/downloadGlobalsStub';

const US_SURVEY_FOOT = 1200 / 3937;

/** ETRF2000-PL / CS92 as the file declares it: metres, no vertical datum or unit. */
const CS92: CrsInfo = {
  source: 'wkt',
  name: 'ETRF2000-PL / CS92',
  epsg: 2180,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
} as CrsInfo;

/** The 2023-12-16 scan's raw extents, in source units. */
const SPAN: readonly [number, number, number] = [1041.9, 461.7, 15.7];

stubDownloadGlobals('blob:height-test');

/**
 * Run the real report export (`generateReportPdf`) for one cloud and CRS and
 * return the PDF's dataset-summary rows. Only the viewer, the scan store and
 * the PDF engine are stubbed; the footprint and metadata wiring is the app's.
 */
async function pdfRows(
  crs: ResolvedCrs | null,
  cloud: { kind: 'static'; format: string; span: readonly [number, number, number] }
       | { kind: 'streaming'; span: readonly [number, number, number] },
): Promise<Map<string, string>> {
  const [x, y, z] = cloud.span;
  const staticCloud = cloud.kind === 'static'
    ? {
        name: '2023-12-16.las', sourceFormat: cloud.format, pointCount: 1000,
        bounds: () => ({ min: [0, 0, 0], max: [x, y, z] }),
        colors: null, intensity: null, classification: null, metadata: {},
      }
    : null;
  const streamingCloud = cloud.kind === 'streaming'
    ? {
        name: 'remote.copc.laz', kind: 'copc' as const,
        dataBounds: () => [0, 0, 0, x, y, z],
        availableColorModes: () => [],
        sourcePointCount: 1000, residentPointCount: 100,
        counts: () => ({ resident: 1, known: 4 }),
      }
    : null;
  const composeReportInputs = vi.fn((i: { metadata: unknown }) => i);
  const reportStub = {
    normalizeReportTemplateId: (id: string) => id,
    resolveExportDigests,
    DEFAULT_TEMPLATE_ID: 'engineering-inspection',
    getReportTemplate: (id: string) => ({ label: id }),
    composeReportInputs,
    generateReport: async () => ({ blob: new Blob(['%PDF-1.7']), failedSections: [] }),
  };
  const viewer = {
    get streamingCloud() { return streamingCloud; },
    annotate: { getAnnotations: () => [] },
    measure: { getMeasurements: () => [], unitSystem: 'metric', unitToMetres: 1 },
  } as unknown as Viewer;
  const deps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    scans: { activeId: staticCloud ? 'a' : null, activeCloud: () => staticCloud },
    crsCurrent: () => crs,
    classScopeStamp: () => '',
    baseName: (n: string) => n,
    loadReportEngine: async () => reportStub,
    dropZone: { setError: vi.fn() },
    debug: false,
  } as unknown as ReportExportDeps;
  await generateReportPdf('survey-summary', deps);
  const md = composeReportInputs.mock.calls[0]![0].metadata as Parameters<typeof buildDatasetSummary>[0];
  return new Map(buildDatasetSummary(md).map((r) => [r.label, r.value]));
}

const resolved = (info: CrsInfo | null): ResolvedCrs | null =>
  info ? resolvedFromCrsInfo(info, 'las-vlr') : null;

/** The on-screen Scan Report's Height for the same CRS and height span. */
function onScreenHeight(crs: ResolvedCrs | null, spanHeight: number): string {
  const b = scanReportUnitBasis(spatialContextFrom(crs));
  return `${(spanHeight * b.vmpu).toFixed(1)}${b.heightUnit}`;
}

const lasCloud = { kind: 'static' as const, format: 'las', span: SPAN };

describe('PDF Height follows the vertical unit (real report export wiring)', () => {
  it('metre CRS, vertical unit not declared: Height stays in source units', async () => {
    const crs = resolved(CS92);
    const m = await pdfRows(crs, lasCloud);
    expect(m.get('Width')).toBe('1041.9 m');
    expect(m.get('Depth')).toBe('461.7 m');
    expect(m.get('Height')).toBe('15.7 source units (vertical unit not declared)');
    expect(m.get('Height')).toBe(onScreenHeight(crs, 15.7));
  });

  it('metre CRS, vertical unit declared in metres: Height in metres', async () => {
    const crs = resolved({ ...CS92, verticalUnitToMetres: 1 } as CrsInfo);
    const m = await pdfRows(crs, lasCloud);
    expect(m.get('Width')).toBe('1041.9 m');
    expect(m.get('Height')).toBe('15.7 m');
    expect(m.get('Height')).toBe(onScreenHeight(crs, 15.7));
  });

  it('metre CRS, vertical unit declared in US survey feet: Height converted by its own factor', async () => {
    const crs = resolved({ ...CS92, verticalUnitToMetres: US_SURVEY_FOOT } as CrsInfo);
    const m = await pdfRows(crs, { ...lasCloud, span: [SPAN[0], SPAN[1], 51.5] });
    expect(m.get('Width')).toBe('1041.9 m');
    expect(m.get('Height')).toBe('15.7 m');
    expect(m.get('Height')).toBe(onScreenHeight(crs, 51.5));
  });

  for (const bad of [0, Number.POSITIVE_INFINITY]) {
    it(`metre CRS, declared vertical factor ${bad}: Height says the unit is invalid`, async () => {
      const crs = resolved({ ...CS92, verticalUnitToMetres: bad } as CrsInfo);
      const m = await pdfRows(crs, lasCloud);
      expect(m.get('Height')).toBe('15.7 source units (declared vertical unit is invalid)');
      expect(m.get('Height')).toBe(onScreenHeight(crs, 15.7));
    });
  }

  it('vertical datum EPSG:5703 with no vertical unit key: both surfaces say source units', async () => {
    const crs = resolved({ ...CS92, verticalEpsg: 5703, verticalDatum: 'NAVD88' } as CrsInfo);
    const m = await pdfRows(crs, lasCloud);
    expect(m.get('Height')).toBe('15.7 source units (vertical unit not declared)');
    expect(m.get('Height')).toBe(onScreenHeight(crs, 15.7));
  });

  it('no CRS: every extent in source units', async () => {
    const m = await pdfRows(null, lasCloud);
    expect(m.get('Width')).toBe('1041.9 (source units)');
    expect(m.get('Depth')).toBe('461.7 (source units)');
    expect(m.get('Height')).toBe('15.7 (source units)');
    expect(m.get('Height')).toBe(onScreenHeight(null, 15.7));
  });

  it('Y-up mesh: Height is the Y span, still in source units without a vertical unit', async () => {
    // PLY loads Y-up: Y carries the height and Z the depth.
    const crs = resolved(CS92);
    const m = await pdfRows(crs, { kind: 'static', format: 'ply', span: [30, 8, 40] });
    expect(m.get('Width')).toBe('30.0 m');
    expect(m.get('Depth')).toBe('40.0 m');
    expect(m.get('Height')).toBe('8.0 source units (vertical unit not declared)');
    expect(m.get('Height')).toBe(onScreenHeight(crs, 8));
  });

  it('streaming COPC: the PDF Height matches the streamed extent rows', async () => {
    const crs = resolved(CS92);
    const m = await pdfRows(crs, { kind: 'streaming', span: SPAN });
    const live = streamingExtentRows({ min: [0, 0, 0], max: [...SPAN] }, spatialContextFrom(crs), 1000);
    expect(m.get('Height')).toBe('15.7 source units (vertical unit not declared)');
    expect(m.get('Height')).toBe(live.rows.find((r) => r.label === 'Height')!.value);
  });

  it('Height in source units does not join the km scale of Width and Depth', () => {
    const rows = extentRows({
      width: 12_000, depth: 8_000, height: 2.5, unitKnown: true,
      heightUnit: 'vertical-unit-not-declared',
    });
    const v = new Map(rows.map((r) => [r.label, r.value]));
    expect(v.get('Width')).toBe('12.0 km');
    expect(v.get('Depth')).toBe('8.0 km');
    expect(v.get('Height')).toBe('2.5 source units (vertical unit not declared)');
  });
});

describe('CRS origin wording when no vertical datum is declared', () => {
  const cs92Origin = crsOriginOf({ source: 'las-vlr', name: 'ETRF2000-PL / CS92', epsg: 2180 });

  it('says the vertical datum is not declared', () => {
    expect(crsOriginLine(cs92Origin)).toBe('CRS source las-vlr (ETRF2000-PL / CS92, EPSG:2180); vertical datum not declared');
    expect(crsOriginLine(crsOriginOf(null))).toBe('CRS source unknown (unknown, unknown); vertical datum not declared');
  });

  it('keeps the datum and its source when one is declared', () => {
    const o = crsOriginOf({ source: 'las-vlr', name: 'NAD83(2011) / UTM zone 15N', epsg: 6344, verticalEpsg: 5703 });
    expect(crsOriginLine(o)).toBe('CRS source las-vlr (NAD83(2011) / UTM zone 15N, EPSG:6344); vertical datum EPSG:5703 from las-vlr');
  });

  it('leaves the machine-readable record fields unchanged', () => {
    expect(cs92Origin).toEqual({
      source: 'las-vlr', name: 'ETRF2000-PL / CS92', epsg: 'EPSG:2180', verticalDatum: 'unknown', verticalSource: 'unknown',
    });
  });

  it('the PDF CRS origin row uses the same wording', () => {
    const rows = buildDatasetSummary({
      fileName: 'a.las', format: 'LAS', sourcePointCount: 1, width: 1, depth: 1, height: 1, density: 1,
      hasRgb: false, hasIntensity: false, hasClassification: false,
      digests: exportDigests({ sha256: 'ab', note: null }, { source: 'las-vlr', name: 'ETRF2000-PL / CS92', epsg: 2180 }),
    });
    expect(rows).toContainEqual({ label: 'CRS origin', value: 'las-vlr, EPSG:2180; vertical datum not declared' });
  });
});
