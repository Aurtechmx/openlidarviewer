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

import { describe, it, expect, vi } from 'vitest';
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

function harness(opts: { viewerReady?: boolean; activeId?: string | null } = {}): Harness {
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

describe('handleCrsOverride — one resolver owns the resolved units', () => {
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
    });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'site/points.laz',
      metadata: { crs: UTM12N },
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
    });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'survey/az.las',
      metadata: { crs: STATE_PLANE_FEET },
    });
    h.coordinator.handleCrsOverride({ epsg: 2223, kind: 'projected' });

    const resolved = h.service.current();
    expect(resolved?.epsg).toBe(2223);
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
    });
    h.coordinator.refreshCrsForStaticCloud({
      name: 'scan/phone.las',
      metadata: { crs: UTM12N },
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
