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
import { integrableClouds, isIntegrable } from '../src/render/integrableClouds';

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
