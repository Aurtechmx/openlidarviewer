/**
 * contextViewHost.test.ts
 *
 * Pins the application-side half of the Context View seam — the adapter that
 * turns the Viewer's cloud registry into the layer descriptors the mount asks
 * for. One thing here is worth a test on its own: the descriptors must be in the
 * SOURCE frame (bounds + origin), not the recentred render frame. Reporting the
 * render frame would place every scan near the projection's false origin, which
 * transforms cleanly and looks entirely plausible on the map — the exact failure
 * that never announces itself.
 */

import { describe, it, expect } from 'vitest';
import {
  contextLayerDescriptors,
  createContextViewHost,
} from '../src/app/contextViewHost';
import type { Viewer } from '../src/render/Viewer';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

interface StubCloud {
  name: string;
  sourceOrigin: readonly [number, number, number];
  bounds(): { min: [number, number, number]; max: [number, number, number] };
}

function viewerWith(
  clouds: ReadonlyMap<string, StubCloud>,
  streaming: unknown = null,
): Viewer {
  return {
    clouds: () => [...clouds.keys()],
    getCloud: (id: string) => clouds.get(id),
    streamingCloud: streaming,
  } as unknown as Viewer;
}

const cloud = (
  name: string,
  origin: readonly [number, number, number],
): StubCloud => ({
  name,
  sourceOrigin: origin,
  bounds: () => ({ min: [-50, -20, -3], max: [50, 20, 7] }),
});

describe('contextLayerDescriptors', () => {
  it('reports a static layer in the source frame, not the render frame', () => {
    const viewer = viewerWith(
      new Map([['a', cloud('Scan A', [500000, 4000000, 100])]]),
    );
    expect(contextLayerDescriptors(viewer)).toEqual([
      {
        id: 'a',
        name: 'Scan A',
        bounds: { minX: 499950, minY: 3999980, maxX: 500050, maxY: 4000020 },
      },
    ]);
  });

  it('describes a streaming layer from its tight data bounds and render origin', () => {
    const viewer = viewerWith(new Map(), {
      name: 'Remote COPC',
      renderOrigin: [600000, 5000000, 0],
      // Box6 is [minX, minY, minZ, maxX, maxY, maxZ].
      dataBounds: () => [-10, -25, -1, 30, 15, 9],
    });
    expect(contextLayerDescriptors(viewer)).toEqual([
      {
        id: 'streaming',
        name: 'Remote COPC',
        bounds: { minX: 599990, minY: 4999975, maxX: 600030, maxY: 5000015 },
      },
    ]);
  });

  it('skips a registered id whose cloud has already gone', () => {
    const viewer = {
      clouds: () => ['gone'],
      getCloud: () => undefined,
      streamingCloud: null,
    } as unknown as Viewer;
    expect(contextLayerDescriptors(viewer)).toEqual([]);
  });
});

describe('createContextViewHost', () => {
  it('reads live state on every call and answers nothing before the Viewer resolves', () => {
    const clouds = new Map<string, StubCloud>();
    let ready = false;
    let crs: ResolvedCrs | null = null;
    const host = createContextViewHost({
      getViewer: () => viewerWith(clouds),
      isViewerReady: () => ready,
      getCrs: () => crs,
    });

    // Before the lazy Viewer chunk resolves there is nothing to describe, and
    // the host must not dereference it to find that out.
    expect(host.listLayers()).toEqual([]);
    expect(host.currentCrs()).toBeNull();

    ready = true;
    clouds.set('a', cloud('Scan A', [0, 0, 0]));
    crs = { kind: 'projected', name: 'Test CRS' } as unknown as ResolvedCrs;
    expect(host.listLayers()).toHaveLength(1);
    expect(host.currentCrs()?.name).toBe('Test CRS');
  });

  it('defaults to a converter that refuses rather than guessing an unknown pair', () => {
    const host = createContextViewHost({
      getViewer: () => viewerWith(new Map()),
      isViewerReady: () => true,
      getCrs: () => null,
    });
    const local = { kind: 'local', name: 'Local frame' } as unknown as ResolvedCrs;
    const out = host.converter().toGeographic({ x: 1, y: 2, z: 3 }, local);
    expect(out.ok).toBe(false);
  });
});
