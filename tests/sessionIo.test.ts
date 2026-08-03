import { describe, it, expect, vi } from 'vitest';
import {
  importSession,
  scanFactsFromStreaming,
  scanFactsFromStatic,
  type SessionIoDeps,
  type SessionModule,
} from '../src/app/sessionIo';
import { serializeSession, parseSession, rebaseSessionGeometry, matchSessionToScan } from '../src/io/session';
import type { InspectionSession, SessionScanSummary } from '../src/io/session';
import type { Viewer } from '../src/render/Viewer';
import type { Measurement, Vec3 } from '../src/render/measure/types';

// The build version the deps advertise; sessions are stamped with the SAME
// string so the stale-export disclosure stays quiet except where a test wants it.
const CURRENT = '0.6.3';

const p = (x: number, y: number, z: number): Vec3 => [x, y, z];

// importSession only calls file.text(); a plain object is enough and avoids
// depending on a Node `File` global.
const asFile = (text: string): File => ({ text: async () => text }) as unknown as File;

const realSessionModule: SessionModule = { parseSession, rebaseSessionGeometry, matchSessionToScan };

interface StreamingOpts {
  name: string;
  sourcePointCount: number;
  dataBounds: readonly [number, number, number, number, number, number];
  crs?: { name?: string; epsg?: number } | null;
}

/**
 * Build a SessionIoDeps wired to spies, plus the spies themselves. A `streaming`
 * option supplies a fake streaming cloud (so `haveCloud` is true and the
 * scan-identity match runs); with none, the scene is empty.
 */
function makeDeps(
  over: {
    streaming?: StreamingOpts;
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

  const viewer = {
    clouds: () => [] as string[],
    hasStreamingCloud: over.streaming != null,
    streamingCloud,
    getCloud: () => undefined,
    measure: { loadMeasurements },
    annotate: { loadAnnotations },
  };

  const deps: SessionIoDeps = {
    viewerReady: Promise.resolve(),
    getViewer: () => viewer as unknown as Viewer,
    loadSession: async () => realSessionModule,
    appVersion: over.appVersion ?? CURRENT,
    getActiveScanId: () => null,
    getActiveCloud: () => null,
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
