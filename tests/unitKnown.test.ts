/**
 * unitKnown.test.ts
 *
 * The single fail-closed unit-integrity predicate, `isLinearUnitKnown`, that the
 * measure tool, lasso density, streaming / scan reports, full-cloud grade and
 * epoch-compare seams all share (PRs #217–227). Metres are claimable ONLY when
 * the CRS declares a real linear unit; everything else — no CRS, the inert
 * `linearUnit: 'unknown'` placeholder, or no `linearUnit` field at all — fails
 * closed so raw source units are never stamped as metres.
 */
import { isLinearUnitKnown } from '../src/geo/CoordinateTypes';

describe('isLinearUnitKnown', () => {
  it('is true for the known linear units', () => {
    expect(isLinearUnitKnown({ linearUnit: 'metre' })).toBe(true);
    expect(isLinearUnitKnown({ linearUnit: 'foot' })).toBe(true);
    expect(isLinearUnitKnown({ linearUnit: 'us-survey-foot' })).toBe(true);
  });

  it("is false for the 'unknown' placeholder unit", () => {
    expect(isLinearUnitKnown({ linearUnit: 'unknown' })).toBe(false);
  });

  it('is false for a null or undefined CRS', () => {
    expect(isLinearUnitKnown(null)).toBe(false);
    expect(isLinearUnitKnown(undefined)).toBe(false);
  });

  it('is false when the CRS carries no linearUnit field', () => {
    expect(isLinearUnitKnown({})).toBe(false);
  });

  it('accepts richer CRS shapes structurally, no cast (ResolvedCrs / CrsInfo)', () => {
    // Passed as typed variables, mirroring real callers: extra fields are fine
    // structurally, and the placeholder-factor 1 does not make an unknown unit
    // "known".
    const footCrs = { linearUnit: 'foot', linearUnitToMetres: 0.3048 };
    const unknownWithFactor = { linearUnit: 'unknown', linearUnitToMetres: 1 };
    expect(isLinearUnitKnown(footCrs)).toBe(true);
    expect(isLinearUnitKnown(unknownWithFactor)).toBe(false);
  });

  it('the two-epoch compare gate fails closed when EITHER epoch lacks a known unit', () => {
    // Regression for the epoch-compare wiring (compareLoadedLayers in main.ts):
    // `horizontalUnitKnown` is `isLinearUnitKnown(a) && isLinearUnitKnown(b)`.
    // The earlier inline form `a.linearUnit !== 'unknown' && b...` read a MISSING
    // CRS (null metadata, the default for a plain PLY/PCD/XYZ) as unit-known —
    // fail-OPEN — so cut/fill volume and Δz/LoD printed in metres from a
    // placeholder factor of 1 while the real unit was unknown.
    const metre = { linearUnit: 'metre' };
    const bothKnown = (a: unknown, b: unknown) =>
      isLinearUnitKnown(a as { linearUnit?: string } | null) &&
      isLinearUnitKnown(b as { linearUnit?: string } | null);
    expect(bothKnown(metre, metre)).toBe(true);
    expect(bothKnown(metre, null)).toBe(false); // after-epoch has no CRS
    expect(bothKnown(null, metre)).toBe(false); // before-epoch has no CRS
    expect(bothKnown(metre, { linearUnit: 'unknown' })).toBe(false);
    expect(bothKnown(null, null)).toBe(false);
  });
});
