/**
 * Step 1 of the project-frame wiring: frame ownership on AppContext.
 *
 * The bug this exists to fix: every cloud is recentred about its OWN
 * `floor(min)` origin, so two georeferenced scans that sit kilometres apart in
 * the world both land near local zero and render overlaid. This service owns the
 * ONE origin every layer maps into, and each layer's translation into it.
 *
 * The load-bearing property is the degenerate case: a single layer must resolve
 * to an identity transform, because that is what keeps the existing single-scan
 * path byte-identical while the frame is wired in behind it.
 */

import { describe, it, expect } from 'vitest';
import { createAppContext } from '../src/app/appContext';
import { createProjectFrameService } from '../src/app/projectFrame';

type Vec3 = readonly [number, number, number];
import { sourceLocalToProjectLocal, projectLocalToSourceLocal } from '../src/geo/ProjectSpatialFrame';

const svc = () => createProjectFrameService(createAppContext());

describe('project frame — the degenerate single-layer case', () => {
  it('has no frame before any layer registers', () => {
    const s = svc();
    expect(s.frame).toBeNull();
    expect(s.transformFor('nothing')).toBeNull();
  });

  it('a lone layer anchors the frame at its own origin', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [500_000, 4_500_000, 100] });
    expect(s.frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
  });

  it('a lone layer gets an IDENTITY transform — the single-scan path is unchanged', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [500_000, 4_500_000, 100] });
    const t = s.transformFor('a')!;
    expect(t.sourceToProject).toEqual([0, 0, 0]);
    expect(t.projectToSource).toEqual([-0, -0, -0]);
    // A point keeps its coordinates: no rebase, no precision change.
    expect(sourceLocalToProjectLocal(t, [1.25, 2.5, 3])).toEqual([1.25, 2.5, 3]);
  });

  it('floors a fractional origin so the frame sits on a whole unit', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [500_000.75, 4_500_000.25, 100.9] });
    expect(s.frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
  });
});

describe('project frame — two layers at different origins', () => {
  // The actual defect: without a shared frame these two both sit at local zero
  // and appear on top of each other, 1 km apart in reality.
  const twoLayers = () => {
    const s = svc();
    s.register({ id: 'west', sourceOrigin: [500_000, 4_500_000, 100], crsKey: 'EPSG:32612' });
    s.register({ id: 'east', sourceOrigin: [501_000, 4_500_000, 120], crsKey: 'EPSG:32612' });
    return s;
  };

  it('anchors the frame at the per-axis minimum', () => {
    expect(twoLayers().frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
  });

  it('separates the layers by their TRUE offset instead of overlaying them', () => {
    const s = twoLayers();
    expect(s.transformFor('west')!.sourceToProject).toEqual([0, 0, 0]);
    expect(s.transformFor('east')!.sourceToProject).toEqual([1_000, 0, 20]);
  });

  it('puts a point from each layer at its true relative position', () => {
    const s = twoLayers();
    // The same source-local point in both layers is 1 km apart in the project.
    const w = sourceLocalToProjectLocal(s.transformFor('west')!, [0, 0, 0]);
    const e = sourceLocalToProjectLocal(s.transformFor('east')!, [0, 0, 0]);
    expect(e[0] - w[0]).toBe(1_000);
  });

  it('keeps every project-local residual non-negative (the precision contract)', () => {
    // The frame sits at or below every layer's minimum, so residuals stay small
    // and positive — the same Float32-safe range one cloud keeps today.
    const s = twoLayers();
    for (const id of ['west', 'east']) {
      const p = sourceLocalToProjectLocal(s.transformFor(id)!, [0, 0, 0]);
      expect(p[0]).toBeGreaterThanOrEqual(0);
      expect(p[1]).toBeGreaterThanOrEqual(0);
      expect(p[2]).toBeGreaterThanOrEqual(0);
    }
  });

  it('round-trips a point back to its own source frame exactly', () => {
    const t = twoLayers().transformFor('east')!;
    const src: [number, number, number] = [12.5, -3.25, 7];
    expect(projectLocalToSourceLocal(t, sourceLocalToProjectLocal(t, src))).toEqual(src);
  });
});

describe('project frame — the layer set changing', () => {
  it('re-anchors when the layer holding the minimum is removed', () => {
    const s = svc();
    s.register({ id: 'low', sourceOrigin: [500_000, 4_500_000, 100] });
    s.register({ id: 'high', sourceOrigin: [501_000, 4_500_500, 120] });
    s.unregister('low');
    expect(s.frame?.projectOrigin).toEqual([501_000, 4_500_500, 120]);
    // The survivor is now the anchor, so it is back to identity.
    expect(s.transformFor('high')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('drops the transform of an unregistered layer', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [0, 0, 0] });
    s.unregister('a');
    expect(s.transformFor('a')).toBeNull();
    expect(s.frame).toBeNull();
  });

  it('re-registering an id updates it rather than adding a duplicate', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [500_000, 0, 0] });
    s.register({ id: 'a', sourceOrigin: [400_000, 0, 0] });
    expect(s.frame?.projectOrigin).toEqual([400_000, 0, 0]);
    expect(s.transformFor('a')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('clear drops the frame and every transform', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [1, 2, 3] });
    s.register({ id: 'b', sourceOrigin: [4, 5, 6] });
    s.clear();
    expect(s.frame).toBeNull();
    expect(s.transformFor('a')).toBeNull();
  });

  it('unregistering an unknown id is a no-op', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [1, 2, 3] });
    s.unregister('ghost');
    expect(s.frame?.projectOrigin).toEqual([1, 2, 3]);
  });
});

describe('project frame — a layer the caller marks foreign is excluded', () => {
  // Whether two layers share a frame is decided by the layer model, which weighs
  // the horizontal CRS AND the vertical datum together; this service is told the
  // verdict. It used to compare horizontal keys itself, which let the layer panel
  // flag a pair as mismatched while the frame quietly folded both their Z origins
  // into one anchor.
  //
  // The foreign layer sits BELOW the aligned one on every axis, so if it were
  // wrongly included the shared anchor would move to it. A fixture where the
  // foreign origin is larger cannot detect that — `min` returns the same answer
  // either way — and an earlier version of this test made exactly that mistake.
  const mixed = () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [500_000, 4_500_000, 100], crsKey: 'EPSG:32612' });
    s.register({
      id: 'b',
      sourceOrigin: [300_000, 3_000_000, 10],
      crsKey: 'EPSG:32613',
      alignedToProject: false,
    });
    return s;
  };

  it('reports the excluded layer', () => {
    expect(mixed().unaligned).toEqual(['b']);
  });

  it('ignores the foreign origin when anchoring', () => {
    // Otherwise one CRS's easting drags the shared anchor into territory that
    // describes neither layer.
    expect(mixed().frame?.projectOrigin).toEqual([500_000, 4_500_000, 100]);
  });

  it('keeps the aligned layer at identity despite the foreign layer being lower', () => {
    // The consequence of a dragged anchor: the layer that DOES belong to the
    // frame stops being at its own origin and renders 200 km off.
    expect(mixed().transformFor('a')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('mounts the foreign layer in its OWN frame (identity), not a wrong one', () => {
    // Reprojection is out of scope, so the honest placement is where it already
    // was — displaced, but not asserted into a frame it does not belong to.
    expect(mixed().transformFor('b')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('labels the frame from the layers that belong to it, not the foreign one', () => {
    expect(mixed().frame?.crs).toBe('EPSG:32612');
  });

  it('has no shared frame when EVERY layer is foreign', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [1, 2, 3], alignedToProject: false });
    expect(s.frame).toBeNull();
    // Each still mounts where it was, rather than vanishing.
    expect(s.transformFor('a')!.sourceToProject).toEqual([0, 0, 0]);
  });

  it('treats an undeclared CRS as alignable — absence of evidence is not disagreement', () => {
    // Two meshes from one capture declare no CRS at all; excluding them would
    // regress the ordinary PLY/OBJ case into never sharing a frame.
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [0, 0, 0] });
    s.register({ id: 'b', sourceOrigin: [10, 0, 0] });
    expect(s.unaligned).toEqual([]);
    expect(s.transformFor('b')!.sourceToProject).toEqual([10, 0, 0]);
  });

  it('lists undeclared-CRS layers separately so the UI can disclose them', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [0, 0, 0], crsKey: 'EPSG:32612' });
    s.register({ id: 'b', sourceOrigin: [10, 0, 0] });
    expect(s.unknownCrs).toEqual(['b']);
    expect(s.unaligned).toEqual([]);
  });
});

describe('project frame — reconcile replaces the whole set', () => {
  it('drops a layer that is absent from the new set', () => {
    // The property that makes this safer than register/unregister at the call
    // site: a layer the app no longer has cannot leave a stale transform behind.
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [100, 0, 0] });
    s.register({ id: 'b', sourceOrigin: [200, 0, 0] });
    s.reconcile([{ id: 'b', sourceOrigin: [200, 0, 0] }]);
    expect(s.transformFor('a')).toBeNull();
    expect(s.frame?.projectOrigin).toEqual([200, 0, 0]);
  });

  it('an empty set clears the frame', () => {
    const s = svc();
    s.register({ id: 'a', sourceOrigin: [1, 2, 3] });
    s.reconcile([]);
    expect(s.frame).toBeNull();
  });

  it('lands the same result as registering each layer individually', () => {
    const layers = [
      { id: 'a', sourceOrigin: [500_000, 4_500_000, 100] as Vec3, crsKey: 'EPSG:32612' },
      { id: 'b', sourceOrigin: [501_000, 4_500_000, 120] as Vec3, crsKey: 'EPSG:32612' },
    ];
    const one = svc();
    for (const l of layers) one.register(l);
    const many = svc();
    many.reconcile(layers);
    expect(many.frame).toEqual(one.frame);
    expect(many.transformFor('b')).toEqual(one.transformFor('b'));
  });
});

describe('project frame — writes through to the shared context', () => {
  it('stores the frame on the AppContext cluster the panels read', () => {
    const ctx = createAppContext();
    const s = createProjectFrameService(ctx);
    s.register({ id: 'a', sourceOrigin: [1, 2, 3] });
    expect(ctx.projectFrame.frame).toBe(s.frame);
    expect(ctx.projectFrame.transforms.get('a')).toBe(s.transformFor('a'));
  });
});

/**
 * The vertical anchor comes only from layers whose height reference is proven.
 *
 * A `horizontal-only` layer is one we have explicitly said we cannot trust in
 * Z — and it was still eligible to supply the project's Z origin, the datum
 * every VERIFIED layer then gets rebased onto. So an unproven height could
 * silently define the reference for the proven ones, which is the exact
 * inversion the compatibility states exist to prevent.
 *
 * X/Y and Z are therefore anchored separately: the horizontal origin from
 * every aligned layer, the vertical origin from the verified ones alone.
 */
describe('vertical anchor is drawn only from verified layers', () => {
  const svc = () => createProjectFrameService(createAppContext());

  it('takes Z from the verified layer, not the lower horizontal-only one', () => {
    const s = svc();
    s.reconcile([
      { id: 'verified', sourceOrigin: [500_000, 4_500_000, 100], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: true },
      { id: 'horizOnly', sourceOrigin: [499_000, 4_500_000, 10], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: false },
    ]);
    // X/Y still come from the full aligned set — that agreement is real.
    expect(s.frame!.projectOrigin[0]).toBe(499_000);
    expect(s.frame!.projectOrigin[1]).toBe(4_500_000);
    // Z comes only from the layer whose vertical reference was proven.
    expect(s.frame!.projectOrigin[2]).toBe(100);
  });

  it('takes the lowest Z across several verified layers', () => {
    const s = svc();
    s.reconcile([
      { id: 'a', sourceOrigin: [500_000, 4_500_000, 100], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: true },
      { id: 'b', sourceOrigin: [501_000, 4_500_000, 40], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: true },
      { id: 'c', sourceOrigin: [499_000, 4_500_000, 5], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: false },
    ]);
    expect(s.frame!.projectOrigin[2]).toBe(40);
  });

  it('falls back to the aligned set when nothing is vertically verified', () => {
    // No layer will be rebased in Z in this state, so the value is unused —
    // but it must still be a real number from the data, not an invented zero.
    const s = svc();
    s.reconcile([
      { id: 'a', sourceOrigin: [500_000, 4_500_000, 70], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: false },
      { id: 'b', sourceOrigin: [501_000, 4_500_000, 90], crsKey: 'epsg:32612', alignedToProject: true, alignsVertically: false },
    ]);
    expect(s.frame!.projectOrigin[2]).toBe(70);
  });

  it('treats an omitted alignsVertically as verified, keeping old callers intact', () => {
    const s = svc();
    s.reconcile([
      { id: 'a', sourceOrigin: [500_000, 4_500_000, 100], crsKey: 'epsg:32612', alignedToProject: true },
      { id: 'b', sourceOrigin: [499_000, 4_500_000, 20], crsKey: 'epsg:32612', alignedToProject: true },
    ]);
    expect(s.frame!.projectOrigin[2]).toBe(20);
  });
});
