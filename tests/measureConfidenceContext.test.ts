/**
 * measureConfidenceContext.test.ts
 *
 * `buildMeasureConfidenceContext` is the one seam that turns the live CRS into
 * the measure tool's `verticalReferenceKnown` fact — the flag that decides
 * whether a HEIGHT / VOLUME measurement reads "verified · datum resolved" or
 * carries the "vertical reference unknown" caveat. Roadmap P1 #6 routes it
 * through `verticalReferenceFromDatum` (the same classifier #229 gave the
 * Inspector), so a datum that is undeclared OR present-but-unrecognised fails
 * closed instead of quietly certifying a height it cannot name.
 *
 * Pure data in, pure data out, so it is unit-tested here against a minimal
 * viewer stub rather than the live app.
 */

import { describe, it, expect } from 'vitest';
import { buildMeasureConfidenceContext } from '../src/app/measureConfidenceContext';
import { confidenceForKind } from '../src/render/measure/measureConfidence';

/** A minimal viewer stub: only the two facts the builder reads. */
function viewer(datumResolved: boolean, cloudCount = 1) {
  return {
    measure: { datumResolved },
    clouds: () => new Array(cloudCount).fill(null) as ReadonlyArray<unknown>,
  };
}

describe('buildMeasureConfidenceContext — verticalReferenceKnown', () => {
  it('is false when the scene has no CRS at all', () => {
    expect(buildMeasureConfidenceContext(viewer(true), null).verticalReferenceKnown).toBe(false);
    expect(buildMeasureConfidenceContext(viewer(true), undefined).verticalReferenceKnown).toBe(
      false,
    );
  });

  it('is false when the CRS declares no vertical datum', () => {
    const ctx = buildMeasureConfidenceContext(viewer(true), { verticalDatum: null });
    expect(ctx.verticalReferenceKnown).toBe(false);
  });

  it('is false for a present-but-UNRECOGNISED datum string (the fix — was true)', () => {
    // Before P1 #6 the coarse `verticalDatum != null` check upgraded any
    // non-null string to "known"; an unclassifiable datum must fail closed.
    const ctx = buildMeasureConfidenceContext(viewer(true), {
      verticalDatum: 'Local Mine Grid vertical',
    });
    expect(ctx.verticalReferenceKnown).toBe(false);
  });

  it('is true for a recognised orthometric datum name (NAVD88)', () => {
    const ctx = buildMeasureConfidenceContext(viewer(true), { verticalDatum: 'NAVD88' });
    expect(ctx.verticalReferenceKnown).toBe(true);
  });

  it('is true for a recognised vertical EPSG code (5703 = NAVD88)', () => {
    const ctx = buildMeasureConfidenceContext(viewer(true), { verticalEpsg: 5703 });
    expect(ctx.verticalReferenceKnown).toBe(true);
  });

  it('is true for a recognised ellipsoidal reference (WGS 84 3D, EPSG:4979)', () => {
    // An ellipsoidal height IS a known reference — the height is well-defined
    // even though it is not a sea-level elevation.
    const ctx = buildMeasureConfidenceContext(viewer(true), { verticalEpsg: 4979 });
    expect(ctx.verticalReferenceKnown).toBe(true);
  });

  it('is false for an unrecognised vertical EPSG code', () => {
    const ctx = buildMeasureConfidenceContext(viewer(true), { verticalEpsg: 9999 });
    expect(ctx.verticalReferenceKnown).toBe(false);
  });
});

describe('buildMeasureConfidenceContext — datum / layer wiring', () => {
  it('passes the controller datum-resolved fact through', () => {
    expect(buildMeasureConfidenceContext(viewer(true), null).datumResolved).toBe(true);
    expect(buildMeasureConfidenceContext(viewer(false), null).datumResolved).toBe(false);
  });

  it('reads a single/zero-cloud scene as `single` and a multi-cloud scene as `mixed`', () => {
    expect(buildMeasureConfidenceContext(viewer(true, 1), null).layers).toBe('single');
    expect(buildMeasureConfidenceContext(viewer(true, 0), null).layers).toBe('single');
    expect(buildMeasureConfidenceContext(viewer(true, 2), null).layers).toBe('mixed');
  });
});

describe('buildMeasureConfidenceContext — end-to-end confidence of a height measurement', () => {
  it('a height over an unknown vertical reference reads approximate, and names why', () => {
    const scene = buildMeasureConfidenceContext(viewer(true), { verticalDatum: 'Some unmapped datum' });
    const c = confidenceForKind('height', scene);
    expect(c.level).toBe('approximate');
    if (c.level === 'approximate') expect(c.reason).toContain('vertical reference unknown');
  });

  it('a height over a recognised datum, single layer, resolved, reads verified', () => {
    const scene = buildMeasureConfidenceContext(viewer(true), { verticalEpsg: 5703 });
    const c = confidenceForKind('height', scene);
    expect(c.level).toBe('verified');
  });
});
