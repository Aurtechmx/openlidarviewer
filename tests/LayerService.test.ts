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
  /** Real resolved CRSs always carry this; the precision gate needs it. */
  linearUnitToMetres?: number;
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
  /** The origin the FILE declared — fixed, whatever the frame does to `origin`. */
  sourceOrigin?: readonly [number, number, number];
  /** Float32 step a mount would land on; fixtures are close together, so 0. */
  rebaseQuantum?: number;
}

function setup(clouds: Record<string, FakeCloud>, locked: Set<string> = new Set()) {
  // A freshly loaded cloud's source origin IS its origin — the constructor
  // copies it. Defaulting here (as a COPY, so the rebase cannot reach it)
  // keeps every fixture honest about the real object's shape.
  for (const c of Object.values(clouds)) {
    if (c.origin && !c.sourceOrigin) c.sourceOrigin = [c.origin[0], c.origin[1], c.origin[2]];
    // A resolved projected CRS always states its linear unit — the resolver
    // defaults it to metre. Fixtures must carry it too, or they would be
    // testing the "unit unknown" refusal rather than the case they describe.
    const crs = c.metadata?.crs;
    if (crs && !crs.isGeographic && crs.linearUnitToMetres === undefined) {
      crs.linearUnitToMetres = 1;
    }
  }
  const context = createAppContext();
  const visibleCalls: Array<[string, boolean]> = [];
  const soloCalls: Array<string | null> = [];
  const crsFlagCalls: Array<{ ids: string[]; summary: unknown }> = [];
  const compareCalls: boolean[] = [];
  let compassRefreshes = 0;

  const rebaseCalls = new Map<string, readonly [number, number, number]>();
  const restoreCalls: string[] = [];
  const compatCalls = new Map<string, string>();
  const viewer = {
    clouds: () => Object.keys(clouds),
    getCloud: (id: string) => {
      const c = clouds[id];
      if (!c) return null;
      // The real PointCloud exposes this; a mount consults it before moving
      // geometry. Tiny fixtures sit close together, so it is effectively zero.
      return { ...c, rebaseQuantum: () => c.rebaseQuantum ?? 0 };
    },
    isCloudLocked: (id: string) => locked.has(id),
    setCloudVisible: (id: string, on: boolean) => {
      visibleCalls.push([id, on]);
    },
    rebaseCloudToOrigin: (id: string, target: readonly [number, number, number]) => {
      rebaseCalls.set(id, target);
      // Mirror the real behaviour so a second refresh sees the moved origin.
      // `sourceOrigin` deliberately does NOT move: the whole point of the
      // field is that a rebase cannot reach it.
      const c = clouds[id];
      if (c?.origin) c.origin = [target[0], target[1], target[2]];
    },
    setCloudCompatibility: (id: string, c: string) => {
      compatCalls.set(id, c);
    },
    restoreCloudSourceFrame: (id: string) => {
      restoreCalls.push(id);
      const c = clouds[id];
      if (c?.sourceOrigin) c.origin = [c.sourceOrigin[0], c.sourceOrigin[1], c.sourceOrigin[2]];
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
    rebaseCalls,
    restoreCalls,
    compatCalls,
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
    // The survivor's origin IS the shared anchor now — the mount rebased its
    // data there — so the recomputed frame anchors at the CURRENT origin, not
    // the one the file was loaded with. That is the point: closing a sibling
    // must not move a mounted layer again.
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
    expect(t.projectFrame.transformFor('low')).toBeNull();
  });

  it('places a DIFFERENT-VERTICAL-DATUM layer in X/Y and leaves its height alone', () => {
    // Same horizontal CRS, different vertical datum. The horizontal agreement
    // is real and worth using; the heights are not comparable — NAVD88 and
    // ellipsoidal differ by tens of metres — so Z must not be folded onto the
    // shared anchor. Earlier this pair was excluded from the frame entirely,
    // which threw away a true alignment, AND both layers still fed the same
    // combined estimators. Now: aligned in plan, untouched in height, and out
    // of every merged result.
    const t = setup({
      a: { origin: [500_000, 4_500_000, 100], metadata: { crs: { epsg: 32612, verticalDatum: 'NAVD88' } } },
      b: { origin: [500_100, 4_500_000, 10], metadata: { crs: { epsg: 32612, verticalDatum: 'EPSG:4979' } } },
    });
    t.service.refreshCrsFlags();
    expect(t.compatCalls.get('b')).toBe('horizontal-only');
    // X/Y onto the project anchor, Z left on the layer's own origin.
    expect(t.rebaseCalls.get('b')).toEqual([500_000, 4_500_000, 10]);
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 10]);
  });

  it('still shares a frame when only ONE layer declares a vertical datum', () => {
    // Absence of evidence is not disagreement — the same rule the panel applies.
    const t = setup({
      a: { origin: [500_000, 4_500_000, 100], metadata: { crs: { epsg: 32612, verticalDatum: 'NAVD88' } } },
      b: { origin: [500_100, 4_500_000, 110], metadata: { crs: { epsg: 32612 } } },
    });
    t.service.refreshCrsFlags();
    expect(t.projectFrame.unaligned).toEqual([]);
    expect(t.projectFrame.transformFor('b')!.sourceToProject).toEqual([100, 0, 10]);
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


/**
 * Steps 2 + 4 as one mechanism: every aligned layer's DATA is rebased onto the
 * project origin. The first implementation translated the MESH instead, which
 * split the scene — rendering saw project space while picking, terrain, lasso,
 * volumes and export bounds still read cloud-local positions, so layers LOOKED
 * aligned while every calculation used a different frame.
 */
describe('LayerService rebases each aligned layer onto the project origin', () => {
  const utm = { epsg: 32612 };

  it('rebases every VERIFIED layer to the ONE project origin, all three axes', () => {
    const withDatum = { epsg: 32612, verticalDatum: 'EPSG:5703' };
    const t = setup({
      west: { origin: [500_000, 4_500_000, 100], metadata: { crs: withDatum } },
      east: { origin: [501_000, 4_500_000, 120], metadata: { crs: withDatum } },
    });
    t.service.refreshCrsFlags();
    expect(t.compatCalls.get('east')).toBe('verified');
    expect(t.rebaseCalls.get('west')).toEqual([500_000, 4_500_000, 100]);
    expect(t.rebaseCalls.get('east')).toEqual([500_000, 4_500_000, 100]);
  });

  it('does NOT fold Z when neither layer declares a vertical datum', () => {
    // Undeclared is not agreed. Two scans can share a UTM zone and still be
    // metres against feet, or orthometric against ellipsoidal.
    const t = setup({
      west: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
      east: { origin: [501_000, 4_500_000, 120], metadata: { crs: utm } },
    });
    t.service.refreshCrsFlags();
    expect(t.compatCalls.get('east')).toBe('horizontal-only');
    expect(t.rebaseCalls.get('east')).toEqual([500_000, 4_500_000, 120]);
  });

  it('keeps an UNDECLARED-CRS layer out of the frame entirely', () => {
    // The reported defect: a mesh with no CRS mounted beside a georeferenced
    // scan because nothing had contradicted it.
    const t = setup({
      scan: { origin: [500_000, 4_500_000, 100], metadata: { crs: { epsg: 32612, verticalDatum: 'EPSG:5703' } } },
      mesh: { origin: [0, 0, 0], metadata: null },
    });
    t.service.refreshCrsFlags();
    expect(t.compatCalls.get('mesh')).toBe('unknown');
    expect(t.rebaseCalls.has('mesh')).toBe(false);
    expect(t.restoreCalls).toContain('mesh');
  });

  it('refuses a mount that would cost more than a millimetre of Float32', () => {
    // Distant layers are placed correctly only by spending the mantissa the
    // residual was using. Past the budget the layer keeps its own frame and
    // is reported as not in the project's.
    const withDatum = { epsg: 32612, verticalDatum: 'EPSG:5703' };
    const t = setup({
      near: { origin: [500_000, 4_500_000, 0], metadata: { crs: withDatum } },
      far: { origin: [600_000, 4_500_000, 0], metadata: { crs: withDatum }, rebaseQuantum: 0.0078 },
    });
    t.service.refreshCrsFlags();
    expect(t.compatCalls.get('far')).toBe('incompatible');
    expect(t.rebaseCalls.has('far')).toBe(false);
  });

  it('a lone layer rebases to its own origin — the identity, single-scan path unchanged', () => {
    const t = setup({ only: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } } });
    t.service.refreshCrsFlags();
    expect(t.rebaseCalls.get('only')).toEqual([500_000, 4_500_000, 100]);
  });

  it('never rebases a layer outside the frame', () => {
    // An unreferenced mesh has no origin to rebase; a foreign-CRS layer must
    // not be dragged onto an origin computed in a different CRS.
    const t = setup({
      mesh: { metadata: { crs: null } },
      scan: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
      foreign: { origin: [300_000, 3_000_000, 10], metadata: { crs: { epsg: 32613 } } },
    });
    t.service.refreshCrsFlags();
    expect(t.rebaseCalls.has('mesh')).toBe(false);
    expect(t.rebaseCalls.has('foreign')).toBe(false);
    expect(t.rebaseCalls.get('scan')).toEqual([500_000, 4_500_000, 100]);
  });

  it('re-anchors survivors when the anchor layer is removed', () => {
    const clouds: Record<string, FakeCloud> = {
      low: { origin: [500_000, 4_500_000, 100], metadata: { crs: utm } },
      high: { origin: [501_000, 4_500_000, 120], metadata: { crs: utm } },
    };
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    // Both now sit at the shared anchor (the harness mirrors the origin move).
    delete clouds.low;
    t.service.refreshCrsFlags();
    // The survivor's origin IS the old anchor now; the new frame anchors there,
    // so the rebase is the identity — no spurious movement on layer close.
    expect(t.rebaseCalls.get('high')).toEqual([500_000, 4_500_000, 100]);
  });
});

/**
 * Leaving the project frame puts a layer back where its file said it was.
 *
 * `rebaseOrigin` overwrote `origin`, and this service re-read that same live
 * `origin` as the layer's "source origin" on every reconcile — so one refresh
 * after a rebase the frame had overwritten its own record of where the layer
 * came from. A layer later found incompatible stayed parked on the project
 * origin with nothing left that could put it back.
 */
describe('LayerService project-frame reversibility', () => {
  const utm13 = { epsg: 32613, name: 'UTM13N' };
  const alignedPair = () => ({
    a: {
      name: 'A', pointCount: 10, metadata: { crs: { ...utm13 } },
      origin: [500_000, 4_500_000, 0] as readonly [number, number, number],
      sourceOrigin: [500_000, 4_500_000, 0] as readonly [number, number, number],
    },
    b: {
      name: 'B', pointCount: 20, metadata: { crs: { ...utm13 } },
      origin: [501_000, 4_500_000, 0] as readonly [number, number, number],
      sourceOrigin: [501_000, 4_500_000, 0] as readonly [number, number, number],
    },
  });

  it('anchors both layers on the shared origin while they agree', () => {
    const clouds = alignedPair();
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 0]);
    expect(clouds.b.origin).toEqual([500_000, 4_500_000, 0]);
  });

  it('restores a layer whose CRS turns out to be incompatible', () => {
    const clouds = alignedPair();
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    expect(clouds.b.origin).toEqual([500_000, 4_500_000, 0]); // mounted

    // The override the audit describes: B is now a different frame entirely.
    clouds.b.metadata = { crs: { epsg: 25832, name: 'ETRS89 / UTM32N' } };
    t.service.refreshCrsFlags();

    expect(t.restoreCalls).toContain('b');
    expect(clouds.b.origin).toEqual([501_000, 4_500_000, 0]);
  });

  it('keeps describing B by its FILE offset after B has been mounted', () => {
    // The discriminating assertion. Seeding from the LIVE origin made B's
    // offset collapse to zero the moment it mounted — the frame forgot that B
    // came from 1 km east, which is precisely the relationship a
    // source-coordinate export or an audit needs to read back.
    const clouds = alignedPair();
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 0]);
    expect(t.projectFrame.transformFor('b')!.sourceToProject).toEqual([1_000, 0, 0]);
    expect(clouds.b.sourceOrigin).toEqual([501_000, 4_500_000, 0]);
  });

  it('re-anchors when the layer set is replaced wholesale', () => {
    // The anchor persists only while it still describes the set. A different
    // project's layers must not inherit the previous one's origin.
    const clouds: Record<string, FakeCloud> = alignedPair();
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([500_000, 4_500_000, 0]);

    delete clouds.a;
    delete clouds.b;
    clouds.c = {
      name: 'C', pointCount: 5, metadata: { crs: { ...utm13 } },
      origin: [700_000, 4_500_000, 0], sourceOrigin: [700_000, 4_500_000, 0],
    };
    t.service.refreshCrsFlags();
    expect(t.projectFrame.frame?.projectOrigin).toEqual([700_000, 4_500_000, 0]);
  });

  it('does not restore a layer that is still aligned', () => {
    const clouds = alignedPair();
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    t.service.refreshCrsFlags();
    expect(t.restoreCalls).toEqual([]);
  });
});

/**
 * Two defects in the frame gates I introduced, both reproduced.
 */
describe('LayerService frame gate corrections', () => {
  const navd = { epsg: 32612, verticalDatum: 'EPSG:5703' };

  it('restores the FILE height when a verified layer is demoted to horizontal-only', () => {
    // The reproduction: B mounts as verified and its live Z becomes the
    // project's. Its CRS then changes so the pair is only horizontal-only —
    // and the demotion read `cloud.origin[2]`, the Z the mount had already
    // overwritten, so B stayed pinned to a vertical datum the panel now says
    // is unverified. It must go back to the height its FILE declared.
    const clouds: Record<string, FakeCloud> = {
      a: { origin: [500_000, 4_500_000, 100], metadata: { crs: { ...navd } } },
      b: { origin: [500_100, 4_500_000, 200], metadata: { crs: { ...navd } } },
    };
    const t = setup(clouds);
    t.service.refreshCrsFlags();
    expect(t.compatCalls.get('b')).toBe('verified');
    expect(clouds.b.origin![2]).toBe(100); // mounted onto the project Z

    // Now B declares a different vertical datum → horizontal-only.
    clouds.b.metadata = { crs: { epsg: 32612, verticalDatum: 'EPSG:4979', linearUnitToMetres: 1 } };
    t.service.refreshCrsFlags();

    expect(t.compatCalls.get('b')).toBe('horizontal-only');
    expect(t.rebaseCalls.get('b')![2]).toBe(200); // the FILE's height, not 100
  });

  it('refuses a destructive mount on GEOGRAPHIC coordinates outright', () => {
    // The budget is in metres; the quantum is in source units. On degrees a
    // Float32 step of 9.5e-7 is ~10.6 cm and sailed through a gate named for
    // a millimetre. Degrees are not a linear metre frame, so the mount is
    // refused rather than converted.
    const geo = { epsg: 4326, verticalDatum: 'EPSG:5703', isGeographic: true };
    const t = setup({
      a: { origin: [-8, 41, 0], metadata: { crs: { ...geo } } },
      b: { origin: [-8.5, 41.5, 0], metadata: { crs: { ...geo } }, rebaseQuantum: 9.5367431640625e-7 },
    });
    t.service.refreshCrsFlags();
    expect(t.rebaseCalls.has('b')).toBe(false);
    expect(t.compatCalls.get('b')).toBe('incompatible');
  });

  it('converts the quantum through the CRS unit before judging it', () => {
    // A foot-based CRS: 0.004 ft is 1.2 mm, over budget, even though the raw
    // number looks comfortably under 0.001 "metres".
    const feet = { epsg: 2231, verticalDatum: 'EPSG:6360', linearUnitToMetres: 0.3048 };
    const t = setup({
      a: { origin: [500_000, 4_500_000, 0], metadata: { crs: { ...feet } } },
      b: { origin: [500_100, 4_500_000, 0], metadata: { crs: { ...feet } }, rebaseQuantum: 0.004 },
    });
    t.service.refreshCrsFlags();
    expect(t.rebaseCalls.has('b')).toBe(false);
  });

  it('still allows a foot mount comfortably inside the budget', () => {
    const feet = { epsg: 2231, verticalDatum: 'EPSG:6360', linearUnitToMetres: 0.3048 };
    const t = setup({
      a: { origin: [500_000, 4_500_000, 0], metadata: { crs: { ...feet } } },
      b: { origin: [500_100, 4_500_000, 0], metadata: { crs: { ...feet } }, rebaseQuantum: 0.001 },
    });
    t.service.refreshCrsFlags();
    expect(t.rebaseCalls.has('b')).toBe(true);
  });
});
