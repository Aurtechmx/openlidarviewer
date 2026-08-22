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
 *
 * One store, two scopes. The Inspector and the PDF describe the active scan;
 * the exported image describes the visible scene. The last describe block below
 * covers the scenes where those differ, which the single-source cases cannot
 * reach because they load one layer at a time.
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

/** A static layer in the exported scene: its id, its cloud, and whether it renders. */
interface SceneLayer {
  readonly id: string;
  readonly cloud: typeof templeCloud;
  readonly visible?: boolean;
}

/**
 * The scan-report card stamped into an exported image, over a scene of static
 * layers plus an optional streaming source. Each layer carries the id the
 * provenance store records as the owner, so a case can hide the owning layer,
 * remove it, or leave two layers visible at once. The host carries the same
 * clouds the panel and the report describe, so a surface that classifies a cloud
 * itself has everything it needs to produce its own answer.
 */
function exportedImageCapture(
  layers: readonly SceneLayer[] = [],
  streamingCloud: { readonly kind: string; readonly sourcePointCount?: number } | null = null,
) {
  const entries = new Map(
    layers.map((l) => [
      l.id,
      { cloud: l.cloud, mode: 'rgb', visible: l.visible ?? true, placement: null },
    ]),
  );
  const host = {
    clouds: () => entries,
    streaming: () =>
      streamingCloud ? { cloud: streamingCloud, renderer: { colorMode: 'rgb' } } : null,
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

/** The one-layer scene: layer `id` is loaded, visible, and owns the store. */
const onlyLayer = (id: string, cloud: typeof templeCloud): SceneLayer[] => [{ id, cloud }];

beforeEach(() => {
  captureProvenance.clear();
});

describe('capture type: one verdict, every surface', () => {
  it('states ground-based on all three surfaces for a compact object', async () => {
    const p = panel();
    // Open order: the panel refreshes first, the shape router decides after.
    p.cards.refreshProvenance(templeCloud, 'a');
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    captureProvenance.setVerdict('object');

    const report = await reportProvenance(templeCloud);
    const image = exportedImageCapture(onlyLayer('a', templeCloud));

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
    p.cards.refreshProvenance(templeCloud, 'a');
    captureProvenance.setVerdict('interior');

    const report = await reportProvenance(templeCloud);
    const image = exportedImageCapture(onlyLayer('a', templeCloud));

    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
  });

  it('keeps the aerial verdict on all three surfaces for a terrain scan', async () => {
    const p = panel();
    p.cards.refreshProvenance(terrainCloud, 'a');
    captureProvenance.setVerdict('terrain');

    const report = await reportProvenance(terrainCloud);
    const image = exportedImageCapture(onlyLayer('a', terrainCloud));

    // The same density band as the temple, so this is the control that the
    // shape guard is applied by verdict rather than to every scan.
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
    expect(report?.confidence).toBe('medium');
  });

  it('follows a verdict that lands after the panel already rendered', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud, 'a');
    const atOpen = p.label();
    captureProvenance.setVerdict('object');
    expect(atOpen).toBe('Drone-mounted LiDAR (UAV ALS)');
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
  });

  it('follows a streaming re-route that changes the verdict mid-session', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud, 'a');
    captureProvenance.setVerdict('terrain');
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    captureProvenance.setVerdict('object');
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
  });
});

describe('capture type: a user override reaches the deliverables', () => {
  it('carries the override into the report PDF and the exported image', async () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud, 'a');
    captureProvenance.setVerdict('object');
    captureProvenance.setOverride('terrestrial');

    const report = await reportProvenance(templeCloud);
    const image = exportedImageCapture(onlyLayer('a', templeCloud));

    expect(p.label()).toBe('Terrestrial Laser Scan (TLS)');
    expect(report?.label).toBe(p.label());
    expect(image?.label).toBe(p.label());
    expect(report?.signals).toContain('User-overridden capture type');
  });

  it('drops the override when the next scan opens, and rebinds the owner', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud, 'a');
    captureProvenance.setOverride('spaceborne');
    expect(p.label()).toBe('Spaceborne LiDAR');
    p.cards.refreshProvenance(terrainCloud, 'b');
    expect(captureProvenance.override()).toBeNull();
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    // The store now describes layer 'b', so an image of 'b' carries the new
    // verdict and an image of 'a' carries none.
    expect(exportedImageCapture(onlyLayer('b', terrainCloud))?.label).toBe(p.label());
    expect(exportedImageCapture(onlyLayer('a', templeCloud))).toBeNull();
  });

  it('drops the previous scan verdict when the next scan opens', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud, 'a');
    captureProvenance.setVerdict('object');
    p.cards.refreshProvenance(terrainCloud, 'b');
    expect(captureProvenance.verdict()).toBeNull();
    expect(p.label()).toBe('Drone-mounted LiDAR (UAV ALS)');
    expect(exportedImageCapture(onlyLayer('a', templeCloud))).toBeNull();
  });
});

/**
 * Scope. The Inspector card and the report PDF describe the ACTIVE scan, which
 * is what they are for. The exported image describes the PIXELS, and
 * `exportAdapter` answers every other scene question (capabilities, counts,
 * bounds) over `visibleEntries()` for that reason.
 *
 * The two scopes come apart because static layers are additive
 * (`app/openScan.ts`) and the newest open becomes the active scan. Load a
 * terrain scan, then a temple: the store describes the temple. Hide the temple
 * and the image shows only terrain pixels while the store still answers
 * "ground-based". Remove the temple with its layer close control and the store
 * describes a scan that is no longer in the scene at all.
 *
 * The cases below drive scenes the single-source cases above cannot reach: two
 * layers, one of them hidden, and a layer removed. The rule under test is
 * conservative on purpose. Exactly one visible source that owns the stored
 * verdict states the capture type; anything else states nothing, which renders
 * as no Capture row. A per-source capture row is a separate feature.
 */
describe('capture type: the exported image is scene scoped', () => {
  /** Terrain opens first as layer 'a', the temple second as layer 'b' and active. */
  function twoLayerSession() {
    const p = panel();
    p.cards.refreshProvenance(terrainCloud, 'a');
    p.cards.refreshProvenance(templeCloud, 'b');
    captureProvenance.setVerdict('object');
    return p;
  }

  it('states nothing when the owning scan is hidden and an older scan shows', () => {
    const p = twoLayerSession();
    const image = exportedImageCapture([
      { id: 'a', cloud: terrainCloud },
      { id: 'b', cloud: templeCloud, visible: false },
    ]);
    // The panel keeps describing the active scan, which is correct for it.
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    // The image carries only terrain pixels, so it must not stamp the temple's
    // capture type.
    expect(image).toBeNull();
  });

  it('states nothing when two static scans are both visible', () => {
    const p = twoLayerSession();
    const image = exportedImageCapture([
      { id: 'a', cloud: terrainCloud },
      { id: 'b', cloud: templeCloud },
    ]);
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    expect(image).toBeNull();
  });

  it('drops a removed scan from every surface at once', () => {
    const p = twoLayerSession();
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    // The layer close control: `removeCloud` clears the store for the layer it
    // frees, so the freed scan cannot keep describing the session.
    captureProvenance.clearIf('b');
    expect(captureProvenance.fingerprint()).toBeNull();
    expect(p.label()).toBeNull();
    expect(exportedImageCapture(onlyLayer('a', terrainCloud))).toBeNull();
  });

  it('keeps the verdict when a layer that does not own it is removed', () => {
    const p = twoLayerSession();
    captureProvenance.clearIf('a');
    expect(p.label()).toBe('Ground-based scan — capture method not determined');
    expect(exportedImageCapture(onlyLayer('b', templeCloud))?.label).toBe(p.label());
  });

  it('states the capture type for a streaming source, which is the whole scene', () => {
    const p = panel();
    const streamingCloud = {
      kind: 'copc' as const,
      name: 'tile.copc.laz',
      sourcePointCount: 8_000_000,
    };
    p.cards.refreshProvenanceFromStreaming(streamingCloud);
    const image = exportedImageCapture([], streamingCloud);
    expect(p.label()).not.toBeNull();
    expect(image?.label).toBe(p.label());
  });
});

describe('capture type: no scan states nothing', () => {
  it('reports no fingerprint to any surface before a scan opens', () => {
    expect(captureProvenance.fingerprint()).toBeNull();
    expect(exportedImageCapture(onlyLayer('a', templeCloud))).toBeNull();
  });

  it('clears every surface when the scan closes', () => {
    const p = panel();
    p.cards.refreshProvenance(templeCloud, 'a');
    expect(p.label()).not.toBeNull();
    captureProvenance.clear();
    expect(p.label()).toBeNull();
    expect(exportedImageCapture(onlyLayer('a', templeCloud))).toBeNull();
  });
});
