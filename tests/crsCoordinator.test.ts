// What these tests would catch:
//
//  - A streaming source kind attributed to the wrong CRS provenance. A tile
//    store carries no projection of its own, so a CRS it reports came from the
//    source file's LAS VLRs; recording it as `copc-meta` would credit the
//    reading to a manifest that does not exist. The mapping used to be a
//    two-way branch that labelled everything-not-EPT as COPC, which mislabels
//    every kind added after it.
//  - The coordinator re-deriving a unit instead of forwarding the resolver's.
//    A user confirming a foot-based scan's own declared CRS must keep
//    `linearUnitToMetres` at 0.3048; a hardcoded 1 makes the point inspector
//    and the measurement HUD disagree by 3.28x on the same scan.
//  - An override applied with no scan in scope, which would target whichever
//    dataset key happened to be left over from a closed scan.
//  - A viewer push that is not guarded, so a CRS refresh arriving before the
//    viewer chunk resolves (or from a viewer that throws) breaks the load.
//  - The static path preferring `origin` over the file's own `sourceOrigin`
//    for the inspector's coordinate context.
//  - A CRS change that the scan summaries never hear about, so the Dataset
//    Intelligence density, the Project card size and the object report keep
//    the old frame's units after an override or "Use detected".

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { installManualTimerDom } from './helpers/manualTimerDom';
import { readFileSync } from 'node:fs';
import { createInspectorCardRefreshers } from '../src/app/inspectorCardRefreshers';
import { createCrsCoordinator } from '../src/app/crsCoordinator';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import { keyForDataset, type CrsOverride } from '../src/geo/CrsOverrideStore';
import type { CrsInfo } from '../src/io/crs';
import type { Viewer } from '../src/render/Viewer';

/** An in-memory stand-in for the localStorage-backed override store. */
function memoryPort(): CrsOverridePort & { entries: Map<string, CrsOverride> } {
  const entries = new Map<string, CrsOverride>();
  return {
    entries,
    get: (key) => entries.get(key),
    set: (key, override) => {
      entries.set(key, { ...override, updatedAt: 1_700_000_000_000 });
    },
    clear: (key) => {
      entries.delete(key);
    },
  };
}

/** A metre-based projected CRS the file declares for itself. */
const UTM12N: CrsInfo = {
  source: 'wkt',
  wkt: 'PROJCS["WGS 84 / UTM zone 12N"]',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
};

/**
 * A foot-based projected CRS. `linearUnitToMetres` is the US survey foot, the
 * value that must survive a user confirming this very CRS.
 */
const STATE_PLANE_FEET: CrsInfo = {
  source: 'wkt',
  wkt: 'PROJCS["NAD83 / Arizona Central (ft)"]',
  name: 'NAD83 / Arizona Central (ft)',
  epsg: 2223,
  linearUnit: 'us-survey-foot',
  linearUnitToMetres: 1200 / 3937,
  isGeographic: false,
};

interface Harness {
  service: CrsService;
  port: ReturnType<typeof memoryPort>;
  setInspectCoordinateContext: ReturnType<typeof vi.fn>;
  viewer: {
    streamingCloud: unknown;
    getCloud: ReturnType<typeof vi.fn>;
    setInspectCoordinateContext: ReturnType<typeof vi.fn>;
  };
  coordinator: ReturnType<typeof createCrsCoordinator>;
}

function harness(opts: { viewerReady?: boolean; activeId?: string | null; onOverrideApplied?: () => void; onFrameChange?: (source: object) => void } = {}): Harness {
  const port = memoryPort();
  const service = new CrsService(port);
  const setInspectCoordinateContext = vi.fn();
  const viewer = {
    streamingCloud: undefined as unknown,
    getCloud: vi.fn(() => undefined),
    setInspectCoordinateContext,
  };
  const coordinator = createCrsCoordinator({
    crsService: service,
    getViewer: () => viewer as unknown as Viewer,
    isViewerReady: () => opts.viewerReady ?? true,
    getActiveId: () => opts.activeId ?? null,
    debug: false,
    onOverrideApplied: opts.onOverrideApplied,
    onFrameChange: opts.onFrameChange ? [opts.onFrameChange] : undefined,
  });
  return { service, port, setInspectCoordinateContext, viewer, coordinator };
}

describe('refreshCrsForStreamingCloud — provenance per source kind', () => {
  it("credits an EPT cloud's CRS to the manifest SRS", () => {
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud({
      name: 'remote/ept.json',
      kind: 'ept',
      crs: () => UTM12N,
    });
    expect(h.service.current()?.source).toBe('ept-srs');
    expect(h.service.current()?.epsg).toBe(32612);
  });

  it("credits a COPC cloud's CRS to the COPC metadata", () => {
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud({
      name: 'remote/scan.copc.laz',
      kind: 'copc',
      crs: () => UTM12N,
    });
    expect(h.service.current()?.source).toBe('copc-meta');
  });

  it("credits a tile store's CRS to the source file's LAS VLRs, not to a manifest", () => {
    // The out-of-core builder reads the VLRs off the LAS it indexed; the tile
    // store itself declares no projection, so 'copc-meta' would be a fiction.
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud({
      name: 'local/huge.las',
      kind: 'tiles',
      crs: () => UTM12N,
    });
    expect(h.service.current()?.source).toBe('las-vlr');
    expect(h.service.current()?.source).not.toBe('copc-meta');
  });

  it('publishes the unknown CRS when the streaming source declares none', () => {
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud({
      name: 'local/huge.las',
      kind: 'tiles',
      crs: () => undefined,
    });
    expect(h.service.current()?.kind).toBe('unknown');
    expect(h.service.validation().canDisplayMetric).toBe(false);
  });

  it("pushes the cloud's render origin and resolved CRS into the inspector context", () => {
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud({
      name: 'remote/scan.copc.laz',
      kind: 'copc',
      renderOrigin: [400_000, 3_800_000, 100],
      crs: () => UTM12N,
    });
    expect(h.setInspectCoordinateContext).toHaveBeenCalledTimes(1);
    const arg = h.setInspectCoordinateContext.mock.calls[0][0];
    expect(arg.origin).toEqual([400_000, 3_800_000, 100]);
    expect(arg.crs.epsg).toBe(32612);
  });
});

describe('refreshCrsForStaticCloud — the LAS/LAZ VLR path', () => {
  it("resolves the file's own declared CRS and records it as a VLR reading", () => {
    const h = harness();
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      origin: [1, 2, 3],
      metadata: { crs: UTM12N },
    });
    expect(h.service.current()?.source).toBe('las-vlr');
    expect(h.service.current()?.name).toBe('WGS 84 / UTM zone 12N');
  });

  it("prefers the file's own sourceOrigin over the render origin for the inspector", () => {
    const h = harness();
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      origin: [0, 0, 0],
      sourceOrigin: [400_000, 3_800_000, 1_200],
      metadata: { crs: UTM12N },
    });
    expect(h.setInspectCoordinateContext.mock.calls[0][0].origin).toEqual([
      400_000, 3_800_000, 1_200,
    ]);
  });

  it('falls back to the render origin when the file carries no source origin', () => {
    const h = harness();
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      origin: [7, 8, 9],
      metadata: { crs: UTM12N },
    });
    expect(h.setInspectCoordinateContext.mock.calls[0][0].origin).toEqual([7, 8, 9]);
  });

  it('still publishes the CRS when the viewer chunk has not resolved yet', () => {
    const h = harness({ viewerReady: false });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      metadata: { crs: UTM12N },
    });
    expect(h.service.current()?.epsg).toBe(32612);
    expect(h.setInspectCoordinateContext).not.toHaveBeenCalled();
  });

  it('survives a viewer whose inspector push throws', () => {
    const h = harness();
    h.setInspectCoordinateContext.mockImplementation(() => {
      throw new Error('inspector not mounted');
    });
    expect(() =>
      h.coordinator.refreshCrsForStaticCloud({
        name: 'site/points.laz',
        metadata: { crs: UTM12N },
      }),
    ).not.toThrow();
    // The CRS still reached the service, which is the load-bearing half.
    expect(h.service.current()?.epsg).toBe(32612);
  });
});

/**
 * The size, shape and position a loaded cloud reports. A remembered override is
 * re-applied on the refresh after a pick only when the cloud identifies itself.
 */
const FACTS = {
  pointCount: 1000,
  sourceOrigin: [500_000, 4_000_000, 0] as [number, number, number],
  bounds: () => ({ min: [0, 0, 0], max: [10, 10, 1] }),
};
const STREAM_FACTS = {
  sourcePointCount: 1000,
  dataBounds: () => [0, 0, 0, 10, 10, 1] as readonly number[],
};

describe('handleCrsOverride — one resolver owns the resolved units', () => {
  it('asks the layers to re-judge their shared frame once the override is applied', () => {
    const onOverrideApplied = vi.fn();
    const h = harness({ activeId: 'cloud-1', onOverrideApplied });
    h.coordinator.refreshCrsForStaticCloud({ name: 'site/points.laz', metadata: { crs: UTM12N } });
    expect(onOverrideApplied).not.toHaveBeenCalled();
    h.coordinator.handleCrsOverride({ epsg: 26912, kind: 'projected' });
    expect(onOverrideApplied).toHaveBeenCalledTimes(1);
    expect(h.service.current()?.epsg).toBe(26912);
  });

  it('asks nothing when no scan is tracked', () => {
    const onOverrideApplied = vi.fn();
    const h = harness({ onOverrideApplied });
    h.coordinator.handleCrsOverride({ epsg: 26912, kind: 'projected' });
    expect(onOverrideApplied).not.toHaveBeenCalled();
  });

  it('does nothing until a scan has been tracked', () => {
    const h = harness();
    h.coordinator.handleCrsOverride({ epsg: 32612, kind: 'projected' });
    expect(h.port.entries.size).toBe(0);
    expect(h.service.current()).toBeNull();
  });

  it('does nothing again after the dataset key is cleared on close', () => {
    const h = harness();
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      metadata: { crs: UTM12N },
    });
    h.coordinator.clearDatasetKey();
    h.coordinator.handleCrsOverride({ epsg: 26912, kind: 'projected' });
    expect(h.port.entries.has(keyForDataset('site/points.laz'))).toBe(false);
  });

  it('persists a picked EPSG against the dataset, stamped with what the file declared', () => {
    const h = harness({ activeId: 'cloud-1' });
    h.viewer.getCloud.mockReturnValue({
      name: 'site/points.laz',
      metadata: { crs: UTM12N },
      ...FACTS,
    });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      metadata: { crs: UTM12N },
      ...FACTS,
    });
    h.coordinator.handleCrsOverride({ epsg: 26912, kind: 'projected' });
    const stored = h.port.entries.get(keyForDataset('site/points.laz'));
    expect(stored?.epsg).toBe(26912);
    expect(stored?.detectedEpsg).toBe(32612);
    expect(h.service.current()?.epsg).toBe(26912);
    expect(h.service.current()?.userConfirmed).toBe(true);
  });

  it("keeps the foot unit when a user merely confirms a foot-based scan's own CRS", () => {
    // The coordinator must forward the resolver's unit. A second, local copy of
    // this logic wrote linearUnitToMetres: 1 for every projected override, and
    // that value is what reached the point inspector, so the inspector and the
    // measurement HUD read the same scan 3.28x apart.
    const h = harness({ activeId: 'cloud-1' });
    h.viewer.getCloud.mockReturnValue({
      name: 'survey/az.las',
      metadata: { crs: STATE_PLANE_FEET },
      ...FACTS,
    });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'survey/az.las',
      metadata: { crs: STATE_PLANE_FEET },
      ...FACTS,
    });
    h.coordinator.handleCrsOverride({ epsg: 2223, kind: 'projected' });

    const resolved = h.service.current();
    expect(resolved?.epsg).toBe(2223);
    expect(resolved?.userConfirmed).toBe(true);
    expect(resolved?.linearUnit).toBe('us-survey-foot');
    expect(resolved?.linearUnitToMetres).toBeCloseTo(1200 / 3937, 12);
    expect(resolved?.linearUnitToMetres).not.toBe(1);
    // The same value is what the inspector was handed on the refresh that
    // follows the override, so the two readouts cannot diverge.
    const lastPush = h.setInspectCoordinateContext.mock.calls.at(-1)?.[0];
    expect(lastPush.crs.linearUnitToMetres).toBeCloseTo(1200 / 3937, 12);
  });

  it("pins local coordinates, and the 'detected' command clears back to the file's CRS", () => {
    const h = harness({ activeId: 'cloud-1' });
    h.viewer.getCloud.mockReturnValue({
      name: 'scan/phone.las',
      metadata: { crs: UTM12N },
      ...FACTS,
    });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'scan/phone.las',
      metadata: { crs: UTM12N },
      ...FACTS,
    });

    h.coordinator.handleCrsOverride({ epsg: null, kind: 'local' });
    expect(h.service.current()?.kind).toBe('local');
    expect(h.port.entries.has(keyForDataset('scan/phone.las'))).toBe(true);

    h.coordinator.handleCrsOverride({ epsg: null, kind: 'detected' });
    expect(h.port.entries.has(keyForDataset('scan/phone.las'))).toBe(false);
    expect(h.service.current()?.epsg).toBe(32612);
    expect(h.service.current()?.source).toBe('las-vlr');
  });

  it("reads the detected CRS off a streaming cloud, and keeps that cloud's provenance", () => {
    const h = harness();
    const cloud = {
      name: 'local/huge.las',
      kind: 'tiles' as const,
      crs: () => UTM12N,
    };
    h.viewer.streamingCloud = cloud;
    h.coordinator.refreshCrsForStreamingCloud(cloud);
    h.coordinator.handleCrsOverride({ epsg: null, kind: 'detected' });
    // Clearing back to detected on a tile store re-reads the VLR provenance,
    // not the static-cloud default that a missing streaming cloud would give.
    expect(h.service.current()?.epsg).toBe(32612);
    expect(h.service.current()?.source).toBe('las-vlr');
    expect(h.port.entries.size).toBe(0);
  });

  it("refreshes through the streaming cloud when one is open, not the static cloud", () => {
    const h = harness({ activeId: 'cloud-1' });
    const cloud = {
      name: 'remote/scan.copc.laz',
      kind: 'copc' as const,
      renderOrigin: [10, 20, 30] as const,
      crs: () => UTM12N,
      ...STREAM_FACTS,
    };
    h.viewer.streamingCloud = cloud;
    h.viewer.getCloud.mockReturnValue({
      name: 'site/other.laz',
      metadata: { crs: STATE_PLANE_FEET },
    });
    h.coordinator.refreshCrsForStreamingCloud(cloud);
    h.setInspectCoordinateContext.mockClear();
    h.coordinator.handleCrsOverride({ epsg: 26912, kind: 'projected' });

    const arg = h.setInspectCoordinateContext.mock.calls.at(-1)?.[0];
    expect(arg.origin).toEqual([10, 20, 30]);
    expect(h.service.current()?.epsg).toBe(26912);
    // The static cloud's foot CRS must not have leaked into the resolution.
    expect(h.service.current()?.linearUnit).not.toBe('us-survey-foot');
  });
});

describe('refreshCrsForStreamingCloud — a persisted override needs dataset identity', () => {
  /**
   * The static path passes `identity: datasetIdentity(cloud)` so two same-named
   * files are told apart before a remembered override is reapplied. Streaming
   * passed nothing, so two unrelated COPC sources sharing a filename — both
   * declaring no CRS, which is exactly the state a user overrides — collided,
   * and the first one's frame was applied to the second.
   *
   * This pins the WIRING, not the comparator: `datasetIdentity` has its own
   * tests, and they kept passing while the coordinator dropped the value.
   */
  const stream = (name: string, pts: number, span: number) => ({
    name,
    kind: 'copc' as const,
    sourcePointCount: pts,
    dataBounds: () => [0, 0, 0, span, span, span / 10] as readonly number[],
    crs: () => undefined,
  });

  it('does NOT reapply an override to a different stream of the same name', () => {
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud(stream('survey.copc.laz', 1_000_000, 500));
    h.service.setOverride({
      override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta',
    });
    expect(h.service.current()?.epsg).toBe(32612);

    h.coordinator.refreshCrsForStreamingCloud(stream('survey.copc.laz', 42_000_000, 12_000));
    expect(h.service.current()?.epsg, "the other stream's frame was applied").not.toBe(32612);
  });

  it('DOES reapply it when the same stream is reopened', () => {
    const h = harness();
    h.coordinator.refreshCrsForStreamingCloud(stream('survey.copc.laz', 1_000_000, 500));
    h.service.setOverride({
      override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta',
    });
    h.coordinator.refreshCrsForStreamingCloud(stream('survey.copc.laz', 1_000_000, 500));
    expect(h.service.current()?.epsg).toBe(32612);
  });

  it('offers, but does not apply, an override to a stream that states no identity', () => {
    const h = harness();
    const bare = (name: string) => ({ name, kind: 'copc' as const, crs: () => undefined });
    h.coordinator.refreshCrsForStreamingCloud(bare('survey.copc.laz'));
    h.service.setOverride({
      override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta',
    });
    // No identity on either side cannot verify the source, so the remembered
    // choice is kept and offered rather than applied silently.
    h.coordinator.refreshCrsForStreamingCloud(bare('survey.copc.laz'));
    expect(h.service.current()?.epsg).toBeUndefined();
    expect(h.service.overrideSuggestion()).toMatchObject({ epsg: 32612, reason: 'identity-missing' });
    expect(h.port.entries.has('survey.copc.laz')).toBe(true);
  });
});

describe('onFrameChange: the scan summaries hear about a new frame', () => {
  /** A phone scan: no CRS of its own, and enough facts to verify an override. */
  const phone = () => ({ name: 'scan/phone.glb', metadata: { crs: null }, ...FACTS });

  it('fires once per frame change, naming the cloud the opener passed', () => {
    const onFrameChange = vi.fn();
    const h = harness({ activeId: 'cloud-1', onFrameChange });
    const opened = phone();
    // The viewer hands back an equal but distinct object, as a GPU-budget
    // downsample does; the summaries were built from the opener's object.
    h.viewer.getCloud.mockReturnValue(phone());
    h.coordinator.refreshCrsForStaticCloud(opened);
    expect(onFrameChange).toHaveBeenCalledTimes(1);
    expect(onFrameChange.mock.calls.at(-1)![0]).toBe(opened);

    h.coordinator.handleCrsOverride({ epsg: 32612, kind: 'projected' });
    expect(onFrameChange).toHaveBeenCalledTimes(2);
    expect(onFrameChange.mock.calls.at(-1)![0]).toBe(opened);

    h.coordinator.handleCrsOverride({ epsg: null, kind: 'detected' });
    expect(onFrameChange).toHaveBeenCalledTimes(3);
    expect(onFrameChange.mock.calls.at(-1)![0]).toBe(opened);

    h.coordinator.handleCrsOverride({ epsg: 32612, kind: 'projected' });
    expect(onFrameChange).toHaveBeenCalledTimes(4);
    expect(onFrameChange.mock.calls.at(-1)![0]).toBe(opened);
  });

  it('stays quiet when the frame does not move, and when the scan closes', () => {
    const onFrameChange = vi.fn();
    const h = harness({ activeId: 'cloud-1', onFrameChange });
    const opened = phone();
    h.coordinator.refreshCrsForStaticCloud(opened);
    h.coordinator.refreshCrsForStaticCloud(opened); // the same frame again
    expect(onFrameChange).toHaveBeenCalledTimes(1);
    h.coordinator.clearDatasetKey();
    h.service.clear();
    expect(onFrameChange).toHaveBeenCalledTimes(1);
  });

  it('names the new scan when another scan resolves, so the old one is not re-measured', () => {
    const onFrameChange = vi.fn();
    const h = harness({ activeId: 'cloud-1', onFrameChange });
    const first = phone();
    h.coordinator.refreshCrsForStaticCloud(first);
    const stream = { name: 'remote/scan.copc.laz', kind: 'copc' as const, crs: () => UTM12N, ...STREAM_FACTS };
    h.coordinator.refreshCrsForStreamingCloud(stream);
    expect(onFrameChange.mock.calls.at(-1)![0]).toBe(stream);
  });

  it('does not subscribe at all without the hook', () => {
    const h = harness();
    expect(h.service.subscriberCount()).toBe(0);
  });

  it('carries a metre pick to the Dataset Intelligence density, and "Use detected" back', () => {
    const port = memoryPort();
    const service = new CrsService(port);
    const opened = phone();
    const pushed: Array<{ bboxVolume?: number }> = [];
    const inspector = {
      setDatasetIntelligence: (s: { bboxVolume?: number }) => pushed.push(s),
      clearDatasetIntelligence: vi.fn(),
      setProvenance: vi.fn(),
    } as never;
    const cards = createInspectorCardRefreshers(inspector, () => service.context());
    const coordinator = createCrsCoordinator({
      crsService: service,
      getViewer: () => ({ streamingCloud: null, getCloud: () => opened, setInspectCoordinateContext: vi.fn() }) as unknown as Viewer,
      isViewerReady: () => true,
      getActiveId: () => 'cloud-1',
      debug: false,
      onFrameChange: [(src) => cards.refreshDatasetIntelligenceForFrame(src)],
    });
    // The open: CRS first, then the card, as openScan orders them.
    coordinator.refreshCrsForStaticCloud(opened);
    cards.refreshDatasetIntelligenceFromStaticCloud(opened as never);
    expect(pushed.at(-1)!.bboxVolume).toBeUndefined();

    coordinator.handleCrsOverride({ epsg: 32612, kind: 'projected' });
    expect(pushed.at(-1)!.bboxVolume).toBeCloseTo(100, 6); // 10 m x 10 m x 1 m

    coordinator.handleCrsOverride({ epsg: null, kind: 'detected' });
    expect(pushed.at(-1)!.bboxVolume).toBeUndefined();
  });
});

describe('a frame change reaches every scan summary', () => {
  it('a summary that throws does not stop the others', () => {
    const seen: string[] = [];
    const h = harness({ activeId: 'cloud-1' });
    const service = h.service;
    createCrsCoordinator({
      crsService: service,
      getViewer: () => h.viewer as unknown as Viewer,
      isViewerReady: () => true,
      getActiveId: () => 'cloud-1',
      debug: false,
      onFrameChange: [
        () => { seen.push('card'); throw new Error('card failed'); },
        () => { seen.push('report'); throw new Error('report failed'); },
        () => { seen.push('project'); },
      ],
    }).refreshCrsForStaticCloud({ name: 'scan/phone.glb', metadata: { crs: null }, ...FACTS });
    expect(seen).toEqual(['card', 'report', 'project']);
  });

  describe('the three real summaries, wired as the shell wires them', () => {
    beforeAll(() => { installManualTimerDom(); });

    it('a metre pick reaches the density, the object report and the Project card, and "Use detected" undoes all three', async () => {
      const { ProjectCard } = await import('../src/ui/ProjectCard');
      const { describeProjectSize } = await import('../src/render/camera/recommendView');
      const { groundMetresPermitted } = await import('../src/geo/SpatialContext');
      const { createScanRouteCoordinator, routeUnitFrame } = await import('../src/app/scanRouteCoordinator');
      const { createScanRouteService } = await import('../src/app/ScanRouteService');

      const service = new CrsService(memoryPort());
      const opened = { name: 'scan/phone.glb', metadata: { crs: null }, ...FACTS };
      const pushed: Array<{ bboxVolume?: number }> = [];
      const cards = createInspectorCardRefreshers({
        setDatasetIntelligence: (s: { bboxVolume?: number }) => pushed.push(s),
        clearDatasetIntelligence: vi.fn(),
        setProvenance: vi.fn(),
      } as never, () => service.context());
      const shownObjects: Array<[unknown, { linearUnit: { known: boolean } } | null]> = [];
      const routing = createScanRouteService({ scanRoute: { overridden: false, typeOverride: 'auto' } } as never);
      const box = new Float32Array(3000).map((_, i) => ((i * 7919) % 1000) / 1000);
      const route = createScanRouteCoordinator({
        routing,
        geometry: { gatherForRouting: () => ({ positions: box, residentOnly: false, totalPoints: 1000 }), residentPointTotal: () => 1000, hasRgb: () => false },
        frame: { ...routeUnitFrame(() => service.context(), () => service.current()), exportTargetId: () => 'cloud-1', crsRevision: () => service.crsRevision(), basename: () => 'phone' },
        verdict: { get: () => null, set: () => {} },
        view: {
          setObjectScanType: vi.fn(), setAnalyseScanType: vi.fn(), showSpace: vi.fn(),
          showObject: (o, s) => { shownObjects.push([o, s as never]); },
          setObjectVisible: vi.fn(), setAnalyseVisible: vi.fn(), setDockAnalyse: vi.fn(), expandAnalyseAndRunTerrain: vi.fn(),
        },
        classify: () => ({ nonTerrain: true, spaceKind: 'object', up: 'z', aspect: 1, overhangFraction: 0, wallCoverage: 0, floorCoverage: 0, ceilingCoverage: 0, topVegFraction: 0, reasons: [] }) as never,
      });
      const card = new ProjectCard();
      const b = opened.bounds() as { min: [number, number, number]; max: [number, number, number] };
      const sizeIn = () => {
        const f = service.context();
        return describeProjectSize(b.min, b.max, { upAxis: f.upAxis, linearUnitKnown: groundMetresPermitted(f), linearUnitToMetres: f.linearUnitToMetres });
      };
      const coordinator = createCrsCoordinator({
        crsService: service,
        getViewer: () => ({ streamingCloud: null, getCloud: () => opened, setInspectCoordinateContext: vi.fn() }) as unknown as Viewer,
        isViewerReady: () => true,
        getActiveId: () => 'cloud-1',
        debug: false,
        onFrameChange: [(src) => cards.refreshDatasetIntelligenceForFrame(src), () => route.remeasureForFrame(), (src) => card.remeasure(src)],
      });

      coordinator.refreshCrsForStaticCloud(opened);
      cards.refreshDatasetIntelligenceFromStaticCloud(opened as never);
      route.beginScan(true);
      card.show({ name: opened.name, format: 'glb', shownCount: 1000, totalCount: 1000, ...sizeIn(), hasRgb: false, hasIntensity: false, hasClassification: false, source: opened, remeasure: sizeIn });
      const size = () => (card.element as unknown as { textContent: string }).textContent;
      expect(pushed.at(-1)!.bboxVolume).toBeUndefined();
      expect(shownObjects.at(-1)![1]!.linearUnit.known).toBe(false);
      expect(size()).toContain('source units');

      coordinator.handleCrsOverride({ epsg: 32612, kind: 'projected' });
      expect(pushed.at(-1)!.bboxVolume).toBeCloseTo(100, 6);
      expect(shownObjects.at(-1)![1]!.linearUnit.known).toBe(true);
      expect(size()).toContain('10.0 × 10.0 × 1.0 m');

      coordinator.handleCrsOverride({ epsg: null, kind: 'detected' });
      expect(pushed.at(-1)!.bboxVolume).toBeUndefined();
      expect(shownObjects.at(-1)![1]!.linearUnit.known).toBe(false);
      expect(size()).toContain('source units');
    });
  });
});

describe('main.ts hands every frame change to the three scan summaries', () => {
  // main.ts cannot be loaded in Node, so this one fact is read from its text:
  // the coordinator's handler list names each summary once.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  it('the coordinator gets one handler per summary', () => {
    const list = /onFrameChange: \[([^\]]*)\]/.exec(main);
    expect(list, 'createCrsCoordinator gets an onFrameChange list').not.toBeNull();
    expect(list![1]).toContain('inspectorCards.refreshDatasetIntelligenceForFrame(src)');
    expect(list![1]).toContain('routeCoordinator.remeasureForFrame()');
    expect(list![1]).toContain('projectCard.remeasure(src)');
  });
});
