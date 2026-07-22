/**
 * The export adapter's scene-reading contract.
 *
 * These behaviours previously lived inline in `Viewer._buildExportAdapter` and
 * could only be exercised through a real WebGL Viewer, so they were covered by
 * e2e alone. Extracting the adapter to take a structural host makes them
 * directly testable — the cases pinned here are the ones where the adapter has
 * to RECONCILE several clouds rather than read one value, which is where a
 * wrong answer would silently misplace an exported world file.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildExportAdapter } from '../src/render/exportAdapter';
import type { ExportAdapterHost, ExportAdapterCloud } from '../src/render/exportAdapter';

/** A static cloud entry — only the fields the adapter reads. */
function cloud(over: Record<string, unknown> = {}): ExportAdapterCloud {
  const cloudFields = {
    name: 'scan',
    pointCount: 100,
    bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
    origin: [10, 20, 0],
    metadata: undefined,
    ...over,
  };
  return {
    mode: 'rgb',
    cloud: {
      ...cloudFields,
      // A real PointCloud sets sourceOrigin from its load origin; the export
      // world frame reads sourceOrigin, so the mock must carry it too.
      sourceOrigin: cloudFields.origin,
    },
  } as unknown as ExportAdapterCloud;
}

function host(over: Partial<ExportAdapterHost> = {}): ExportAdapterHost {
  return {
    clouds: () => new Map<string, ExportAdapterCloud>(),
    streaming: () => null,
    setColorMode: vi.fn(),
    setStreamingColorMode: vi.fn(),
    snapshot: vi.fn(async () => new Blob()),
    renderFramedTopDown: vi.fn(async () => null),
    renderFigure: vi.fn(async () => null),
    figureViewContext: vi.fn(),
    ...over,
  } as ExportAdapterHost;
}

describe('export adapter — georeference honesty', () => {
  it('reports a world origin when every loaded cloud shares one frame', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ origin: [10, 20, 0], metadata: { crs: { wkt: 'WKT' } } })],
            ['b', cloud({ origin: [10, 20, 0] })],
          ]),
      }),
    );
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: 'WKT' });
  });

  it('refuses to georeference when two clouds disagree about their origin', () => {
    // The load-bearing case: picking either frame would place the raster
    // correctly for one cloud and silently misplace the other, so the honest
    // answer is no world file at all.
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ origin: [10, 20, 0] })],
            ['b', cloud({ origin: [90, 20, 0] })],
          ]),
      }),
    );
    expect(a.georefContext!()).toBeNull();
  });

  it('refuses when any cloud carries no origin at all', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ origin: [10, 20, 0] })], ['b', cloud({ origin: undefined })]]),
      }),
    );
    expect(a.georefContext!()).toBeNull();
  });

  it('reports nothing rather than an empty frame when no cloud is loaded', () => {
    expect(buildExportAdapter(host()).georefContext!()).toBeNull();
  });
});

describe('export adapter — point totals', () => {
  it('prefers a declared total over the strided count the loader displays', () => {
    // A huge cloud is strided for display; summing the strided `pointCount`
    // under-reports Points and inflates every density derived from it.
    const a = buildExportAdapter(
      host({
        clouds: () => new Map([['a', cloud({ pointCount: 1_000, declaredPointCount: 50_000 })]]),
      }),
    );
    expect(a.sourcePointCount()).toBe(50_000);
  });

  it('keeps the actual count when the declared total is not larger', () => {
    const a = buildExportAdapter(
      host({
        clouds: () => new Map([['a', cloud({ pointCount: 1_000, declaredPointCount: 800 })]]),
      }),
    );
    expect(a.sourcePointCount()).toBe(1_000);
  });

  it('sums across every loaded cloud', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ pointCount: 100 })], ['b', cloud({ pointCount: 250 })]]),
      }),
    );
    expect(a.sourcePointCount()).toBe(350);
  });

  it('treats every static point as resident', () => {
    const a = buildExportAdapter(
      host({ clouds: () => new Map([['a', cloud({ pointCount: 42 })]]) }),
    );
    expect(a.residentPointCount()).toBe(42);
  });
});

describe('export adapter — combined bounds', () => {
  it('folds every cloud into one AABB', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ bounds: () => ({ min: [0, 0, 0], max: [5, 5, 5] }) })],
            ['b', cloud({ bounds: () => ({ min: [-3, 1, 2], max: [4, 9, 3] }) })],
          ]),
      }),
    );
    expect(a.localBoundsAabb()).toEqual([-3, 0, 0, 5, 9, 5]);
  });

  it('returns null with nothing loaded, rather than an inverted infinite box', () => {
    expect(buildExportAdapter(host()).localBoundsAabb()).toBeNull();
  });
});

describe('export adapter — recolour resilience', () => {
  it('keeps recolouring the other clouds when one lacks the channel', () => {
    // A PLY without classification throws from setColorMode; without the
    // per-cloud guard that single throw left the scene half-recoloured.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const touched: string[] = [];
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud()], ['bad', cloud()], ['c', cloud()]]),
        setColorMode: (id) => {
          if (id === 'bad') throw new Error('no classification channel');
          touched.push(id);
        },
      }),
    );
    a.setExportColorMode('classification');
    expect(touched).toEqual(['a', 'c']);
    warn.mockRestore();
  });

  it('still drives the streaming subsystem after a static cloud throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setStreamingColorMode = vi.fn();
    const a = buildExportAdapter(
      host({
        clouds: () => new Map([['bad', cloud()]]),
        setColorMode: () => {
          throw new Error('nope');
        },
        setStreamingColorMode,
      }),
    );
    a.setExportColorMode('intensity');
    expect(setStreamingColorMode).toHaveBeenCalledWith('intensity');
    warn.mockRestore();
  });
});
