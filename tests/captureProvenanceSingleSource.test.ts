/**
 * captureProvenanceSingleSource.test.ts
 *
 * One capture type per scan, stated identically by every surface that states one.
 *
 * `provenance.classify` was called at three sites with three different argument
 * lists. `app/inspectorCardRefreshers.ts` and `render/exportAdapter.ts` passed
 * the scan signals alone; `app/reportExport.ts` passed the signals plus
 * `isNonTerrain` from the shape router. On a compact object or interior the
 * router rules airborne out, so the Inspector reported "Drone-mounted LiDAR (UAV
 * ALS)" while the technical report PDF exported from the same session reported
 * "Ground-based scan, capture method not determined".
 *
 * Ordering made a per-site argument insufficient on its own. Both open paths
 * refresh the panel before the verdict exists: `openScan.ts` calls
 * `refreshProvenance` (line 338) then `revealAnalysePanel` (line 515), and
 * `openStreaming.ts` calls `refreshProvenanceFromStreaming` (line 189) then
 * `revealAnalysePanel` (line 509 for COPC, line 806 for EPT).
 * `revealAnalysePanel` runs `applyScanRoute`, which is where the verdict is
 * produced. The cases below drive the surfaces in that order.
 *
 * The three surfaces are driven through their production entry points: the
 * Inspector through `createInspectorCardRefreshers`, the PDF through
 * `generateReportPdf` with a recording report-engine stub, and the exported
 * image's scan-report card through `buildExportAdapter().captureLabel()`.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { captureProvenance } from '../src/diagnostics/captureProvenance';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';
import { generateReportPdf, type ReportExportDeps } from '../src/app/reportExport';
import { buildExportAdapter, type ExportAdapterHost } from '../src/render/exportAdapter';
import type { Inspector } from '../src/ui/Inspector';
import type { Viewer } from '../src/render/Viewer';
import type { ProvenanceFingerprint } from '../src/diagnostics/provenance';

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
  u.createObjectURL = () => 'blob:capture-provenance-test';
  u.revokeObjectURL = () => {};
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  const u = globalThis.URL as unknown as Record<string, unknown>;
  delete u.createObjectURL;
  delete u.revokeObjectURL;
});

// ── the two scans ───────────────────────────────────────────────────────────

/**
 * A temple: 80 x 60 m footprint (4 800 m²) carrying 960 000 points, so
 * 200 pts/m² over a footprint above the 2 000 m² mapping-scale bound. That is
 * the UAV band in `matchNumeric`, which is why density alone calls it drone.
 * The shape router calls the same scan a compact object.
 */
const templeCloud = {
  name: 'temple.las',
  sourceFormat: 'las',
  pointCount: 960_000,
  declaredPointCount: 960_000,
  bounds: () => ({ min: [0, 0, 0], max: [80, 60, 25] }),
  colors: null,
  intensity: null,
  classification: null,
  metadata: {
    crs: { name: 'EPSG:32614', linearUnit: 'metre', linearUnitToMetres: 1, verticalUnitToMetres: 1 },
  },
};

/**
 * An open survey with the SAME density signature: 200 x 200 m (40 000 m²) at
 * 8 000 000 points is also 200 pts/m². Only the shape verdict separates it from
 * the temple, which is what makes it the control for "the fix did not simply
 * force every scan to ground-based".
 */
const terrainCloud = {
  ...templeCloud,
  name: 'survey.las',
  pointCount: 8_000_000,
  declaredPointCount: 8_000_000,
  bounds: () => ({ min: [0, 0, 0], max: [200, 200, 40] }),
};

// ── the three surfaces ──────────────────────────────────────────────────────

/** The Inspector's Provenance card: the last fingerprint pushed to the panel. */
function panel() {
  let last: ProvenanceFingerprint | null = null;
  const inspector = {
    setProvenance: (f: ProvenanceFingerprint) => { last = f; },
    clearProvenance: () => { last = null; },
    setDatasetIntelligence: vi.fn(),
    clearDatasetIntelligence: vi.fn(),
  } as unknown as Inspector;
  const cards = createInspectorCardRefreshers(inspector);
  return { cards, label: () => last?.label ?? null, confidence: () => last?.confidence ?? null };
}

/** The technical report PDF: the provenance block handed to the report engine. */
async function reportProvenance(cloud: typeof templeCloud) {
  const composeReportInputs = vi.fn((x: Record<string, unknown>) => x);
  const reportStub = {
    normalizeReportTemplateId: (id: string) => id,
    DEFAULT_TEMPLATE_ID: 'technical-report',
    getReportTemplate: (id: string) => ({ label: `Template ${id}` }),
    composeReportInputs,
    generateReport: async () => ({ blob: new Blob(['%PDF-1.7']), failedSections: [] }),
  };
  const viewer = {
    get streamingCloud() { return null; },
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
  await generateReportPdf('technical-report', deps);
  const inputs = composeReportInputs.mock.calls[0]![0] as {
    provenance?: { label: string; confidence: string; signals: readonly string[] };
  };
  return inputs.provenance;
}

/**
 * The scan-report card stamped into an exported image. The host carries the same
 * cloud the panel and the report describe, so a surface that classifies the cloud
 * itself has everything it needs to produce its own answer.
 */
function exportedImageCapture(cloud: typeof templeCloud | null = null) {
  const entries = new Map(
    cloud ? [['a', { cloud, mode: 'rgb', visible: true, placement: null }]] : [],
  );
  const host = {
    clouds: () => entries,
    streaming: () => null,
    setColorMode: vi.fn(),
    setStreamingColorMode: vi.fn(),
    setVisible: vi.fn(),
    snapshot: vi.fn(async () => new Blob()),
    renderFramedTopDown: vi.fn(async () => null),
    renderFigure: vi.fn(async () => null),
    figureViewContext: vi.fn(),
  } as unknown as ExportAdapterHost;
  return buildExportAdapter(host).captureLabel?.() ?? null;
}

beforeEach(() => {
  captureProvenance.clear();
});

describe('capture type: one verdict, every surface', () => {
  it('states ground-based on all three surfaces for a compact object', async () => {
    const p = panel();
    // Open order: the panel refreshes first, the shape router decides after.
    p.cards.refreshProvenance(templeCloud);
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    captureProvenance.setVerdict('object');

    const report = await reportProvenance(templeCloud);
    const image = exportedImageCapture(templeCloud);

    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
    expect(report?.confidence).toBe(p.confidence());
    expect(image?.confidence).toBe(p.confidence());
    expect(report?.signals).toContain(
      'Shape reads as a compact object / interior — airborne capture ruled out by geometry.',
    );
  });

  it('states ground-based on all three surfaces for an interior', async () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    captureProvenance.setVerdict('interior');

    const report = await reportProvenance(templeCloud);
    const image = exportedImageCapture(templeCloud);

    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
  });

  it('keeps the aerial verdict on all three surfaces for a terrain scan', async () => {
    const p = panel();
    p.cards.refreshProvenance(terrainCloud);
    captureProvenance.setVerdict('terrain');

    const report = await reportProvenance(terrainCloud);
    const image = exportedImageCapture(terrainCloud);

    // The same density band as the temple, so this is the control that the
    // shape guard is applied by verdict rather than to every scan.
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
    expect(report?.confidence).toBe('medium');
  });

  it('follows a verdict that lands after the panel already rendered', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    const atOpen = p.label();
    captureProvenance.setVerdict('object');
    expect(atOpen).toBe('Drone-mounted LiDAR (UAV ALS)');
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
  });

  it('follows a streaming re-route that changes the verdict mid-session', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    captureProvenance.setVerdict('terrain');
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    captureProvenance.setVerdict('object');
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
  });
});

describe('capture type: a user override reaches the deliverables', () => {
  it('carries the override into the report PDF and the exported image', async () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    captureProvenance.setVerdict('object');
    captureProvenance.setOverride('terrestrial');

    const report = await reportProvenance(templeCloud);
    const image = exportedImageCapture(templeCloud);

    expect(p.label()).toBe('Terrestrial Laser Scan (TLS)');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
    expect(report?.signals).toContain('User-overridden capture type');
  });

  it('drops the override when the next scan opens', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    captureProvenance.setOverride('spaceborne');
    expect(p.label()).toBe('Spaceborne LiDAR');
    p.cards.refreshProvenance(terrainCloud);
    expect(captureProvenance.override()).toBeNull();
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
  });

  it('drops the previous scan verdict when the next scan opens', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    captureProvenance.setVerdict('object');
    p.cards.refreshProvenance(terrainCloud);
    expect(captureProvenance.verdict()).toBeNull();
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
  });
});

describe('capture type: no scan states nothing', () => {
  it('reports no fingerprint to any surface before a scan opens', () => {
    expect(captureProvenance.fingerprint()).toBeNull();
    expect(exportedImageCapture(templeCloud)).toBeNull();
  });

  it('clears every surface when the scan closes', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud);
    expect(p.label()).not.toBeNull();
    captureProvenance.clear();
    expect(p.label()).toBeNull();
    expect(exportedImageCapture(templeCloud)).toBeNull();
  });
});
