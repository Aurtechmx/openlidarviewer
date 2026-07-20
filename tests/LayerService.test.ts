/**
 * tests/LayerService.test.ts
 *
 * Characterizes the LayerService extracted from main.ts in v0.6: it must map
 * loaded clouds to layer records, resolve effective visibility (explicit intent
 * + solo) onto the viewer, and surface CRS flags / compare-availability / the
 * compass — all reading and writing the shared AppContext. Behaviour must match
 * what the old free functions did.
 */

import { describe, it, expect } from 'vitest';
import { createLayerService } from '../src/app/LayerService';
import { createAppContext } from '../src/app/appContext';
import { createProjectFrameService } from '../src/app/projectFrame';
import type { Viewer } from '../src/render/Viewer';
import type { Inspector } from '../src/ui/Inspector';

interface FakeCrs {
  epsg?: number;
  name?: string;
  verticalDatum?: string | null;
  isGeographic?: boolean;
}
interface FakeCloud {
  name?: string;
  pointCount?: number;
  metadata?: { crs?: FakeCrs | null } | null;
  /** The cloud's `floor(min)` recentre origin, when it is georeferenced. */
  origin?: readonly [number, number, number];
}

function setup(clouds: Record<string, FakeCloud>, locked: Set<string> = new Set()) {
  const context = createAppContext();
  const visibleCalls: Array<[string, boolean]> = [];
  const soloCalls: Array<string | null> = [];
  const crsFlagCalls: Array<{ ids: string[]; summary: unknown }> = [];
  const compareCalls: boolean[] = [];
  let compassRefreshes = 0;

  const viewer = {
    clouds: () => Object.keys(clouds),
    getCloud: (id: string) => clouds[id] ?? null,
    isCloudLocked: (id: string) => locked.has(id),
    setCloudVisible: (id: string, on: boolean) => {
      visibleCalls.push([id, on]);
    },
  } as unknown as Viewer;

  const inspector = {
    setLayerSolo: (s: string | null) => {
      soloCalls.push(s);
    },
    setLayerCrsFlags: (ids: Set<string>, summary: unknown) => {
      crsFlagCalls.push({ ids: [...ids], summary });
    },
    setLayerCompareAvailable: (b: boolean) => {
      compareCalls.push(b);
    },
  } as unknown as Inspector;

  const projectFrame = createProjectFrameService(context);

  const service = createLayerService({
    getViewer: () => viewer,
    getInspector: () => inspector,
    context,
    refreshCompass: () => {
      compassRefreshes += 1;
    },
    projectFrame,
  });

  return {
    service,
    context,
    projectFrame,
    visibleCalls,
    soloCalls,
    crsFlagCalls,
    compareCalls,
    compassRefreshes: () => compassRefreshes,
  };
}

const twoClouds = {
  a: { name: 'A', pointCount: 10, metadata: { crs: { epsg: 32613, name: 'UTM13N' } } },
  b: { name: 'B', pointCount: 20, metadata: { crs: { epsg: 32613, name: 'UTM13N' } } },
};

describe('LayerService — buildLayerInfos', () => {
  it('maps each cloud, defaulting visibility to true and reflecting lock state', () => {
    const { service } = setup(twoClouds, new Set(['b']));
    const infos = service.buildLayerInfos();
    expect(infos.map((i) => i.id)).toEqual(['a', 'b']);
    expect(infos[0]).toMatchObject({ name: 'A', pointCount: 10, visible: true, locked: false });
    expect(infos[1]).toMatchObject({ locked: true, epsg: 32613, crsName: 'UTM13N' });
  });

  it('reflects the context visibility intent', () => {
    const { service, context } = setup(twoClouds);
    context.layers.visible.set('a', false);
    expect(service.buildLayerInfos()[0].visible).toBe(false);
  });
});

describe('LayerService — applyVisibility / setVisible / toggleSolo', () => {
  it('with no solo, pushes each layer intent to the viewer and clears solo on the Inspector', () => {
    const { service, visibleCalls, soloCalls } = setup(twoClouds);
    service.applyVisibility();
    expect(visibleCalls).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(soloCalls.at(-1)).toBeNull();
  });

  it('setVisible records intent on the context and re-applies', () => {
    const { service, context, visibleCalls } = setup(twoClouds);
    service.setVisible('a', false);
    expect(context.layers.visible.get('a')).toBe(false);
    expect(visibleCalls).toContainEqual(['a', false]);
    expect(visibleCalls).toContainEqual(['b', true]);
  });

  it('toggleSolo isolates a layer, then clears it when toggled again', () => {
    const { service, context, visibleCalls, soloCalls } = setup(twoClouds);
    service.toggleSolo('a');
    expect(context.layers.solo).toBe('a');
    expect(soloCalls.at(-1)).toBe('a');
    // Only the soloed layer stays visible.
    expect(visibleCalls).toContainEqual(['a', true]);
    expect(visibleCalls).toContainEqual(['b', false]);

    visibleCalls.length = 0;
    service.toggleSolo('a');
    expect(context.layers.solo).toBeNull();
    expect(visibleCalls).toEqual([
      ['a', true],
      ['b', true],
    ]);
  });
});

describe('LayerService — refreshCrsFlags', () => {
  it('marks compare available only with exactly two layers and refreshes the compass', () => {
    const two = setup(twoClouds);
    two.service.refreshCrsFlags();
    expect(two.compareCalls.at(-1)).toBe(true);
    expect(two.crsFlagCalls.length).toBe(1);
    expect(two.compassRefreshes()).toBe(1);

    const one = setup({ a: twoClouds.a });
    one.service.refreshCrsFlags();
    expect(one.compareCalls.at(-1)).toBe(false);
  });
});


/**
 * The project frame is seeded HERE, from the same layer-set reconciliation that
 * refreshes the CRS flags, rather than from the add/remove call sites in
 * main.ts. These pin that wiring: without it the frame stays null forever and
 * the shared-frame work is dead code — which is exactly what it was before.
 */
describe('LayerService seeds the shared project frame', () => {
  const utm = { epsg: 32612 };

  it('anchors the frame at the lowest origin across the loaded layers', () => {
    const t = setup({
      east: { origin: [501_000, 4_500_000, 120], metadata: { crs: utm } },
      west: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
    });
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
    expect(t.projectFrame.transformFor('east')!.sourceToProject).toEqual([1_000, 0, 20]);
  });

  it('leaves a single layer on the identity transform', () => {
    const t = setup({ only: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } } });
    t.service.refreshCrsFlags();
    expect(t.projectFrame.transformFor('only')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('skips a cloud with no origin instead of anchoring the project at zero', () => {
    // An unreferenced mesh at implicit zero would drag the anchor to 0 and push
    // the georeferenced scan 500 km out of frame.
    const t = setup({
      mesh: { metadata: { crs: null } },
      scan: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
    });
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
    expect(t.projectFrame.transformFor('mesh')).toBeNull();
    expect(t.projectFrame.transformFor('scan')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('re-anchors when a layer is removed and the set is refreshed', () => {
    const clouds: Record<string, FakeCloud> = {
      low: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
      high: { origin: [501_000, 4_500_000, 120], metadata: { crs: utm } },
    };
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    delete clouds.low;
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([501_000, 4_500_000, 120]);
    expect(t.projectFrame.transformFor('low')).toBeNull();
  });

  it('excludes a foreign-CRS layer from the anchor and flags it', () => {
    const t = setup({
      a: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
      b: { origin: [300_000, 3_000_000, 10], metadata: { crs: { epsg: 32613 } } },
    });
    t.service.refreshCrsFlags();
    expect(t.projectFrame.unaligned).toEqual(['b']);
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
  });
});
