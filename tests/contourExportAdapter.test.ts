/**
 * contourExportAdapter.test.ts
 *
 * Integration test for the export ORCHESTRATION (audit follow-up): drive the
 * ContourExportAdapter with a fake host + button and assert that a click routes
 * through the §19 permit to the RIGHT exporter — a granted product mints a
 * permit and calls its exporter (stamped where the writer takes a stamp), and a
 * blocked launch state writes nothing and flashes the button. EVERY Studio
 * product (vectors, map PDF, DEM package, complete deliverable, terrain report)
 * now routes through the one resolver. This is the seam the panel wiring
 * depends on, proven end-to-end without a DOM.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContourExportAdapter, type ContourExportHost } from '../src/ui/contourExportAdapter';
import { POLITE_REGION_SELECTOR } from '../src/ui/politeAnnounce';
import type { ContourExportIntent } from '../src/terrain/contourStudio/contourExportIntent';
import type { ContourExportFrameFacts, ContourExportPermit } from '../src/export/contourExportPermit';
import type { ContourStudioExportProduct } from '../src/ui/contourStudioMount';

/** A recording host — every call is captured for assertion. */
function fakeHost() {
  const calls = {
    vector: [] as Array<{ fmt: string; permit: ContourExportPermit; contourMethod?: string; deliverablePurpose?: string }>,
    mapPdf: [] as ContourExportPermit[],
    dem: [] as Array<{ status: string } | null>,
    complete: [] as ContourExportPermit[],
    report: [] as Array<{ status: string; watermark: string | null } | null>,
    styles: [] as string[],
  };
  const host: ContourExportHost = {
    setContourStyle: (s) => { calls.styles.push(s); },
    exportVector: async (fmt, opts) => {
      calls.vector.push({ fmt, permit: opts.permit, contourMethod: opts.contourMethod, deliverablePurpose: opts.deliverablePurpose });
    },
    openMapPdf: (permit) => { calls.mapPdf.push(permit); },
    exportDemPackage: async (stamp) => { calls.dem.push(stamp ? { status: stamp.status } : null); },
    exportCompletePackage: async (permit) => { calls.complete.push(permit); },
    exportTerrainReport: async (stamp) => {
      calls.report.push(stamp ? { status: stamp.status, watermark: stamp.watermark } : null);
    },
  };
  return { host, calls };
}

const btn = (): HTMLButtonElement =>
  ({ textContent: 'Export', disabled: false } as unknown as HTMLButtonElement);

const intent = (over: Partial<ContourExportIntent> = {}): ContourExportIntent => ({
  purpose: 'Survey Review',
  shapeStyle: 'crisp',
  generalizeToleranceCells: 0,
  generalizeMode: 'uniform',
  labelsIndexOnly: false,
  methodId: 'olv.contour.analytical',
  methodVersion: 1,
  methodTag: 'olv.contour.analytical@1',
  deliverable: {
    label: 'Survey Review',
    statement: 'Exact analytical geometry.',
    analytical: true,
    cartographic: false,
    cartographicSmoothing: false,
    generalizeToleranceCells: 0,
    indexEvery: 5,
    labelsIndexOnly: true,
    hillshade: false,
    hypsometricTint: false,
    allowExploratory: false,
    completePackage: false,
    appendixRequired: true,
  },
  ...over,
});

/** A fully-supported frame (available + known unit + projected). */
const okFrame: ContourExportFrameFacts = {
  launchStatus: 'available',
  verticalUnitsKnown: true,
  crsProjected: true,
  precision: null,
};

/**
 * Drive `handle()` for `product` with a blocked launch state and assert the
 * common refusal shape — nothing is written, the button flashes "Blocked",
 * then the flash's own timer restores it. `assertNoCalls` adds the
 * product-specific "nothing else fired" checks.
 */
function expectBlockedFlash(
  product: ContourStudioExportProduct,
  blockedReasons: string[],
  assertNoCalls: (calls: ReturnType<typeof fakeHost>['calls']) => void,
): void {
  vi.useFakeTimers();
  const { host, calls } = fakeHost();
  const b = btn();
  new ContourExportAdapter(host).handle(product, b, intent(), {
    launchStatus: 'unavailable',
    verticalUnitsKnown: true,
    crsProjected: true,
    precision: null,
    blockedReasons,
  });
  assertNoCalls(calls);
  expect(b.textContent).toBe('Blocked');
  expect(b.disabled).toBe(true);
  // The flash restores the button once the timer elapses (no open handle left).
  vi.runAllTimers();
  expect(b.textContent).toBe('Export');
  expect(b.disabled).toBe(false);
  vi.useRealTimers();
}

/**
 * Drive `handle()` for `product` against a host whose writer for it rejects,
 * and assert the common failure shape: the button flashes "Export failed"
 * (never a silent revert), then its own timer restores it. `withFailingHost`
 * supplies the one rejecting override; `expectConsoleError` covers the
 * vector export test, the only one that also pins the failure reaching
 * `console.error`.
 */
async function expectExportFailureFlash(
  product: ContourStudioExportProduct,
  withFailingHost: (host: ContourExportHost) => ContourExportHost,
  options: { expectConsoleError?: boolean } = {},
): Promise<void> {
  vi.useFakeTimers();
  const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { host } = fakeHost();
  const b = btn();
  new ContourExportAdapter(withFailingHost(host)).handle(product, b, intent(), okFrame);
  // Let the rejected microtask land before asserting the flash.
  await vi.advanceTimersByTimeAsync(0);
  expect(b.textContent, 'a silent revert leaves the user with no signal the export failed').toBe('Export failed');
  expect(b.disabled).toBe(true);
  if (options.expectConsoleError) expect(consoleErr).toHaveBeenCalled();
  vi.runAllTimers();
  expect(b.textContent).toBe('Export');
  expect(b.disabled).toBe(false);
  vi.useRealTimers();
  consoleErr.mockRestore();
}

describe('ContourExportAdapter — gated dispatch', () => {
  it('routes a granted analytical GeoJSON through the permit to the vector exporter', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('geojson', btn(), intent(), okFrame);
    expect(calls.vector).toHaveLength(1);
    expect(calls.vector[0].fmt).toBe('geojson');
    expect(calls.vector[0].permit.ok).toBe(true);
    expect(calls.vector[0].permit.exporterId).toBe('contour.geojson.analytical');
    // The purpose provenance is threaded into the export.
    expect(calls.vector[0].contourMethod).toBe('olv.contour.analytical@1');
    expect(calls.vector[0].deliverablePurpose).toBe('Survey Review');
    // Nothing else fired.
    expect(calls.mapPdf).toHaveLength(0);
    expect(calls.dem).toHaveLength(0);
    expect(calls.report).toHaveLength(0);
    // The geometry style was adopted from the intent.
    expect(calls.styles).toEqual(['crisp']);
  });

  it('mints the cartographic exporter for a generalized SVG (never analytical)', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle(
      'svg', btn(),
      intent({ shapeStyle: 'generalized', methodId: 'olv.contour.generalize.terrain-adaptive', methodTag: 'olv.contour.generalize.terrain-adaptive@1', purpose: 'Presentation Map' }),
      okFrame,
    );
    expect(calls.vector[0].fmt).toBe('svg');
    expect(calls.vector[0].permit.exporterId).toBe('contour.svg.cartographic');
  });

  it('sends the map PDF to openMapPdf with a granted permit (no vector export)', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('pdf', btn(), intent(), okFrame);
    expect(calls.mapPdf).toHaveLength(1);
    expect(calls.mapPdf[0].ok).toBe(true);
    expect(calls.vector).toHaveLength(0);
  });

  it('writes NOTHING and flashes the button when the launch state is blocked', () => {
    expectBlockedFlash('geojson', ['No usable ground points.'], (calls) => {
      expect(calls.vector).toHaveLength(0);
      expect(calls.mapPdf).toHaveLength(0);
    });
  });

  it('routes the DEM package through the resolver (DTM claim) and stamps the permit', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('package', btn(), intent(), okFrame);
    expect(calls.dem).toHaveLength(1);
    // A supported frame mints a granted permit → a stamp is threaded to the DEM.
    expect(calls.dem[0]).not.toBeNull();
    expect(['validated', 'exploratory']).toContain(calls.dem[0]!.status);
    expect(calls.vector).toHaveLength(0);
  });

  it('refuses the DEM package (writes nothing) when the launch state is blocked', () => {
    expectBlockedFlash('package', ['No terrain surface has been computed.'], (calls) => {
      expect(calls.dem).toHaveLength(0);
    });
  });

  it('routes the complete deliverable through the resolver with a granted permit', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('deliverable', btn(), intent(), okFrame);
    expect(calls.complete).toHaveLength(1);
    expect(calls.complete[0].ok).toBe(true);
    if (calls.complete[0].ok) expect(calls.complete[0].exporterId).toBe('contour.package');
    expect(calls.dem).toHaveLength(0);
    expect(calls.vector).toHaveLength(0);
  });

  it('refuses the complete deliverable (writes nothing) when the launch state is blocked', () => {
    expectBlockedFlash('deliverable', ['No terrain surface has been computed.'], (calls) => {
      expect(calls.complete).toHaveLength(0);
    });
  });

  it('routes the terrain report through the resolver and stamps the permit', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('report', btn(), intent(), okFrame);
    expect(calls.report).toHaveLength(1);
    // A supported frame mints a granted permit → its stamp reaches the writer.
    expect(calls.report[0]).not.toBeNull();
    expect(['validated', 'exploratory']).toContain(calls.report[0]!.status);
    expect(calls.dem).toHaveLength(0);
    expect(calls.vector).toHaveLength(0);
  });

  it('marks the terrain report exploratory (watermarked stamp) when the vertical unit is unknown', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('report', btn(), intent(), {
      launchStatus: 'available',
      verticalUnitsKnown: false, // cartographic-only ⇒ exploratory
      precision: null,
      crsProjected: true,
    });
    expect(calls.report).toHaveLength(1);
    expect(calls.report[0]!.status).toBe('exploratory');
    expect(calls.report[0]!.watermark).toBeTruthy();
  });

  it('refuses the terrain report (never calls the writer) when the launch state is blocked', () => {
    expectBlockedFlash('report', ['No terrain surface has been computed.'], (calls) => {
      expect(calls.report).toHaveLength(0);
    });
  });

  it('flashes "Export failed" and restores the button when the host rejects a vector export (ANALYSIS-F3 / OUTPUT-F2)', async () => {
    await expectExportFailureFlash(
      'geojson',
      (host) => ({ ...host, exportVector: async () => { throw new Error('chunk load failed'); } }),
      { expectConsoleError: true },
    );
  });

  it('flashes "Export failed" and restores the button when the host rejects the DEM package', async () => {
    await expectExportFailureFlash('package', (host) => ({
      ...host,
      exportDemPackage: async () => { throw new Error('chunk load failed'); },
    }));
  });

  it('flashes "Export failed" and restores the button when the host rejects the complete deliverable', async () => {
    await expectExportFailureFlash('deliverable', (host) => ({
      ...host,
      exportCompletePackage: async () => { throw new Error('write failed'); },
    }));
  });

  it('flashes "Export failed" and restores the button when the host rejects the terrain report', async () => {
    await expectExportFailureFlash('report', (host) => ({
      ...host,
      exportTerrainReport: async () => { throw new Error('chunk load failed'); },
    }));
  });

  it('announces the "Export failed" flash through the app\'s polite live region, not the button alone', async () => {
    // A sighted user watching the button sees the flash; a screen-reader user
    // whose focus is elsewhere (still reviewing the Studio's product picker,
    // say) hears nothing from a plain textContent/disabled mutation. This
    // proves the failure reaches the SAME region every other async failure in
    // this app announces through (politeAnnounce.ts), not a bespoke node.
    vi.useFakeTimers();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host } = fakeHost();
    const region = { textContent: 'stale' };
    const b = {
      ...btn(),
      ownerDocument: { querySelector: (s: string) => (s === POLITE_REGION_SELECTOR ? region : null) },
    } as unknown as HTMLButtonElement;
    const failing: ContourExportHost = { ...host, exportVector: async () => { throw new Error('chunk load failed'); } };
    new ContourExportAdapter(failing).handle('geojson', b, intent(), okFrame);
    await vi.advanceTimersByTimeAsync(0);
    expect(region.textContent).toBe('Contour export failed. Try again.');
    vi.runAllTimers();
    vi.useRealTimers();
    consoleErr.mockRestore();
  });

  it('does not throw when the pressed button carries no ownerDocument (non-DOM host)', async () => {
    // The four `btn()` fakes used throughout this file (and, historically, a
    // production HTMLButtonElement stub in tests elsewhere) have no
    // `ownerDocument`. The live-region lookup must degrade to a no-op rather
    // than reaching for a bare `document` global this file's environment
    // (vitest.config.ts `environment: 'node'`) never provides.
    vi.useFakeTimers();
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { host } = fakeHost();
    const b = btn();
    const failing: ContourExportHost = { ...host, exportVector: async () => { throw new Error('chunk load failed'); } };
    expect(() => new ContourExportAdapter(failing).handle('geojson', b, intent(), okFrame)).not.toThrow();
    await expect(vi.advanceTimersByTimeAsync(0)).resolves.not.toThrow();
    vi.runAllTimers();
    vi.useRealTimers();
    consoleErr.mockRestore();
  });

  it('caps to an exploratory (still granted) permit when the vertical unit is unknown', () => {
    const { host, calls } = fakeHost();
    new ContourExportAdapter(host).handle('dxf', btn(), intent(), {
      launchStatus: 'available',
      verticalUnitsKnown: false, // cartographic-only ⇒ exploratory
      precision: null,
      crsProjected: true,
    });
    expect(calls.vector).toHaveLength(1);
    expect(calls.vector[0].permit.ok).toBe(true);
    if (calls.vector[0].permit.ok) {
      expect(calls.vector[0].permit.decision.status).toBe('exploratory');
    }
  });
});
