/**
 * frameCompatibility.test.ts
 *
 * Two scans, one question asked twice: may we compare them horizontally, and
 * may we compare their heights? The whole point of `compareSpatialFrames` is
 * that those are SEPARATE permissions. A pair of epochs on the same metre grid
 * with two different vertical datums is planimetrically comparable and
 * vertically not, and the old code path that returned a single "compatible"
 * boolean could not say so.
 *
 * These tests pin that separation, and pin that unknown stays unknown: an
 * absent unit or datum never resolves to a default that would let a claim
 * through.
 */

import { describe, it, expect } from 'vitest';
import type { CrsInfo } from '../src/io/crs';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import {
  compareSpatialFrames,
  declaredFrameLabel,
  epochFrameOptions,
  epochVerticalScalesComparable,
} from '../src/geo/frameCompatibility';

const US_SURVEY_FOOT = 1200 / 3937;

function crs(over: Partial<CrsInfo> = {}): CrsInfo {
  return {
    source: 'wkt',
    name: 'WGS 84 / UTM zone 12N',
    epsg: 32612,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    isGeographic: false,
    ...over,
  };
}

const metreUtm = () => spatialContextFrom(crs());
const footStatePlane = () =>
  spatialContextFrom(
    crs({
      name: 'NAD83 / Utah Central (ftUS)',
      epsg: 3567,
      linearUnit: 'us-survey-foot',
      linearUnitToMetres: US_SURVEY_FOOT,
    }),
  );
const geographic = () =>
  spatialContextFrom(
    crs({ name: 'WGS 84', epsg: 4326, isGeographic: true, linearUnit: 'unknown' }),
  );
const unknownUnit = () =>
  spatialContextFrom(crs({ linearUnit: 'unknown', linearUnitToMetres: 1 }));

// ─────────────────────────────────────────────────────────────────────────────
// Planimetric permission
// ─────────────────────────────────────────────────────────────────────────────

describe('compareSpatialFrames — planimetric permission', () => {
  it('permits two identical projected metre frames', () => {
    const v = compareSpatialFrames(metreUtm(), metreUtm());
    expect(v.planimetricComparable).toBe(true);
    expect(v.horizontalFrameConflict).toBe(false);
    expect(v.horizontalUnitKnown).toBe(true);
    expect(v.isGeographic).toBe(false);
  });

  it('refuses when either side is geographic — degrees are not a linear metric', () => {
    expect(compareSpatialFrames(geographic(), metreUtm()).planimetricComparable).toBe(false);
    expect(compareSpatialFrames(metreUtm(), geographic()).planimetricComparable).toBe(false);
    expect(compareSpatialFrames(metreUtm(), geographic()).isGeographic).toBe(true);
  });

  it('refuses when either linear unit is unknown, and never substitutes a default', () => {
    const v = compareSpatialFrames(unknownUnit(), metreUtm());
    expect(v.horizontalUnitKnown).toBe(false);
    expect(v.planimetricComparable).toBe(false);
    // The placeholder factor 1 must not be read as a measurement.
    expect(v.horizontalUnitToMetres).toBeUndefined();
  });

  it('reports the shared horizontal factor only when BOTH sides declare one', () => {
    expect(compareSpatialFrames(metreUtm(), metreUtm()).horizontalUnitToMetres).toBe(1);
    expect(compareSpatialFrames(footStatePlane(), footStatePlane()).horizontalUnitToMetres)
      .toBeCloseTo(US_SURVEY_FOOT, 12);
  });

  it('flags a proven horizontal frame conflict on differing EPSG', () => {
    const utm13 = spatialContextFrom(crs({ epsg: 32613, name: 'WGS 84 / UTM zone 13N' }));
    const v = compareSpatialFrames(metreUtm(), utm13);
    expect(v.horizontalFrameConflict).toBe(true);
    expect(v.planimetricComparable).toBe(false);
    expect(v.notes.some((n) => n.includes('Horizontal CRS differs'))).toBe(true);
  });

  it('treats a missing horizontal identity as unverified, not as a conflict', () => {
    const v = compareSpatialFrames(spatialContextFrom(null), metreUtm());
    expect(v.horizontalFrameConflict).toBe(false);
    expect(v.horizontalFrameUnverified).toBe(true);
    // Unverified still blocks: an unknown CRS carries an unknown unit.
    expect(v.planimetricComparable).toBe(false);
  });

  it('two known but DIFFERENT linear units are a conflict, not a conversion', () => {
    // Both units are known, so the naive "unit known on both sides" gate lets
    // this through. A metre grid and a US-survey-foot grid are still not
    // comparable cell-for-cell, and one factor cannot stand for both.
    const v = compareSpatialFrames(metreUtm(), footStatePlane());
    expect(v.horizontalUnitKnown).toBe(true);
    expect(v.horizontalUnitToMetres).toBeUndefined();
    expect(v.horizontalFrameConflict).toBe(true);
    expect(v.planimetricComparable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Vertical permission — decided independently of the horizontal verdict
// ─────────────────────────────────────────────────────────────────────────────

describe('compareSpatialFrames — vertical permission is separate', () => {
  const navd88 = (over: Partial<CrsInfo> = {}) =>
    spatialContextFrom(crs({ verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalUnitToMetres: 1, ...over }));

  // Two orthometric datums are not one datum. NAVD88 and EGM2008 both classify
  // as `orthometric`, so a comparison keyed on the reference class read them as
  // the same surface. They differ by roughly a metre across North America, and
  // a change study spanning the two would have reported that offset as ground
  // movement.
  it('separates two datums that share a reference surface', () => {
    const navd = navd88();
    const egm = spatialContextFrom(
      crs({ verticalEpsg: 3855, verticalDatum: 'EGM2008', verticalUnitToMetres: 1 }),
    );
    expect(navd.verticalReference).toBe(egm.verticalReference); // both orthometric
    const v = compareSpatialFrames(navd, egm);
    expect(v.verticalFrameConflict).toBe(true);
    expect(v.verticalComparable).toBe(false);
    expect(v.notes.some((n) => n.includes('common surface'))).toBe(true);
  });

  it('still matches one datum declared by code against the same datum by name', () => {
    // The identity is the resolved code, so a frame naming NAVD88 and a frame
    // carrying 5703 are the same reference rather than two spellings.
    const byCode = spatialContextFrom(crs({ verticalEpsg: 5703, verticalUnitToMetres: 1 }));
    const byName = spatialContextFrom(crs({ verticalDatum: 'NAVD88', verticalUnitToMetres: 1 }));
    const v = compareSpatialFrames(byCode, byName);
    expect(v.verticalFrameConflict).toBe(false);
    expect(v.verticalComparable).toBe(true);
  });

  it('horizontal agreement does NOT imply vertical agreement', () => {
    const a = navd88();
    const b = spatialContextFrom(
      crs({ verticalEpsg: 4979, verticalDatum: 'EPSG:4979', verticalUnitToMetres: 1 }),
    );
    const v = compareSpatialFrames(a, b);
    expect(v.planimetricComparable).toBe(true); // same metre grid
    expect(v.verticalComparable).toBe(false); // orthometric vs ellipsoidal
    expect(v.verticalFrameConflict).toBe(true);
    expect(v.notes.some((n) => n.includes('Vertical'))).toBe(true);
  });

  it('vertical agreement does NOT imply horizontal agreement', () => {
    const a = navd88();
    const b = navd88({ linearUnit: 'unknown', linearUnitToMetres: 1 });
    const v = compareSpatialFrames(a, b);
    expect(v.verticalComparable).toBe(true);
    expect(v.planimetricComparable).toBe(false);
  });

  it('an undeclared vertical datum is unverified on both sides, never defaulted', () => {
    const v = compareSpatialFrames(metreUtm(), metreUtm());
    expect(v.verticalFrameUnverified).toBe(true);
    expect(v.verticalFrameConflict).toBe(false);
    expect(v.verticalComparable).toBe(false);
  });

  it('refuses a vertical claim when either vertical scale is unknown', () => {
    const withScale = navd88();
    const noScale = spatialContextFrom(
      crs({ verticalEpsg: 5703, verticalDatum: 'NAVD88' }), // no verticalUnitToMetres
    );
    const v = compareSpatialFrames(withScale, noScale);
    expect(v.verticalScaleKnown).toBe(false);
    expect(v.verticalComparable).toBe(false);
  });

  it('reports the shared vertical factor only when both sides declare the same one', () => {
    const m = navd88();
    const ft = navd88({ verticalUnitToMetres: US_SURVEY_FOOT });
    expect(compareSpatialFrames(m, m).verticalUnitToMetres).toBe(1);
    expect(compareSpatialFrames(m, ft).verticalUnitToMetres).toBeUndefined();
    expect(compareSpatialFrames(m, ft).verticalComparable).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The epoch-comparison adapter
// ─────────────────────────────────────────────────────────────────────────────

describe('declaredFrameLabel', () => {
  it('returns the label when the source declared a CRS', () => {
    expect(declaredFrameLabel(metreUtm())).toBe('WGS 84 / UTM zone 12N');
  });

  it('returns null for an undeclared CRS, so two unknowns never read as a match', () => {
    const unknown = spatialContextFrom(null);
    expect(declaredFrameLabel(unknown)).toBeNull();
    // The bug this exists to prevent: the display placeholder compares equal.
    expect(unknown.crsName).toBe('CRS unknown');
    expect(declaredFrameLabel(unknown) === declaredFrameLabel(spatialContextFrom(null))).toBe(true);
    expect(declaredFrameLabel(unknown)).toBeNull(); // …and null is falsy, so the guard holds
  });
});

describe('epochFrameOptions', () => {
  it('hands the alignment and the difference the SAME three facts', () => {
    const o = epochFrameOptions(metreUtm(), metreUtm());
    expect(o).toEqual({ isGeographic: false, horizontalUnitKnown: true, horizontalUnitToMetres: 1 });
  });

  it('fails closed on an unknown unit — no fabricated metre factor', () => {
    const o = epochFrameOptions(unknownUnit(), metreUtm());
    expect(o.horizontalUnitKnown).toBe(false);
    expect(o.horizontalUnitToMetres).toBeUndefined();
  });

  it('marks a geographic pair so degree areas are never volumed', () => {
    expect(epochFrameOptions(geographic(), metreUtm()).isGeographic).toBe(true);
  });

  it('reports the BEFORE epoch factor, the reference the change pipeline uses', () => {
    const o = epochFrameOptions(footStatePlane(), metreUtm());
    expect(o.horizontalUnitToMetres).toBeCloseTo(US_SURVEY_FOOT, 12);
    expect(o.horizontalUnitKnown).toBe(true); // both units ARE known, they just differ
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Epoch vertical comparability (C6): refuse metre-vs-foot Z differencing
// ─────────────────────────────────────────────────────────────────────────────

describe('epochVerticalScalesComparable', () => {
  const withVertical = (verticalUnitToMetres: number) =>
    spatialContextFrom(
      crs({ verticalEpsg: 5703, verticalDatum: 'NAVD88', verticalUnitToMetres }),
    );

  it('permits two epochs with the SAME known vertical scale (metres)', () => {
    expect(epochVerticalScalesComparable(withVertical(1), withVertical(1))).toBe(true);
  });

  it('REFUSES a metre epoch differenced against a foot epoch', () => {
    expect(epochVerticalScalesComparable(withVertical(1), withVertical(0.3048))).toBe(false);
    // order-independent
    expect(epochVerticalScalesComparable(withVertical(0.3048), withVertical(1))).toBe(false);
  });

  it('permits when either vertical scale is unknown (no evidence of a mismatch)', () => {
    // A plain UTM context carries no known vertical scale.
    expect(epochVerticalScalesComparable(metreUtm(), withVertical(1))).toBe(true);
    expect(epochVerticalScalesComparable(withVertical(0.3048), metreUtm())).toBe(true);
    expect(epochVerticalScalesComparable(metreUtm(), metreUtm())).toBe(true);
  });
});
