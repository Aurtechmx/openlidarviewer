import { describe, it, expect, vi } from 'vitest';
import {
  importSession,
  scanFactsFromStreaming,
  scanFactsFromStatic,
  MAX_SESSION_BYTES,
  type SessionIoDeps,
  type SessionModule,
  type StaticScanCloud,
} from '../src/app/sessionIo';
import {
  serializeSession,
  parseSession,
  rebaseSessionGeometry,
  matchSessionToScan,
  detectSessionSpatialConflict,
} from '../src/io/session';
import type { InspectionSession, SessionScanSummary } from '../src/io/session';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Viewer } from '../src/render/Viewer';
import type { Measurement, Vec3 } from '../src/render/measure/types';

// The build version the deps advertise; sessions are stamped with the SAME
// string so the stale-export disclosure stays quiet except where a test wants it.
const CURRENT = '0.6.3';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

// importSession only calls file.text(); a plain object is enough and avoids
// depending on a Node `File` global.
const asFile = (text: string): File => ({ text: async () => text }) as unknown as File;

const realSessionModule: SessionModule = {
  parseSession,
  rebaseSessionGeometry,
  matchSessionToScan,
  detectSessionSpatialConflict,
};

type LinearUnit = 'metre' | 'foot' | 'us-survey-foot' | 'unknown';

interface StreamingOpts {
  name: string;
  sourcePointCount: number;
  dataBounds: readonly [number, number, number, number, number, number];
  crs?: { name?: string; epsg?: number; linearUnit?: LinearUnit } | null;
}

interface StaticOpts {
  name: string;
  scanId: string;
  pointCount: number;
  bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  sourceFormat: string;
  crs?: { name?: string; epsg?: number; linearUnit?: LinearUnit } | null;
}

/**
 * Build a SessionIoDeps wired to spies, plus the spies themselves. A `streaming`
 * option supplies a fake streaming cloud (so `haveCloud` is true and the
 * scan-identity match runs); with none, the scene is empty.
 */
function makeDeps(
  over: {
    streaming?: StreamingOpts;
    static?: StaticOpts;
    origin?: readonly [number, number, number];
    appVersion?: string;
  } = {},
) {
  const loadMeasurements = vi.fn();
  const loadAnnotations = vi.fn();
  const restore = vi.fn();
  const setInspectorViews = vi.fn();
  const refreshMeasurePanel = vi.fn();
  const refreshAnnotationPanel = vi.fn();
  const applyViewState = vi.fn();
  const setCrsOverride = vi.fn();
  const showToast = vi.fn();
  const setDropError = vi.fn();

  const streamingCloud = over.streaming
    ? {
        name: over.streaming.name,
        sourcePointCount: over.streaming.sourcePointCount,
        dataBounds: () => over.streaming!.dataBounds,
        crs: () => over.streaming!.crs ?? null,
      }
    : null;

  const staticCloud = over.static
    ? {
        name: over.static.name,
        pointCount: over.static.pointCount,
        bounds: () => over.static!.bounds,
        sourceFormat: over.static.sourceFormat,
        metadata: { crs: over.static.crs ?? null },
      }
    : null;

  const viewer = {
    clouds: () => (over.static ? [over.static.scanId] : ([] as string[])),
    hasStreamingCloud: over.streaming != null,
    streamingCloud,
    getCloud: (id: string) => (over.static && id === over.static.scanId ? staticCloud : undefined),
    measure: { loadMeasurements },
    annotate: { loadAnnotations },
  };

  const deps: SessionIoDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    loadSession: async () => realSessionModule,
    appVersion: over.appVersion ?? CURRENT,
    getActiveScanId: () => over.static?.scanId ?? null,
    getActiveCloud: () => (staticCloud as unknown as import('../src/model/PointCloud').PointCloud | null),
    exportOrigin: () => over.origin ?? [0, 0, 0],
    bookmarks: { restore, names: () => ['V1'] },
    setInspectorViews,
    refreshMeasurePanel,
    refreshAnnotationPanel,
    applyViewState,
    setCrsOverride,
    showToast,
    setDropError,
  };

  return {
    deps,
    calls: {
      loadMeasurements,
      loadAnnotations,
      restore,
      setInspectorViews,
      refreshMeasurePanel,
      refreshAnnotationPanel,
      applyViewState,
      setCrsOverride,
      showToast,
      setDropError,
    },
  };
}

function sessionJson(
  over: Partial<Omit<InspectionSession, 'app' | 'kind' | 'version'>> = {},
): string {
  const measurements: Measurement[] = [
    { id: 'a', kind: 'distance', name: 'D1', points: [p(0, 0, 0), p(1, 0, 0)] },
  ];
  return serializeSession({
    upAxis: 'z',
    origin: [0, 0, 0],
    unitSystem: 'metric',
    views: [{ name: 'V1', camera: { position: p(1, 2, 3), target: p(4, 5, 6), mode: 'orbit' } }],
    measurements,
    annotations: [],
    software: CURRENT,
    ...over,
  });
}

const summary = (over: Partial<SessionScanSummary> = {}): SessionScanSummary => ({
  fileName: 'loaded.laz',
  sourcePoints: 1000,
  width: 10,
  depth: 10,
  height: 3,
  ...over,
});

describe('scanFactsFromStreaming — pure cloud→fingerprint adapter', () => {
  it('derives extent spans from dataBounds and copies name / points / CRS', () => {
    const facts = scanFactsFromStreaming({
      name: 'scan.laz',
      sourcePointCount: 1000,
      dataBounds: () => [0, 0, 0, 10, 20, 3],
      crs: () => ({ name: 'UTM 13N', epsg: 32613 }),
    });
    expect(facts).toEqual({
      fileName: 'scan.laz',
      sourcePoints: 1000,
      width: 10,
      depth: 20,
      height: 3,
      crs: 'UTM 13N',
      epsg: 32613,
    });
  });

  it('leaves crs / epsg undefined when the source declares no CRS', () => {
    const facts = scanFactsFromStreaming({
      name: 'x',
      sourcePointCount: 5,
      dataBounds: () => [1, 2, 3, 4, 6, 9],
      crs: () => null,
    });
    expect(facts).toMatchObject({ width: 3, depth: 4, height: 6 });
    expect(facts.crs).toBeUndefined();
    expect(facts.epsg).toBeUndefined();
  });
});

describe('scanFactsFromStatic — pure cloud→fingerprint adapter', () => {
  it('derives extent spans from bounds and reads CRS from header metadata', () => {
    const facts = scanFactsFromStatic({
      name: 'a.las',
      pointCount: 42,
      bounds: () => ({ min: [0, 0, 0], max: [5, 7, 2] }),
      metadata: { crs: { name: 'NAD83', epsg: 26913 } },
    });
    expect(facts).toEqual({
      fileName: 'a.las',
      sourcePoints: 42,
      width: 5,
      depth: 7,
      height: 2,
      crs: 'NAD83',
      epsg: 26913,
    });
  });

  it('leaves crs / epsg undefined when metadata is absent', () => {
    const facts = scanFactsFromStatic({
      name: 'a',
      pointCount: 1,
      bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
    });
    expect(facts.crs).toBeUndefined();
    expect(facts.epsg).toBeUndefined();
  });

  // Identity must be SOURCE-stable: the same file loaded at a different point
  // budget / decode stride on another device has to fingerprint identically.
  // `pointCount` (and the `bounds()` taken over the held sample) are the
  // device-variant fields; `declaredPointCount` is the header's own total and
  // survives stride / voxel downsample. These two fixtures are the SAME source
  // file and differ ONLY in the display-sampled fields.
  const HEADER_COUNT = 1_000_000;
  const denseLoad: StaticScanCloud = {
    name: 'survey.las',
    pointCount: 500_000, // ~stride 2 under a desktop budget
    declaredPointCount: HEADER_COUNT,
    decodedPointCount: 500_000,
    // more points held → the sampled AABB reaches closer to the true extremes
    bounds: () => ({ min: [0, 0, 0], max: [99.8, 49.9, 12.4] }),
  };
  const sparseLoad: StaticScanCloud = {
    name: 'survey.las',
    pointCount: 100_000, // ~stride 10 under a mobile budget
    declaredPointCount: HEADER_COUNT,
    decodedPointCount: 100_000,
    // fewer points held → the sampled extremes fall short of the true extent
    bounds: () => ({ min: [0, 0, 0], max: [99.1, 49.4, 12.1] }),
  };

  it('fingerprints the same source identically across load stride / point budget', () => {
    const dense = scanFactsFromStatic(denseLoad);
    const sparse = scanFactsFromStatic(sparseLoad);
    // Source truth from the header, not the held sample — so it does NOT move
    // with the device budget. (Matches the streaming sibling's sourcePointCount.)
    expect(dense.sourcePoints).toBe(HEADER_COUNT);
    expect(sparse.sourcePoints).toBe(HEADER_COUNT);
    expect(dense.sourcePoints).toBe(sparse.sourcePoints);
  });

  it('prefers the pre-downsample decode count when the header count is absent', () => {
    // A format that carries no declared header total (e.g. PLY) still exposes
    // what the decoder read before voxel downsample — better than the reduced
    // held count. Ladder: declaredPointCount ?? decodedPointCount ?? pointCount.
    const facts = scanFactsFromStatic({
      name: 'mesh.ply',
      pointCount: 40_000, // held after voxel downsample
      decodedPointCount: 90_000, // survived the downsample
      bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
    });
    expect(facts.sourcePoints).toBe(90_000);
  });

  it('falls back to the held point count when no source count is known, without throwing', () => {
    const facts = scanFactsFromStatic({
      name: 'bare',
      pointCount: 7,
      bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
    });
    expect(facts.sourcePoints).toBe(7);
  });

  it('leaves width/depth/height on the DECIMATED bounds — a documented residual', () => {
    // A source/header extent is NOT reachable here: the LAS/LAZ header min/max
    // are read at load but consumed for the origin and never persisted onto the
    // cloud, and adding that plumbing across every loader is out of scope. So
    // extents still track the display sample and legitimately differ across
    // devices — pinned here so a future exact-match fingerprint compares extents
    // with a tolerance (as matchSessionToScan does), never equality, while the
    // count stays source-stable.
    const dense = scanFactsFromStatic(denseLoad);
    const sparse = scanFactsFromStatic(sparseLoad);
    expect(dense.width).not.toBe(sparse.width);
    expect(dense.depth).not.toBe(sparse.depth);
    expect(dense.height).not.toBe(sparse.height);
    // ...even though the count is identical for the two loads.
    expect(dense.sourcePoints).toBe(sparse.sourcePoints);
  });
});

describe('importSession — malformed / wrong-shape input routes to the drop zone', () => {
  it('reports invalid JSON without touching the scene', async () => {
    const { deps, calls } = makeDeps();
    await importSession(asFile('not json{'), {}, deps);
    expect(calls.setDropError).toHaveBeenCalledWith('This file is not valid JSON.');
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
  });

  it('rejects a file that is not an OpenLiDARViewer session', async () => {
    const { deps, calls } = makeDeps();
    await importSession(asFile(JSON.stringify({ app: 'Other', kind: 'x', version: 7 })), {}, deps);
    expect(calls.setDropError).toHaveBeenCalledWith('This file is not an OpenLiDARViewer session.');
  });

  it('rejects an unsupported session version', async () => {
    const { deps, calls } = makeDeps();
    await importSession(
      asFile(JSON.stringify({ app: 'OpenLiDARViewer', kind: 'measurement-session', version: 999 })),
      {},
      deps,
    );
    expect(calls.setDropError).toHaveBeenCalledWith('Unsupported session version: 999.');
  });
});

describe('importSession — restore with no cloud loaded', () => {
  it('applies the verbatim geometry and tells the user to drop the source scan', async () => {
    const { deps, calls } = makeDeps();
    await importSession(
      asFile(sessionJson({ scanSummary: summary({ fileName: 'survey.las' }) })),
      {},
      deps,
    );
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.loadMeasurements.mock.calls[0][0]).toHaveLength(1);
    expect(calls.loadAnnotations).toHaveBeenCalledWith([]);
    expect(calls.restore).toHaveBeenCalledTimes(1);
    expect(calls.setInspectorViews).toHaveBeenCalledWith(['V1']);
    expect(calls.applyViewState).toHaveBeenCalledTimes(1);
    const msg = calls.showToast.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('survey.las');
    expect(msg).toContain('drop');
  });

  it('summarises the restored item count when the session names no scan', async () => {
    const { deps, calls } = makeDeps();
    await importSession(asFile(sessionJson()), {}, deps);
    // 1 measurement + 0 annotations + 1 view = 2 items.
    expect(calls.showToast).toHaveBeenCalledWith(expect.stringContaining('Session restored — 2 items'));
  });

  it('discloses a stale producing version', async () => {
    const { deps, calls } = makeDeps({ appVersion: '0.7.0' });
    await importSession(asFile(sessionJson({ software: '0.6.0' })), {}, deps);
    expect(calls.showToast).toHaveBeenCalledWith(expect.stringContaining('generated by v0.6.0'));
  });
});

describe('importSession — scan-identity gate against a loaded cloud', () => {
  const loadedStreaming: StreamingOpts = {
    name: 'loaded.laz',
    sourcePointCount: 1000,
    dataBounds: [0, 0, 0, 10, 10, 3],
  };

  it('refuses a session captured over a different scan (extents conflict)', async () => {
    const { deps, calls } = makeDeps({ streaming: loadedStreaming });
    await importSession(
      asFile(sessionJson({ scanSummary: summary({ width: 100, depth: 100 }) })),
      {},
      deps,
    );
    expect(calls.showToast).toHaveBeenCalledWith(expect.stringContaining('different scan'));
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
  });

  it('applies a strong match and discloses a geometry realignment', async () => {
    // Extents match (strong verdict); the export origin differs from the
    // session origin, so the rebase shifts geometry and the toast says so.
    const { deps, calls } = makeDeps({ streaming: loadedStreaming, origin: [10, 0, 0] });
    await importSession(
      asFile(sessionJson({ origin: [0, 0, 0], scanSummary: summary() })),
      {},
      deps,
    );
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.showToast).toHaveBeenCalledWith(expect.stringContaining('realigned'));
  });

  it('holds a partial match behind an "Apply anyway" confirmation, then applies on skip', async () => {
    // Extents match tightly but the point count moved → partial, not strong.
    const partialStreaming: StreamingOpts = { ...loadedStreaming, sourcePointCount: 2000 };
    const { deps, calls } = makeDeps({ streaming: partialStreaming });
    const file = asFile(sessionJson({ scanSummary: summary({ sourcePoints: 1000 }) }));

    await importSession(file, {}, deps);
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
    const confirm = calls.showToast.mock.calls.find((c) => c[1]?.label === 'Apply anyway');
    expect(confirm).toBeTruthy();

    // The confirmation re-runs the same restore with the check skipped.
    await importSession(file, { skipScanConfirm: true }, deps);
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.showToast).toHaveBeenCalledWith(
      expect.stringContaining('Applied despite an unverified scan match'),
    );
  });
});

describe('importSession — per-scan spatial-metadata guard (roadmap P1 #5)', () => {
  // A resolved CRS the session carries; the serializer/parser round-trips it and
  // the restore tries to re-apply it as the author's override.
  const resolvedCrs = (over: Partial<ResolvedCrs> = {}): ResolvedCrs => ({
    kind: 'projected',
    name: 'NAD83 / UTM 13N',
    epsg: 32613,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'las-vlr',
    confidence: 'high',
    userConfirmed: true,
    ...over,
  });

  // Extents match SCAN_A so the scan-identity gate returns a STRONG verdict and
  // the restore reaches the spatial-metadata block. The summary carries NO epsg,
  // so the identity gate can't conflict on CRS — that is precisely the hole this
  // guard closes: a scan whose CRS declaration exists but wasn't in the summary.
  const strongStreaming = (crs?: { epsg?: number; linearUnit?: LinearUnit }): StreamingOpts => ({
    name: 'loaded.laz',
    sourcePointCount: 1000,
    dataBounds: [0, 0, 0, 10, 10, 3],
    crs: crs ?? null,
  });
  const strongSummary = () => summary({ width: 10, depth: 10, height: 3, sourcePoints: 1000 });

  it('REFUSES the whole restore when the file declares a DIFFERENT EPSG (no geometry under the wrong frame)', async () => {
    const { deps, calls } = makeDeps({ streaming: strongStreaming({ epsg: 32614 }) });
    await importSession(
      asFile(sessionJson({ crs: resolvedCrs({ epsg: 32613 }), scanSummary: strongSummary() })),
      {},
      deps,
    );
    // FIX A: a hard spatial conflict is validated in the preflight now, BEFORE
    // any mutation, so nothing is attached (measurements included) — it is not
    // restored-then-disclosed. The scan-identity gate saw a strong extents match
    // (the summary carried no EPSG); the resolved CRS-code divergence is the
    // conflict, and it refuses rather than realigning geometry onto the wrong
    // frame — the same stance the identity gate takes on a differing summary EPSG.
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
    expect(calls.setCrsOverride).not.toHaveBeenCalled();
    const warn = calls.showToast.mock.calls.map((c) => c[0] as string).find((m) => /conflicts with this scan/.test(m));
    expect(warn).toBeTruthy();
    expect(warn).toMatch(/EPSG:32613/);
    expect(warn).toMatch(/EPSG:32614/);
  });

  it('applies the session CRS when it AGREES with the file', async () => {
    const { deps, calls } = makeDeps({ streaming: strongStreaming({ epsg: 32613 }) });
    await importSession(
      asFile(sessionJson({ crs: resolvedCrs({ epsg: 32613 }), scanSummary: strongSummary() })),
      {},
      deps,
    );
    expect(calls.setCrsOverride).toHaveBeenCalledTimes(1);
    expect(calls.setCrsOverride.mock.calls[0][0].override).toMatchObject({ epsg: 32613 });
    expect(calls.showToast.mock.calls.every((c) => !/conflicts with this scan/.test(c[0] as string))).toBe(true);
  });

  it('keeps the file’s CRS when the session declares none — no override, no conflict', async () => {
    const { deps, calls } = makeDeps({ streaming: strongStreaming({ epsg: 32613 }) });
    await importSession(asFile(sessionJson({ scanSummary: strongSummary() })), {}, deps);
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.setCrsOverride).not.toHaveBeenCalled();
    expect(calls.showToast.mock.calls.every((c) => !/conflicts with this scan/.test(c[0] as string))).toBe(true);
  });

  it('REFUSES the restore on a UNIT mismatch even when the EPSG agrees', async () => {
    const { deps, calls } = makeDeps({ streaming: strongStreaming({ epsg: 32613, linearUnit: 'metre' }) });
    await importSession(
      asFile(sessionJson({ crs: resolvedCrs({ epsg: 32613, linearUnit: 'foot', linearUnitToMetres: 0.3048 }), scanSummary: strongSummary() })),
      {},
      deps,
    );
    // A metre-vs-foot unit divergence silently rescales every distance, and the
    // rebase only translates (never rescales), so the geometry can't be made
    // right — FIX A refuses before attaching it.
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
    expect(calls.setCrsOverride).not.toHaveBeenCalled();
    const warn = calls.showToast.mock.calls.map((c) => c[0] as string).find((m) => /conflicts with this scan/.test(m));
    expect(warn).toMatch(/linear unit/);
    expect(warn).toMatch(/foot/);
  });

  it('REFUSES a Z-up session dropped onto a Y-up scan — no measurements under the wrong frame', async () => {
    // The headline FIX A case. A Y-up mesh format (GLB) is loaded; the session
    // was captured Z-up. Extents match so the identity gate returns strong, so
    // the OLD code rebased and attached the measurements, then fired a toast that
    // under-disclosed (the geometry was already applied). A Z-up→Y-up frame needs
    // a ROTATION to line up, but the rebase only ever translates — so every
    // attached measurement lands silently wrong. FIX A validates the axis in the
    // preflight and refuses the whole restore before any state is touched.
    const { deps, calls } = makeDeps({
      static: {
        name: 'loaded.glb',
        scanId: 'scan-1',
        pointCount: 1000,
        bounds: { min: [0, 0, 0], max: [10, 10, 3] },
        sourceFormat: 'glb',
      },
    });
    await importSession(
      asFile(sessionJson({ upAxis: 'z', scanSummary: strongSummary() })),
      {},
      deps,
    );
    // Nothing spatial is attached — not measurements, not annotations, not views.
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
    expect(calls.loadAnnotations).not.toHaveBeenCalled();
    expect(calls.applyViewState).not.toHaveBeenCalled();
    const warn = calls.showToast.mock.calls.map((c) => c[0] as string).find((m) => /conflicts with this scan/.test(m));
    expect(warn).toBeTruthy();
    expect(warn).toMatch(/up-axis/);
    expect(warn).toMatch(/Y-up/);
  });

  it('regression guard — a fully matching session (axis, unit, CRS all agree) STILL restores everything', async () => {
    // The clean-restore path FIX A must leave byte-for-byte intact: no conflict,
    // so the preflight falls through and every piece of state is committed and
    // the CRS override round-trips, exactly as before.
    const { deps, calls } = makeDeps({ streaming: strongStreaming({ epsg: 32613, linearUnit: 'metre' }) });
    await importSession(
      asFile(sessionJson({ upAxis: 'z', crs: resolvedCrs({ epsg: 32613, linearUnit: 'metre' }), scanSummary: strongSummary() })),
      {},
      deps,
    );
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.loadAnnotations).toHaveBeenCalledTimes(1);
    expect(calls.restore).toHaveBeenCalledTimes(1);
    expect(calls.applyViewState).toHaveBeenCalledTimes(1);
    expect(calls.setCrsOverride).toHaveBeenCalledTimes(1);
    expect(calls.showToast.mock.calls.every((c) => !/conflicts with this scan/.test(c[0] as string))).toBe(true);
  });

  it('restores cleanly when the file’s axis AGREES with the session', async () => {
    // A Z-up survey format (LAS); session Z-up — no axis conflict.
    const { deps, calls } = makeDeps({
      static: {
        name: 'loaded.las',
        scanId: 'scan-1',
        pointCount: 1000,
        bounds: { min: [0, 0, 0], max: [10, 10, 3] },
        sourceFormat: 'las',
      },
    });
    await importSession(asFile(sessionJson({ upAxis: 'z', scanSummary: strongSummary() })), {}, deps);
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.showToast.mock.calls.every((c) => !/conflicts with this scan/.test(c[0] as string))).toBe(true);
  });
});

describe('importSession — whole-file byte ceiling (OOM hardening)', () => {
  it('rejects an over-size session file before reading or mutating anything', async () => {
    const { deps, calls } = makeDeps();
    const text = vi.fn(async () => sessionJson());
    const overSize = { size: MAX_SESSION_BYTES + 1, text } as unknown as File;
    await importSession(overSize, {}, deps);
    expect(calls.setDropError).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(calls.loadMeasurements).not.toHaveBeenCalled();
    // Rejected on size alone — the file's bytes are never even read.
    expect(text).not.toHaveBeenCalled();
  });

  it('reads a file whose size is under the ceiling (regression guard)', async () => {
    const { deps, calls } = makeDeps();
    const okFile = { size: 1024, text: async () => sessionJson() } as unknown as File;
    await importSession(okFile, {}, deps);
    expect(calls.loadMeasurements).toHaveBeenCalledTimes(1);
    expect(calls.setDropError).not.toHaveBeenCalled();
  });
});
