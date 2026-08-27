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
    mode: (over.mode as ExportAdapterCloud['mode']) ?? 'rgb',
    // Visible + unplaced by default; individual cases override to exercise the
    // WYSIWYG (hidden-layer) and placement folding paths.
    visible: over.visible ?? true,
    placement: over.placement ?? null,
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
    setVisible: vi.fn(),
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

  it('refuses when two clouds share an origin but declare different CRSs (C9)', () => {
    // Sharing a local grid origin is NOT sharing a coordinate system. Stamping
    // the first cloud's EPSG over a raster that also contains a differently-
    // projected cloud silently misplaces half the pixels, so refuse.
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ origin: [10, 20, 0], metadata: { crs: { epsg: 32612, wkt: 'WKT-A' } } })],
            ['b', cloud({ origin: [10, 20, 0], metadata: { crs: { epsg: 32613, wkt: 'WKT-B' } } })],
          ]),
      }),
    );
    expect(a.georefContext!()).toBeNull();
  });

  it('georeferences when two clouds share both origin and CRS (C9)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ origin: [10, 20, 0], metadata: { crs: { epsg: 32612, wkt: 'WKT' } } })],
            ['b', cloud({ origin: [10, 20, 0], metadata: { crs: { epsg: 32612, wkt: 'WKT' } } })],
          ]),
      }),
    );
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: 'WKT' });
  });

  it('a resolved LOCAL override does not resurrect the declared CRS into the .prj (C10)', () => {
    // The file DECLARES EPSG:32612 with a WKT, but the CRS authority resolves it
    // to Local (the user rejected it). With the resolver wired, the ortho must
    // NOT georeference — no WKT — rather than stamping the rejected CRS.
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ origin: [10, 20, 0], metadata: { crs: { epsg: 32612, wkt: 'DECLARED-WKT' } } })]]),
        resolveCloudCrs: () => ({ wkt: null, key: null, name: null, unit: null, epsg: null }),
      }),
    );
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: null });
  });

  it('uses the RESOLVED wkt (override applied), not the declared one (C10)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ origin: [10, 20, 0], metadata: { crs: { epsg: 32611, wkt: 'DECLARED-11N' } } })]]),
        // Authority resolved the override to 12N.
        resolveCloudCrs: () => ({ wkt: 'RESOLVED-12N', key: 'epsg:32612', name: 'UTM 12N', unit: 'm', epsg: 32612 }),
      }),
    );
    expect(a.georefContext!()).toEqual({ worldOrigin: { x: 10, y: 20 }, wkt: 'RESOLVED-12N' });
  });

  it('refuses when a visible local layer sits beside a projected one at the same origin (C10)', () => {
    // Two clouds share a sourceOrigin, but the user declared layer A Local
    // (unknown CRS) while layer B resolves to a projected EPSG. Stamping B's
    // .prj over the combined raster would misgeoreference A's pixels, which the
    // user explicitly said are NOT in that CRS — so refuse to georeference.
    const resolver = (c: unknown) =>
      (c as { name: string }).name === 'projected'
        ? { wkt: 'WKT-B', key: 'epsg:32612', name: 'UTM 12N', unit: 'm', epsg: 32612 }
        : { wkt: null, key: null, name: null, unit: null, epsg: null };
    // Both layer orderings: the local layer must force a conflict whether it is
    // seen before or after the projected one (guards the `wkt ??=` short-circuit).
    const localFirst = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ name: 'local', origin: [10, 20, 0] })],
            ['b', cloud({ name: 'projected', origin: [10, 20, 0] })],
          ]),
        resolveCloudCrs: resolver as ExportAdapterHost['resolveCloudCrs'],
      }),
    );
    const projectedFirst = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['b', cloud({ name: 'projected', origin: [10, 20, 0] })],
            ['a', cloud({ name: 'local', origin: [10, 20, 0] })],
          ]),
        resolveCloudCrs: resolver as ExportAdapterHost['resolveCloudCrs'],
      }),
    );
    expect(localFirst.georefContext!()).toBeNull();
    expect(projectedFirst.georefContext!()).toBeNull();
  });

  it('crsLabel reports the RESOLVED name/unit, not the declared metadata (1C)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ metadata: { crs: { epsg: 32611, name: 'DECLARED 11N', linearUnit: 'foot' } } })]]),
        resolveCloudCrs: () => ({ wkt: 'W', key: 'epsg:32612', name: 'UTM 12N', unit: 'metres', epsg: 32612 }),
      }),
    );
    // Label + unit come from the resolved CRS so the export report matches the .prj.
    expect(a.crsLabel!()).toEqual({ name: 'UTM 12N', unit: 'metres', epsg: 32612 });
  });

  it('crsLabel reports no CRS when resolved to local, though metadata declares one (1C)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ metadata: { crs: { epsg: 32611, name: 'DECLARED', linearUnit: 'metre' } } })]]),
        resolveCloudCrs: () => ({ wkt: null, key: null, name: null, unit: null, epsg: null }),
      }),
    );
    expect(a.crsLabel!()).toBeNull();
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

  it('resident count is the loaded points, NOT the back-scaled declared total (E8)', () => {
    // A strided load: 5M resident of a declared 100M. sourcePointCount reports
    // the declared total, but residentPointCount must report what is actually in.
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([['a', cloud({ pointCount: 5_000_000, declaredPointCount: 100_000_000 })]]),
      }),
    );
    expect(a.sourcePointCount()).toBe(100_000_000);
    expect(a.residentPointCount()).toBe(5_000_000);
  });
});

describe('export adapter — streaming capability gates', () => {
  const streamingHost = (modes: string[]) =>
    host({
      streaming: () =>
        ({
          cloud: {
            availableColorModes: () => modes,
            residentPointCount: 1,
            sourcePointCount: 1,
            name: 'stream',
          },
        }) as unknown as ReturnType<ExportAdapterHost['streaming']>,
    });

  it('reports intensity only when the streaming source actually exposes it (E9)', () => {
    // An EPT whose schema has no Intensity dimension must NOT enable the
    // Intensity exporter — the old `return true` did, then the recolor failed.
    expect(buildExportAdapter(streamingHost(['rgb', 'elevation'])).hasIntensity()).toBe(false);
    expect(buildExportAdapter(streamingHost(['rgb', 'intensity'])).hasIntensity()).toBe(true);
  });

  it('reports normals from the source, not from the format', () => {
    // `hasNormals` used to answer false for EVERY streaming source, on the
    // grounds that COPC and EPT carry none. A 3D Tiles tileset states a NORMAL
    // accessor per tile, so its source offers the `normal` mode once a tile has
    // stated one — and the Normal Map export was refused on a claim about the
    // format rather than about the data.
    expect(buildExportAdapter(streamingHost(['elevation', 'normal'])).hasNormals()).toBe(true);
  });

  it('keeps the Normal Map gate shut for a source that offers no normals', () => {
    // The COPC and EPT rows, and a tileset whose tiles state none: all three
    // report no `normal` mode, so all three stay exactly as shut as before.
    for (const modes of [
      ['rgb', 'intensity', 'elevation', 'classification'],
      ['rgb', 'elevation'],
      ['elevation'],
    ]) {
      expect(buildExportAdapter(streamingHost(modes)).hasNormals()).toBe(false);
    }
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

describe('export adapter — visible, placed scene (pass-7 #4/#5/#6/#7)', () => {
  it('excludes a hidden layer from combined bounds (WYSIWYG)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['vis', cloud({ bounds: () => ({ min: [0, 0, 0], max: [5, 5, 5] }) })],
            ['hid', cloud({ visible: false, bounds: () => ({ min: [900, 900, 0], max: [1000, 1000, 5] }) })],
          ]),
      }),
    );
    // The hidden layer 900 units away must not stretch the export frame.
    expect(a.localBoundsAabb()).toEqual([0, 0, 0, 5, 5, 5]);
  });

  it('folds a mounted layer placement into the bounds (#5)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ bounds: () => ({ min: [0, 0, 0], max: [100, 100, 10] }),
              placement: { sourceToProject: [1000, 0, 0] } })],
          ]),
      }),
    );
    // Rendered at +1000 in X, so the export camera must frame 1000..1100.
    expect(a.localBoundsAabb()).toEqual([1000, 0, 0, 1100, 100, 10]);
  });

  it('does not count a hidden layer toward source/resident points (#6)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['vis', cloud({ pointCount: 1_000 })],
            ['hid', cloud({ visible: false, pointCount: 100_000_000 })],
          ]),
      }),
    );
    expect(a.sourcePointCount()).toBe(1_000);
    expect(a.residentPointCount()).toBe(1_000);
  });

  it('does not let a HIDDEN classification layer enable the mode (#4)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['vis', cloud({ colors: new Uint8Array(3) })],
            ['hid', cloud({ visible: false, classification: new Uint8Array(1) })],
          ]),
      }),
    );
    expect(a.hasClassification()).toBe(false);
    expect(a.hasRgb()).toBe(true);
  });

  it('names the first VISIBLE layer, not the first registered (#7)', () => {
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['hid', cloud({ visible: false, name: 'hidden-first.laz' })],
            ['vis', cloud({ name: 'shown.laz' })],
          ]),
      }),
    );
    expect(a.sourceName()).toBe('shown.laz');
  });
});

describe('export adapter — per-layer colour-mode snapshot/restore (pass-7 #2)', () => {
  it('snapshots each layer independently and restores each to its own mode', () => {
    const setCalls: Array<[string, string]> = [];
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['a', cloud({ mode: 'rgb' })],
            ['b', cloud({ mode: 'intensity' })],
            ['c', cloud({ mode: 'classification' })],
          ]),
        setColorMode: (id, mode) => { setCalls.push([id, mode]); },
      }),
    );
    const snap = a.snapshotColorModes();
    expect(snap.staticModes.get('a')).toBe('rgb');
    expect(snap.staticModes.get('b')).toBe('intensity');
    expect(snap.staticModes.get('c')).toBe('classification');

    // Force a scientific mode across the scene, then restore.
    a.setExportColorMode('classification');
    setCalls.length = 0; // ignore the forcing calls; assert only the restore
    a.restoreColorModes(snap);

    // Each layer comes back to ITS OWN mode — not a single "prior" clobber.
    expect(setCalls).toEqual([['a', 'rgb'], ['b', 'intensity'], ['c', 'classification']]);
  });
});

describe('export adapter — excludeUnsupported (pass-7 #3)', () => {
  it('hides a visible layer that lacks the export channel, and restores it', () => {
    const vis = new Map<string, boolean>([['clsf', true], ['rgbOnly', true]]);
    const a = buildExportAdapter(
      host({
        clouds: () =>
          new Map([
            ['clsf', cloud({ visible: vis.get('clsf'), classification: new Uint8Array(1) })],
            ['rgbOnly', cloud({ visible: vis.get('rgbOnly'), colors: new Uint8Array(3) })],
          ]),
        setVisible: (id, v) => { vis.set(id, v); },
      }),
    );
    // A Classification export must exclude the RGB-only layer so the PNG is not
    // a mixed classification+RGB image (pass-7 #3).
    const hidden = a.excludeUnsupported('classification');
    expect(hidden).toEqual(['rgbOnly']);
    expect(vis.get('rgbOnly')).toBe(false);
    expect(vis.get('clsf')).toBe(true);

    a.restoreVisibility(hidden);
    expect(vis.get('rgbOnly')).toBe(true);
  });

  it('hides nothing for a universally-renderable mode (elevation)', () => {
    const a = buildExportAdapter(
      host({ clouds: () => new Map([['a', cloud({ colors: new Uint8Array(3) })]]) }),
    );
    expect(a.excludeUnsupported('elevation')).toEqual([]);
  });

  it('excludes nothing on the streaming path (single source, gated elsewhere)', () => {
    const a = buildExportAdapter(
      host({
        streaming: () =>
          ({ cloud: { availableColorModes: () => ['rgb'] } }) as unknown as ReturnType<ExportAdapterHost['streaming']>,
      }),
    );
    expect(a.excludeUnsupported('classification')).toEqual([]);
  });
});

describe('the scan-report card names what its figures cover', () => {
  /**
   * Every other figure on the card is answered over the visible entries: Points
   * sums them, the extent is their union, the CRS is the first that declares
   * one. The name was the exception and reported only the first visible layer,
   * so a card whose Points and extent covered three scans read as a card about
   * one of them.
   */
  /** An adapter over the given visible/hidden named layers. */
  function named(entries: readonly { id: string; name: string; visible?: boolean }[]) {
    return buildExportAdapter(
      host({
        clouds: () =>
          new Map(entries.map((e) => [e.id, cloud({ name: e.name, visible: e.visible ?? true })])),
      }),
    );
  }

  it('names the layer when one is visible', () => {
    expect(named([{ id: 'a', name: 'north.las' }]).sourceName()).toBe('north.las');
  });

  it('says how many more when several are visible', () => {
    const adapter = named([
      { id: 'a', name: 'north.las' },
      { id: 'b', name: 'south.las' },
      { id: 'c', name: 'east.las' },
    ]);
    expect(adapter.sourceName()).toBe('north.las + 2 more');
  });

  it('counts only the visible layers, which is what the figures cover', () => {
    const adapter = named([
      { id: 'a', name: 'north.las' },
      { id: 'b', name: 'south.las', visible: false },
    ]);
    expect(adapter.sourceName()).toBe('north.las');
  });

  it('agrees with the point total, which sums the same set', () => {
    // The two answers describe one scene, so a card that names one layer beside
    // a total for three is the defect this pins.
    const adapter = named([
      { id: 'a', name: 'north.las' },
      { id: 'b', name: 'south.las' },
    ]);
    expect(adapter.sourceName()).toMatch(/\+ 1 more$/);
    expect(adapter.sourcePointCount()).toBe(200);
  });

  it('falls back to a placeholder with nothing visible', () => {
    expect(named([]).sourceName()).toBe('scan');
  });
});
