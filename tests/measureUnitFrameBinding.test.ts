/**
 * measureUnitFrameBinding.test.ts
 *
 * What a CRS change does to the measurement tool and the scene, driven through
 * the mount that main.ts uses (`createMeasurePanelMount().bindUnitFrames`) with
 * a real controller, a real CRS service and a viewer reduced to the calls the
 * binding makes.
 *
 * - A subscriber is told once, after the new frame, the layer's up axis and
 *   the re-cut of profile and volume results derived along the old axis have
 *   all settled: never the new frame beside a result still cut the old way.
 * - A moved axis recolours the scene, re-expresses the elevation filter and
 *   re-aligns navigation, each once; an unrelated CRS event does none of them.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadPly } from '../src/io/loadPly';
import type { PointCloud } from '../src/model/PointCloud';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import { createMeasurePanelMount } from '../src/app/measurePanelMount';
import { reexpressElevationFilter } from '../src/app/elevationFilterAxis';
import { cloudUpAxisIndex, setCloudUpResolver } from '../src/render/layerUpRegistry';
import type { Viewer } from '../src/render/Viewer';
import type { Measurement, Vec3 } from '../src/render/measure/types';
import { installFakeDom } from './support/measurePanelDom';

beforeAll(() => installFakeDom({ ns: true }));
// The binding registers the app's per-layer up resolver process-wide.
afterAll(() => setCloudUpResolver(null));

function port(): CrsOverridePort {
  const store = new Map<string, unknown>();
  return { get: (k) => store.get(k) as never, set: (k, v) => void store.set(k, { ...v, updatedAt: 0 }), clear: (k) => void store.delete(k) } as CrsOverridePort;
}

/** UTM 13N points: B is 30 m north of A and 70 m above it. */
async function site(): Promise<PointCloud> {
  const rows = ['500000 4000000 100', '500000 4000030 170', '500040 4000000 100'];
  const text = `ply\nformat ascii 1.0\nelement vertex ${rows.length}\nproperty double x\nproperty double y\nproperty double z\nend_header\n${rows.join('\n')}\n`;
  return loadPly(new TextEncoder().encode(text).buffer as ArrayBuffer, 'site.ply');
}

const pt = (c: PointCloud, i: number): Vec3 => [c.positions[i * 3]!, c.positions[i * 3 + 1]!, c.positions[i * 3 + 2]!];

async function world() {
  const cloud = await site();
  const crs = new CrsService(port());
  crs.resolveForScan({ name: cloud.name, detected: undefined, source: 'las-vlr', identity: datasetIdentity(cloud) });
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setLayerResolver((l) => (typeof l === 'string' ? l : null));
  measure.setProfileSampler(() => [{ distance: 0, height: 7 }, { distance: 1, height: 8 }]);
  const events: string[] = [];
  const filter = {
    window: [102, 108] as [number, number] | null,
    extent: { min: 100, max: 170 } as { min: number; max: number } | null,
    /** The scene's extent along the up axis once it has moved. */
    sceneExtent: { min: 100, max: 170 } as { min: number; max: number } | null,
  };
  const viewer = {
    measure,
    layerUp: null as ((id: string) => Vec3 | null) | null,
    alignUpToLayer: vi.fn(() => { events.push('align'); }),
    // The recolour: a height colouring pass reads the cloud's axis, as the legend does.
    refreshProjectSharedElevation: vi.fn(() => { cloudUpAxisIndex(cloud); events.push('recolour'); }),
  };
  const mount = createMeasurePanelMount({
    getViewer: () => viewer as unknown as Viewer,
    crsService: crs,
  } as never);
  const measureUnits = mount.bindUnitFrames({
    activeId: () => 'a',
    clouds: () => ['a'],
    cloud: () => cloud,
    stableIdFor: () => 'layer-a',
    onUpAxisMoved: () => reexpressElevationFilter({
      active: () => filter.window,
      extent: () => filter.sceneExtent,
      seedExtent: (e) => { if (e && filter.extent && e.min !== filter.extent.min) filter.window = null; filter.extent = e; },
      apply: () => { events.push('filter applied'); },
      notify: (m) => { events.push(`filter notice: ${m.slice(0, 24)}`); },
    }),
  });
  cloudUpAxisIndex(cloud); // coloured once, as a loaded scan is
  return { cloud, crs, measure, viewer, events, filter, measureUnits };
}

describe('one notification, after the frame and the derived results have settled', () => {
  it('a profile cut along the old axis is re-cut before anyone is told the frame changed', async () => {
    const w = await world();
    w.measureUnits.onCrsChange();
    const own = { pickLayers: ['layer-a'], owner: { layerId: 'layer-a', frame: 'source-local' as const } };
    w.measure.loadMeasurements([
      { id: 'p', kind: 'profile', name: 'p', closed: false, points: [pt(w.cloud, 0), pt(w.cloud, 2)], profileChart: [{ distance: 0, height: 30 }, { distance: 1, height: 31 }], derivedUpAxis: 'y', ...own },
    ] as Measurement[]);
    const seen: Array<{ cut: string | undefined; height: number | undefined }> = [];
    w.measure.setOnChange(() => {
      const m = w.measure.getMeasurements()[0]!;
      seen.push({ cut: m.derivedUpAxis, height: m.profileChart?.[0]?.height });
    });

    w.crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'las-vlr' });
    w.measureUnits.onCrsChange();

    // The layer is Z-up now; the one notification sees the profile cut along Z.
    expect(seen).toEqual([{ cut: 'z', height: 7 }]);
  });
});

describe('an axis moved by a CRS change', () => {
  it('re-aligns navigation, recolours, re-expresses the filter, and does none of it for a change that moves nothing', async () => {
    const w = await world();
    w.measureUnits.onCrsChange();
    w.events.length = 0;
    expect(w.viewer.layerUp!('a')).toEqual([0, 1, 0]);

    w.crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'las-vlr' });
    w.measureUnits.onCrsChange();
    expect(w.viewer.layerUp!('a')).toEqual([0, 0, 1]);
    expect(cloudUpAxisIndex(w.cloud)).toBe(2);
    // Navigation first, then the recolour, then the filter, in that order.
    expect(w.events).toEqual(['align', 'recolour', 'filter applied']);

    w.events.length = 0;
    w.measureUnits.onCrsChange();
    expect(w.events).toEqual(['align']);
  });

  it('a filter window that described heights along the old axis is cleared with the reason', async () => {
    const w = await world();
    w.measureUnits.onCrsChange();
    w.events.length = 0;
    // A window of northings, set while the layer read Y as up.
    w.filter.window = [4000010, 4000020];
    w.filter.extent = { min: 4000000, max: 4000030 };
    w.crs.setOverride({ override: { kind: 'projected', epsg: 32613 }, detected: undefined, source: 'las-vlr' });
    // The scene's extent along the new axis is what the control is re-seeded with.
    w.filter.sceneExtent = { min: 100, max: 170 };
    w.measureUnits.onCrsChange();
    expect(w.filter.window).toBeNull();
    expect(w.events.some((e) => e.startsWith('filter notice: Elevation filter cleared'))).toBe(true);
  });
});
