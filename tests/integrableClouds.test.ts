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
