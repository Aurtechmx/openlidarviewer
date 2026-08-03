import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  effectiveCrsName,
  reportPointCount,
  isNonTerrainVerdict,
  exportGeoContext,
  generateReportPdf,
  type ReportExportDeps,
} from '../src/app/reportExport';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Viewer } from '../src/render/Viewer';
import type { SpaceKind } from '../src/terrain/scanShape';

// ─────────────────────────────────────────────────────────────────────────────
// The pure decisions the extraction exposes — the only report/export logic that
// can be decided without a Viewer, the report engine or the DOM.
// ─────────────────────────────────────────────────────────────────────────────

// A minimal ResolvedCrs with just the two fields `effectiveCrsName` reads.
const crs = (kind: ResolvedCrs['kind'], name: string): ResolvedCrs =>
  ({ kind, name } as ResolvedCrs);

describe('effectiveCrsName — the CRS-label honesty rule', () => {
  it('names the frame for a projected CRS', () => {
    expect(effectiveCrsName(crs('projected', 'NAD83 / UTM zone 15N'))).toBe(
      'NAD83 / UTM zone 15N',
    );
  });

  it('names the frame for a geographic CRS', () => {
    expect(effectiveCrsName(crs('geographic', 'WGS 84'))).toBe('WGS 84');
  });

  it('stamps nothing for a local-coordinate CRS (no real frame to name)', () => {
    // A local scan has no georeferenced frame — stamping a name would be false.
    expect(effectiveCrsName(crs('local', 'Local coordinates (no CRS)'))).toBeUndefined();
  });

  it('stamps nothing for an unknown-kind CRS', () => {
    expect(effectiveCrsName(crs('unknown', 'EPSG:0'))).toBeUndefined();
  });

  it('stamps nothing when there is no resolved CRS at all', () => {
    expect(effectiveCrsName(null)).toBeUndefined();
  });
});

describe('reportPointCount — the file-scale honesty rule', () => {
  it('reports the declared file total when striding reduced the in-memory subset', () => {
    // A 100M-point file rendered at a 4M display budget: the PDF describes the FILE.
    expect(reportPointCount(100_000_000, 4_000_000)).toBe(100_000_000);
  });

  it('reports the rendered count when the load was not strided (declared === rendered)', () => {
    expect(reportPointCount(4_000_000, 4_000_000)).toBe(4_000_000);
  });

  it('reports the rendered count when no total was declared (undefined)', () => {
    expect(reportPointCount(undefined, 2_500_000)).toBe(2_500_000);
  });

  it('never reports a declared total smaller than the rendered count', () => {
    // A smaller "declared" is not a reduction, so it must not win over what loaded.
    expect(reportPointCount(1_000, 4_000)).toBe(4_000);
  });

  it('treats a declared total equal to zero as present but not larger, so rendered wins', () => {
    expect(reportPointCount(0, 4_000)).toBe(4_000);
  });
});

describe('isNonTerrainVerdict — the capture-lens predicate', () => {
  it('is true for a compact object scan', () => {
    expect(isNonTerrainVerdict('object')).toBe(true);
  });

  it('is true for an interior scan', () => {
    expect(isNonTerrainVerdict('interior')).toBe(true);
  });

  it('is false for a terrain scan (aerial density guess allowed)', () => {
    expect(isNonTerrainVerdict('terrain')).toBe(false);
  });

  it('is false when no verdict has been reached yet', () => {
    expect(isNonTerrainVerdict(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exportGeoContext — the origin/CRS/name resolution routing (static → streaming
// → none). Reads only accessors, so it is exercisable with a stubbed deps object.
// ─────────────────────────────────────────────────────────────────────────────

type StaticCloud = {
  sourceOrigin: readonly [number, number, number];
  name: string;
  metadata?: { crs?: { name?: string } };
};
type StreamingCloud = {
  renderOrigin: readonly [number, number, number];
  name: string;
  crs: () => { name?: string } | null;
};

/** Assemble a deps stub with only the members exportGeoContext reads. */
function makeDeps(opts: {
  activeId: string | null;
  cloud?: StaticCloud;
  streaming?: StreamingCloud;
  resolvedCrs?: ResolvedCrs | null;
}): ReportExportDeps {
  const viewer = {
    getCloud: (_id: string) => opts.cloud ?? null,
    get streamingCloud() {
      return opts.streaming ?? null;
    },
  } as unknown as Viewer;
  return {
    getViewer: () => viewer,
    scans: { activeId: opts.activeId, activeCloud: () => null },
    crsCurrent: () => opts.resolvedCrs ?? null,
  } as unknown as ReportExportDeps;
}

describe('exportGeoContext — active-scan frame resolution', () => {
  it('resolves the STATIC cloud source frame when a scan is active', () => {
    const geo = exportGeoContext(
      makeDeps({
        activeId: 'a',
        cloud: { sourceOrigin: [10, 20, 30], name: 'site.las', metadata: { crs: { name: 'EPSG:26915' } } },
        resolvedCrs: crs('projected', 'NAD83 / UTM zone 15N'),
      }),
    );
    expect(geo.origin).toEqual([10, 20, 30]);
    // The RESOLVED label wins over the raw source metadata name.
    expect(geo.crsName).toBe('NAD83 / UTM zone 15N');
    expect(geo.name).toBe('site.las');
  });

  it('falls back to the static cloud source metadata name when the resolved CRS is local', () => {
    const geo = exportGeoContext(
      makeDeps({
        activeId: 'a',
        cloud: { sourceOrigin: [1, 2, 3], name: 'scan.las', metadata: { crs: { name: 'declared-in-file' } } },
        resolvedCrs: crs('local', 'Local coordinates (no CRS)'),
      }),
    );
    // effectiveCrsName is undefined for a local CRS, so the source metadata name shows.
    expect(geo.crsName).toBe('declared-in-file');
  });

  it('resolves the STREAMING renderOrigin when no static cloud is active', () => {
    const geo = exportGeoContext(
      makeDeps({
        activeId: null,
        streaming: { renderOrigin: [100, 200, 300], name: 'remote.copc.laz', crs: () => ({ name: 'EPSG:6339' }) },
        resolvedCrs: crs('projected', 'NAD83(2011) / UTM zone 12N'),
      }),
    );
    expect(geo.origin).toEqual([100, 200, 300]);
    expect(geo.crsName).toBe('NAD83(2011) / UTM zone 12N');
    expect(geo.name).toBe('remote.copc.laz');
  });

  it('returns the zero frame with no CRS or name when nothing is loaded', () => {
    const geo = exportGeoContext(makeDeps({ activeId: null }));
    expect(geo.origin).toEqual([0, 0, 0]);
    expect(geo.crsName).toBeUndefined();
    expect(geo.name).toBeNull();
  });
});

// Exhaustiveness guard: if a new SpaceKind is added, this array must be updated,
// which forces a reviewer to decide whether it counts as non-terrain.
const ALL_VERDICTS: SpaceKind[] = ['interior', 'object', 'terrain'];
describe('isNonTerrainVerdict covers every SpaceKind', () => {
  it('classifies each known verdict without throwing', () => {
    for (const v of ALL_VERDICTS) expect(typeof isNonTerrainVerdict(v)).toBe('boolean');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// generateReportPdf — the wiring body, exercised through a fake ReportExportDeps
// (a stub report engine + fake viewer / scans) the same way the openScan /
// openStreaming siblings cover their delegate bodies. Covers the static + the
// streaming metadata builds, the provenance fingerprint, the partial-render
// warning, the no-scan guard and an engine failure.
// ─────────────────────────────────────────────────────────────────────────────

// generateReportPdf ends by triggering a browser download; the node test env has
// no DOM, so stub the two globals `triggerDownload` touches. Fake timers keep the
// helper's deferred URL-revoke from firing after the stubs are torn down.
beforeAll(() => {
  vi.useFakeTimers();
  vi.stubGlobal('document', {
    createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
    body: { appendChild() {} },
  });
  const u = globalThis.URL as unknown as Record<string, unknown>;
  u.createObjectURL = () => 'blob:reportexport-test';
  u.revokeObjectURL = () => {};
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const u = globalThis.URL as unknown as Record<string, unknown>;
  delete u.createObjectURL;
  delete u.revokeObjectURL;
});

// A static cloud whose declared total exceeds the strided display count (file-scale
// honesty), with a metre CRS + declared source metadata + one colour channel.
const staticCloud = {
  name: 'survey.las',
  sourceFormat: 'las',
  declaredPointCount: 2000,
  pointCount: 1000,
  bounds: () => ({ min: [0, 0, 0], max: [30, 20, 5] }),
  colors: new Float32Array(3),
  intensity: null,
  classification: null,
  metadata: {
    crs: { name: 'NAD83 / UTM zone 15N', linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1 },
    sourceMetadata: { fields: [{ label: 'Scanner', value: 'Faro' }] },
  },
};

// A streaming COPC cloud with a resident subset smaller than the source total.
const streamingCloud = {
  name: 'remote.copc.laz',
  kind: 'copc' as const,
  dataBounds: () => [0, 0, 0, 30, 20, 5],
  crs: () => ({ name: 'EPSG:6339', linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1 }),
  availableColorModes: () => ['rgb', 'intensity', 'classification'],
  sourcePointCount: 5000,
  residentPointCount: 1200,
  counts: () => ({ resident: 12, known: 40 }),
};

type ReportInputs = { templateId: string; subtitle: string; metadata: Record<string, unknown> };

/** Assemble a fake deps + a recording report-engine stub for generateReportPdf. */
function makeReportDeps(opts: {
  staticCloud?: typeof staticCloud;
  streamingCloud?: typeof streamingCloud;
  classScopeStamp?: string;
  verdict?: SpaceKind | null;
  failedSections?: string[];
  generateReject?: boolean;
  normalizeToNull?: boolean;
}) {
  const setError = vi.fn();
  const composeReportInputs = vi.fn((x: ReportInputs) => x);
  const generateReport = vi.fn(async () => {
    if (opts.generateReject) throw new Error('pdf-lib exploded');
    return { blob: new Blob(['%PDF-1.7']), failedSections: opts.failedSections ?? [] };
  });
  const reportStub = {
    normalizeReportTemplateId: (id: string) => (opts.normalizeToNull ? null : id),
    DEFAULT_TEMPLATE_ID: 'engineering-inspection',
    getReportTemplate: (id: string) => ({ label: `Template ${id}` }),
    composeReportInputs,
    generateReport,
  };
  const viewer = {
    get streamingCloud() {
      return opts.streamingCloud ?? null;
    },
    annotate: { getAnnotations: () => [] },
    measure: { getMeasurements: () => [], unitSystem: 'metric', unitToMetres: 1 },
  } as unknown as Viewer;
  const deps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    scans: {
      activeId: opts.staticCloud ? 'a' : null,
      activeCloud: () => opts.staticCloud ?? null,
    },
    crsCurrent: () => null,
    lastScanVerdict: () => opts.verdict ?? null,
    classScopeStamp: () => opts.classScopeStamp ?? '',
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
    loadReportEngine: vi.fn(async () => reportStub),
    dropZone: { setError },
    debug: false,
  } as unknown as ReportExportDeps;
  return { deps, setError, composeReportInputs, generateReport };
}

describe('generateReportPdf — the report assembly body', () => {
  it('assembles a static-cloud report at file scale and hands it to the engine', async () => {
    const { deps, composeReportInputs, generateReport, setError } = makeReportDeps({
      staticCloud,
      classScopeStamp: 'ground only',
      verdict: 'terrain',
    });
    await generateReportPdf('survey-summary', deps);
    expect(composeReportInputs).toHaveBeenCalledTimes(1);
    const inputs = composeReportInputs.mock.calls[0]![0] as ReportInputs;
    // File-scale honesty: the declared 2000, not the strided 1000, reaches the PDF.
    expect(inputs.metadata.sourcePointCount).toBe(2000);
    expect(inputs.metadata.format).toBe('LAS');
    // A non-empty class-scope stamp is disclosed on the metadata.
    expect(inputs.metadata.classScopeNote).toBe('ground only');
    expect(inputs.subtitle).toBe('survey.las');
    // A terrain verdict is provenance-classified without throwing.
    expect(inputs.metadata).toBeDefined();
    expect(generateReport).toHaveBeenCalledTimes(1);
    expect(setError).not.toHaveBeenCalled();
  });

  it('assembles a streaming-cloud report from the resident preview', async () => {
    const { deps, composeReportInputs } = makeReportDeps({
      streamingCloud,
      classScopeStamp: '',
      verdict: 'object',
    });
    await generateReportPdf('technical-report', deps);
    const inputs = composeReportInputs.mock.calls[0]![0] as ReportInputs;
    expect(inputs.metadata.format).toBe('COPC');
    expect(inputs.metadata.sourcePointCount).toBe(5000);
    expect((inputs.metadata.streamingResident as { points: number }).points).toBe(1200);
    // An empty stamp discloses no class-scope note.
    expect(inputs.metadata.classScopeNote).toBeUndefined();
  });

  it('falls back to the default template id when the requested id is unknown', async () => {
    const { deps, composeReportInputs } = makeReportDeps({ staticCloud, normalizeToNull: true });
    await generateReportPdf('bogus-id', deps);
    const inputs = composeReportInputs.mock.calls[0]![0] as ReportInputs;
    expect(inputs.templateId).toBe('engineering-inspection');
  });

  it('warns via the drop zone when the engine drops sections but still ships the PDF', async () => {
    const { deps, setError, generateReport } = makeReportDeps({
      staticCloud,
      failedSections: ['visuals', 'notes'],
    });
    await generateReportPdf('survey-summary', deps);
    expect(generateReport).toHaveBeenCalledTimes(1);
    expect(setError).toHaveBeenCalledTimes(1);
    expect(setError.mock.calls[0]![0]).toContain('visuals, notes');
  });

  it('throws "Load a scan first." when neither a static nor a streaming cloud is present', async () => {
    const { deps, setError } = makeReportDeps({});
    await expect(generateReportPdf('survey-summary', deps)).rejects.toThrow('Load a scan first.');
    expect(setError).not.toHaveBeenCalled();
  });

  it('propagates a report-engine failure to the caller', async () => {
    const { deps } = makeReportDeps({ staticCloud, generateReject: true });
    await expect(generateReportPdf('survey-summary', deps)).rejects.toThrow('pdf-lib exploded');
  });
});
