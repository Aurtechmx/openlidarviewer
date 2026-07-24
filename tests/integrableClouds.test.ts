/**
 * tests/integrableClouds.test.ts
 *
 * The point-integration walks (volume, profile, terrain, lasso) must feed only
 * the clouds the picker will place vertices on — visible and unlocked. This
 * pins the shared predicate so a hidden or locked reference layer can never
 * contaminate a cut/fill, profile, DTM, or lasso drawn against the layers the
 * user can actually see.
 */

import { describe, it, expect } from 'vitest';
import { integrableClouds, isIntegrable, streamingMayCombine, sourceClassifiesGround } from '../src/render/integrableClouds';

const entry = (visible: boolean, locked?: boolean) => ({
  mesh: { visible },
  locked,
  tag: `${visible}/${locked}`,
});

describe('isIntegrable', () => {
  it('includes a visible, unlocked entry', () => {
    expect(isIntegrable(entry(true))).toBe(true);
    expect(isIntegrable(entry(true, false))).toBe(true);
  });

  it('excludes a hidden entry even when unlocked', () => {
    expect(isIntegrable(entry(false))).toBe(false);
  });

  it('excludes a locked entry even when visible', () => {
    expect(isIntegrable(entry(true, true))).toBe(false);
  });
});

describe('integrableClouds', () => {
  it('keeps only visible, unlocked entries and preserves order', () => {
    const a = entry(true); // in
    const b = entry(false); // hidden — out
    const c = entry(true, true); // locked — out
    const d = entry(true, false); // in
    const kept = integrableClouds([a, b, c, d]);
    expect(kept).toEqual([a, d]);
  });

  it('returns an empty array when every entry is hidden or locked', () => {
    expect(integrableClouds([entry(false), entry(true, true)])).toEqual([]);
  });
});

/**
 * A combined estimator may only merge layers PROVEN to share the frame.
 *
 * The rule was visible-and-unlocked, which says nothing about coordinates.
 * A layer the project frame had marked unaligned — a foreign CRS, or a cloud
 * with no declared CRS at all — stayed in its own coordinate frame and was
 * still fed into terrain, profile, cut/fill volume and lasso. The result is
 * not a degraded estimate; it is points from two unrelated frames averaged
 * into one surface, and the panel warning does not stop the number being used.
 */
describe('frame compatibility gates the integration walk', () => {
  const entry = (over: Partial<{ visible: boolean; locked: boolean; frame: string }> = {}) => ({
    mesh: { visible: over.visible ?? true },
    locked: over.locked ?? false,
    compatibility: (over.frame ?? 'verified') as never,
  });

  it('integrates a verified layer', () => {
    expect(isIntegrable(entry())).toBe(true);
  });

  it('REFUSES a layer whose CRS is unknown', () => {
    expect(isIntegrable(entry({ frame: 'unknown' }))).toBe(false);
  });

  it('REFUSES a layer proven to be a different frame', () => {
    expect(isIntegrable(entry({ frame: 'incompatible' }))).toBe(false);
  });

  it('REFUSES a horizontal-only layer from combined estimates', () => {
    // It is genuinely placed in X/Y, and its heights are not on the project's
    // vertical reference — a merged surface or volume would be unfounded.
    expect(isIntegrable(entry({ frame: 'horizontal-only' }))).toBe(false);
  });

  it('still honours visibility and lock for a verified layer', () => {
    expect(isIntegrable(entry({ visible: false }))).toBe(false);
    expect(isIntegrable(entry({ locked: true }))).toBe(false);
  });

  it('treats an entry with no stated compatibility as verified', () => {
    // The single-scan path carries no classification; it must be unchanged.
    expect(isIntegrable({ mesh: { visible: true } })).toBe(true);
  });
});

/**
 * One layer on its own is always analysable, whatever its compatibility.
 *
 * Requiring `verified` is right when several layers are merged into one
 * estimator. It is wrong when there is only one: a horizontal-only, unknown or
 * purely local scan analysed BY ITSELF involves no cross-frame combination at
 * all, so there is nothing to prove. Gating it produced a terrain run with no
 * points — the tool refusing to measure a single file because of a
 * relationship that was not being used.
 */
describe('single-layer analysis needs no cross-frame proof', () => {
  const one = (compatibility: string) => [
    { mesh: { visible: true }, compatibility: compatibility as never },
  ];

  it.each(['verified', 'horizontal-only', 'unknown', 'incompatible'])(
    'analyses a lone %s layer in its own frame',
    (state) => {
      expect(integrableClouds(one(state))).toHaveLength(1);
    },
  );

  it('still refuses to MERGE an unproven layer with a verified one', () => {
    const set = [
      { mesh: { visible: true }, compatibility: 'verified' as never },
      { mesh: { visible: true }, compatibility: 'unknown' as never },
    ];
    expect(integrableClouds(set)).toHaveLength(1);
  });

  it('a lone layer that is hidden or locked is still excluded', () => {
    expect(integrableClouds([{ mesh: { visible: false }, compatibility: 'unknown' as never }])).toHaveLength(0);
    expect(integrableClouds([{ mesh: { visible: true }, locked: true, compatibility: 'unknown' as never }])).toHaveLength(0);
  });

  it('soloing an unproven layer leaves exactly that layer analysable', () => {
    // The reported workflow: two layers loaded, the horizontal-only one soloed.
    const set = [
      { mesh: { visible: false }, compatibility: 'verified' as never },
      { mesh: { visible: true }, compatibility: 'horizontal-only' as never },
    ];
    expect(integrableClouds(set)).toHaveLength(1);
  });
});

/**
 * Streaming sources must clear the same bar as static ones.
 *
 * Static clouds go through `integrableClouds`; COPC/EPT resident nodes were
 * appended straight into terrain, profile, volume and count walks with no
 * check at all. So a streamed scan and a static one in different CRSs — or on
 * different vertical datums — still merged into one estimator, which is the
 * defect the static gate exists to prevent, in the one source type it did not
 * cover.
 *
 * The single-source carve-out applies here too: a stream on its own is
 * analysed in its own frame, because nothing is being combined.
 */
describe('streamingMayCombine', () => {
  it('lets a lone stream be analysed in its own frame', () => {
    for (const s of ['verified', 'horizontal-only', 'unknown', 'incompatible'] as const) {
      expect(streamingMayCombine(0, s, false)).toBe(true);
    }
  });

  it('requires proof once a static layer is also in the walk', () => {
    expect(streamingMayCombine(1, 'verified', true)).toBe(true);
    expect(streamingMayCombine(1, 'horizontal-only', true)).toBe(false);
    expect(streamingMayCombine(1, 'unknown', true)).toBe(false);
    expect(streamingMayCombine(1, 'incompatible', true)).toBe(false);
  });

  it('has nothing to contribute when no stream is open', () => {
    expect(streamingMayCombine(0, null, false)).toBe(false);
    expect(streamingMayCombine(3, null, true)).toBe(false);
  });

  it('scales past a single static layer', () => {
    expect(streamingMayCombine(5, 'unknown', true)).toBe(false);
    expect(streamingMayCombine(5, 'verified', true)).toBe(true);
  });
});

/**
 * "Classified ground" is a claim about the FILE, not about our own filter.
 *
 * The provenance flag asked whether the viewer had ATTACHED a derived
 * classification. A LAS that carries a classification array of all zeros —
 * ASPRS class 0, "created, never classified" — has attached nothing, so the
 * flag read false and the review panel announced "Classified ground" for a
 * scan whose own report said `unclassified (0.0 % coverage)` and whose banner
 * said "points aren't classified to ground". Three surfaces, one file, two
 * contradicting answers.
 *
 * The question that matters is whether any source point is actually
 * classified as ground. An array full of zeros is the absence of a
 * classification, not the presence of one.
 */
describe('sourceClassifiesGround', () => {
  const GROUND = 2;

  it('is false for an all-zeros array — class 0 is "never classified"', () => {
    expect(sourceClassifiesGround(new Uint8Array(64))).toBe(false);
  });

  it('is false when nothing is ground, even with other classes present', () => {
    // Vegetation and buildings are classified; ground is not.
    expect(sourceClassifiesGround(Uint8Array.from([1, 3, 4, 5, 6, 6, 5]))).toBe(false);
  });

  it('is true as soon as one point is ground', () => {
    expect(sourceClassifiesGround(Uint8Array.from([1, 1, GROUND, 5]))).toBe(true);
    expect(sourceClassifiesGround(Uint8Array.from([GROUND]))).toBe(true);
  });

  it('is false for an absent array', () => {
    expect(sourceClassifiesGround(undefined)).toBe(false);
    expect(sourceClassifiesGround(new Uint8Array(0))).toBe(false);
  });
});

/**
 * Merging requires layers to be IN one frame, not merely compatible with it.
 *
 * Compatibility says two layers COULD share a frame. Mounting is what actually
 * puts them there. Those came apart the moment multi-layer rebasing was made
 * switchable: with the mount disabled, two `verified` layers still satisfied
 * the compatibility gate while sitting at their own separate origins, so a
 * combined estimator would have averaged points a kilometre apart as though
 * they were neighbours — a worse failure than the precision cost the switch
 * exists to avoid.
 *
 * So a merge needs both: proven compatibility AND an actual mount.
 */
describe('merging requires an actual mount', () => {
  const layer = (over: Partial<{ mounted: boolean; compatibility: string }> = {}) => ({
    mesh: { visible: true },
    compatibility: (over.compatibility ?? 'verified') as never,
    mounted: over.mounted,
  });

  it('merges two verified layers that are mounted', () => {
    expect(integrableClouds([layer({ mounted: true }), layer({ mounted: true })])).toHaveLength(2);
  });

  it('REFUSES to merge verified layers that were never mounted', () => {
    expect(integrableClouds([layer({ mounted: false }), layer({ mounted: false })])).toHaveLength(0);
  });

  it('treats an unstated mount as mounted, leaving existing callers alone', () => {
    expect(integrableClouds([layer(), layer()])).toHaveLength(2);
  });

  it('still analyses a lone unmounted layer in its own frame', () => {
    // Nothing is being combined, so there is nothing to be in one frame with.
    expect(integrableClouds([layer({ mounted: false })])).toHaveLength(1);
  });
});

/**
 * A stream and a static cloud are recentred about DIFFERENT origins.
 *
 * Static points are local to `cloud.origin`; resident streaming nodes are
 * local to `streaming.renderOrigin`. Those are independent numbers. Two
 * sources can therefore agree perfectly on CRS and vertical datum — both
 * classify `verified` — and still have local arrays that mean different
 * places: a point at local [10, 10, 2] in each is 1,000 m apart in the world
 * if their origins differ by that much.
 *
 * The static path already refuses this: merging needs a layer to be MOUNTED,
 * not merely compatible. Streaming bypassed `integrableClouds` entirely and
 * was judged on compatibility alone, so the check landed on one source type
 * and not the other. Mounting is disabled in v0.6.0, so nothing is in a
 * shared frame and the honest answer is that a stream never joins a static
 * estimator.
 */
describe('streaming must share a MOUNTED frame, not just a CRS', () => {
  it('refuses a verified stream when a static layer is present but unmounted', () => {
    expect(streamingMayCombine(1, 'verified', false)).toBe(false);
  });

  it('refuses regardless of how many static layers there are', () => {
    expect(streamingMayCombine(4, 'verified', false)).toBe(false);
  });

  it('still allows a stream analysed entirely on its own', () => {
    // Nothing is being combined, so there is no second origin to disagree with.
    expect(streamingMayCombine(0, 'verified', false)).toBe(true);
    expect(streamingMayCombine(0, 'unknown', false)).toBe(true);
  });

  it('would allow it again once both are genuinely mounted', () => {
    // The rule is about frames, not about the alpha. When mounting returns,
    // a verified AND mounted stream joins without this needing to change.
    expect(streamingMayCombine(1, 'verified', true)).toBe(true);
  });
});
