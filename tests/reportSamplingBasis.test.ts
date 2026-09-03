/**
 * reportSamplingBasis.test.ts
 *
 * The exported PDF must disclose a display-sampled load the way the on-screen
 * Scan Report already does. A strided LAZ reaches the report with the FILE's
 * declared total in "Points" and the SAMPLE's bounding box in Width / Depth /
 * Height, so "Density" is the declared count over the sample's footprint: a
 * mixed basis. Before this, none of it was on the page: the "Loaded" row was
 * emitted only for a streaming source, which the static path never sets.
 *
 * Pins: the one phrasing (panel and PDF read the same sentence), the static
 * "Loaded" row naming both reductions, the extent + density basis suffixes, and
 * byte-identity for a fully-loaded cloud.
 */

import { describe, it, expect } from 'vitest';
import {
  displaySample,
  DISPLAY_SAMPLE_EXTENT_BASIS,
  DISPLAY_SAMPLE_DENSITY_BASIS,
} from '../src/model/displaySample';
import { buildDatasetSummary, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { scanReport } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import { generateReportPdf, type ReportExportDeps } from '../src/app/reportExport';
import type { Viewer } from '../src/render/Viewer';

// ─────────────────────────────────────────────────────────────────────────────
// displaySample: the shared description of a reduced buffer
// ─────────────────────────────────────────────────────────────────────────────

describe('displaySample: one description of a reduced buffer', () => {
  it('names both reductions when a stride was followed by a voxel pass', () => {
    const s = displaySample({
      pointCount: 1_888_921,
      declaredPointCount: 37_333_283,
      decodedPointCount: 4_000_000,
    });
    expect(s).not.toBeNull();
    expect(s!.value).toBe(
      '1,888,921 (display sample: stride to 4,000,000, then voxel-reduced to 1,888,921 centroids)',
    );
  });

  it('names the stride ratio when no voxel pass ran', () => {
    const s = displaySample({ pointCount: 1000, declaredPointCount: 4000, loadStride: 4 });
    expect(s!.value).toBe('1,000 (display sample: 1-in-4 stride)');
  });

  it('falls back to a bare stride when neither reduction was recorded', () => {
    const s = displaySample({ pointCount: 1000, declaredPointCount: 4000 });
    expect(s!.value).toBe('1,000 (display sample: stride)');
  });

  it('is null when the buffer holds every declared point', () => {
    expect(displaySample({ pointCount: 4000, declaredPointCount: 4000 })).toBeNull();
    expect(displaySample({ pointCount: 4000 })).toBeNull();
  });
});

describe('displaySample: the panel and the PDF read one sentence', () => {
  it('reproduces the Scan Report panel Loaded row verbatim', () => {
    const cloud = new PointCloud({
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'las',
      name: 'strided.laz',
      declaredPointCount: 400,
      decodedPointCount: 40,
    });
    const panel = scanReport.run(cloud).rows.find((r) => r.label === 'Loaded');
    expect(panel).toBeDefined();
    expect(panel!.value).toBe(displaySample(cloud)!.value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDatasetSummary: the PDF's dataset-summary rows
// ─────────────────────────────────────────────────────────────────────────────

const FULL: MetadataInputs = {
  fileName: 'survey.las',
  format: 'LAS',
  sourcePointCount: 37_333_283,
  width: 922,
  depth: 1000,
  height: 330.6,
  density: 40.5,
  hasRgb: true,
  hasIntensity: false,
  hasClassification: false,
  crsName: 'NAD83 / UTM zone 15N',
  crsUnit: 'metre',
};

const SAMPLED: MetadataInputs = {
  ...FULL,
  displaySampleNote:
    '1,888,921 (display sample: stride to 4,000,000, then voxel-reduced to 1,888,921 centroids)',
};

const rowMap = (inputs: MetadataInputs): Map<string, string> => {
  const m = new Map<string, string>();
  for (const r of buildDatasetSummary(inputs)) m.set(r.label, r.value);
  return m;
};

describe('buildDatasetSummary: display-sample disclosure', () => {
  it('emits a Loaded row naming both reductions, directly below the file total', () => {
    const rows = buildDatasetSummary(SAMPLED);
    const labels = rows.map((r) => r.label);
    expect(labels.indexOf('Loaded')).toBe(labels.indexOf('Points') + 1);
    expect(rows[labels.indexOf('Loaded')]!.value).toBe(SAMPLED.displaySampleNote);
  });

  it('marks the extents as the display sample bounding box', () => {
    const m = rowMap(SAMPLED);
    expect(m.get('Width')).toBe(`922.0 m${DISPLAY_SAMPLE_EXTENT_BASIS}`);
    expect(m.get('Depth')).toBe(`1.00 km${DISPLAY_SAMPLE_EXTENT_BASIS}`);
    expect(m.get('Height')).toBe(`330.6 m${DISPLAY_SAMPLE_EXTENT_BASIS}`);
  });

  it('marks the extents on an unconfirmed-unit scan too', () => {
    const m = rowMap({ ...SAMPLED, extentUnitStatus: 'unknown', density: Number.NaN });
    expect(m.get('Width')).toBe(`922.0 (source units)${DISPLAY_SAMPLE_EXTENT_BASIS}`);
    // The units warning row is not an extent and keeps its own wording.
    expect(m.get('Units')).toBe('Unconfirmed — extents in source units');
  });

  it('states the density mixed basis in the panel wording', () => {
    expect(rowMap(SAMPLED).get('Density')).toBe(`40.5 pts/m²${DISPLAY_SAMPLE_DENSITY_BASIS}`);
    expect(DISPLAY_SAMPLE_DENSITY_BASIS).toBe(
      ' (mean: declared count over the display-sample footprint)',
    );
  });

  it('leaves the numbers alone, only the basis is added', () => {
    const m = rowMap(SAMPLED);
    expect(m.get('Points')).toBe('37,333,283');
    expect(parseFloat(m.get('Width')!)).toBeCloseTo(922, 6);
    expect(parseFloat(m.get('Density')!)).toBeCloseTo(40.5, 6);
  });

  it('is byte-identical to today for a fully-loaded cloud', () => {
    expect(buildDatasetSummary(FULL)).toEqual([
      { label: 'File', value: 'survey.las' },
      { label: 'Format', value: 'LAS' },
      { label: 'Points', value: '37,333,283' },
      { label: 'Width', value: '922.0 m' },
      { label: 'Depth', value: '1.00 km' },
      { label: 'Height', value: '330.6 m' },
      { label: 'Density', value: '40.5 pts/m²' },
      { label: 'RGB', value: 'Yes' },
      { label: 'Intensity', value: 'No' },
      { label: 'Classification', value: 'No' },
      { label: 'CRS', value: 'NAD83 / UTM zone 15N' },
      { label: 'Units', value: 'metre' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateReportPdf: the static path now sets the disclosure
// ─────────────────────────────────────────────────────────────────────────────

type ReportInputs = { metadata: Record<string, unknown> };

function makeDeps(cloud: Record<string, unknown>) {
  const composeReportInputs = vi.fn((x: ReportInputs) => x);
  const reportStub = {
    normalizeReportTemplateId: (id: string) => id,
    DEFAULT_TEMPLATE_ID: 'engineering-inspection',
    getReportTemplate: (id: string) => ({ label: `Template ${id}` }),
    composeReportInputs,
    generateReport: vi.fn(async () => ({ blob: new Blob(['%PDF-1.7']), failedSections: [] })),
  };
  const viewer = {
    get streamingCloud() {
      return null;
    },
    annotate: { getAnnotations: () => [] },
    measure: { getMeasurements: () => [], unitSystem: 'metric', unitToMetres: 1 },
  } as unknown as Viewer;
  const deps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    scans: { activeId: 'a', activeCloud: () => cloud },
    crsCurrent: () => null,
    classScopeStamp: () => '',
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
    loadReportEngine: vi.fn(async () => reportStub),
    dropZone: { setError: vi.fn() },
    debug: false,
  } as unknown as ReportExportDeps;
  return { deps, composeReportInputs };
}

const baseCloud = {
  name: 'survey.laz',
  sourceFormat: 'laz',
  bounds: () => ({ min: [0, 0, 0], max: [922, 1000, 330.6] }),
  colors: undefined,
  intensity: undefined,
  classification: undefined,
  metadata: undefined,
};

describe('generateReportPdf: a strided static load discloses its sampling', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
      body: { appendChild() {} },
    });
    const u = globalThis.URL as unknown as Record<string, unknown>;
    u.createObjectURL = () => 'blob:sampling-basis-test';
    u.revokeObjectURL = () => {};
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const u = globalThis.URL as unknown as Record<string, unknown>;
    delete u.createObjectURL;
    delete u.revokeObjectURL;
  });

  it('carries both reductions through to the metadata', async () => {
    const { deps, composeReportInputs } = makeDeps({
      ...baseCloud,
      pointCount: 1_888_921,
      declaredPointCount: 37_333_283,
      decodedPointCount: 4_000_000,
    });
    await generateReportPdf('technical-report', deps);
    const inputs = composeReportInputs.mock.calls[0]![0] as ReportInputs;
    // The declared total still headlines the report; no number moves.
    expect(inputs.metadata.sourcePointCount).toBe(37_333_283);
    expect(inputs.metadata.displaySampleNote).toBe(
      '1,888,921 (display sample: stride to 4,000,000, then voxel-reduced to 1,888,921 centroids)',
    );
  });

  it('carries the stride ratio when the loader only strided', async () => {
    const { deps, composeReportInputs } = makeDeps({
      ...baseCloud,
      pointCount: 1000,
      declaredPointCount: 4000,
      loadStride: 4,
    });
    await generateReportPdf('technical-report', deps);
    const inputs = composeReportInputs.mock.calls[0]![0] as ReportInputs;
    expect(inputs.metadata.displaySampleNote).toBe('1,000 (display sample: 1-in-4 stride)');
  });

  it('discloses nothing for a fully-loaded cloud', async () => {
    const { deps, composeReportInputs } = makeDeps({
      ...baseCloud,
      pointCount: 4000,
      declaredPointCount: 4000,
    });
    await generateReportPdf('technical-report', deps);
    const inputs = composeReportInputs.mock.calls[0]![0] as ReportInputs;
    expect(inputs.metadata.displaySampleNote).toBeUndefined();
  });
});
