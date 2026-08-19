/**
 * measureBreakdown.test.ts — the values a Distance and an Area already know.
 *
 * Reading a Distance's map run, height change or grade used to mean placing a
 * second measurement of a different kind over the same two points. The geometry
 * for all of it has existed since the Profile kind landed. These tests pin the
 * composition on top of it: which unit factor belongs to which quantity, that a
 * Y-up scan is measured against its own vertical, and that the figures a
 * compound CRS cannot support are flagged rather than quietly presented.
 *
 * The expectations are written against `geometry.ts` rather than re-deriving the
 * formulas, so a change in the underlying math surfaces here as a real
 * disagreement instead of two copies drifting together.
 */

import { describe, it, expect } from 'vitest';
import {
  lineBreakdown,
  areaBreakdown,
  type LineBreakdown,
} from '../src/render/measure/measureBreakdown';
import {
  profileMetrics,
  polygonAreaHorizontal,
  polygonAreaPlanar,
  polygonPerimeter,
} from '../src/render/measure/geometry';
import type { Vec3 } from '../src/render/navMath';

const Z_UP: Vec3 = [0, 0, 1];
const Y_UP: Vec3 = [0, 1, 0];

/** Linear-unit factors, the three the measurement stack actually meets. */
const METRE = 1;
const INTERNATIONAL_FOOT = 0.3048;
const US_SURVEY_FOOT = 1200 / 3937;

/** A 3-4-5 line in the XZ plane: 3 across, 4 up, 5 through space. */
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [3, 0, 4];

describe('lineBreakdown — one pick, every value it fixes', () => {
  it('splits a 3-4-5 line into run, rise and slant', () => {
    const r = lineBreakdown(A, B, Z_UP, METRE);
    expect(r.horizontalM).toBeCloseTo(3, 12);
    expect(r.verticalM).toBeCloseTo(4, 12);
    expect(r.length3dM).toBeCloseTo(5, 12);
    // 4 rise over 3 run.
    expect(r.gradePercent).toBeCloseTo(400 / 3, 10);
    expect(r.gradeAngleDeg).toBeCloseTo((Math.atan2(4, 3) * 180) / Math.PI, 10);
    expect(r.mixedUnits).toBe(false);
  });

  it('keeps the sign of a descent', () => {
    const down = lineBreakdown(B, A, Z_UP, METRE);
    expect(down.verticalM).toBeCloseTo(-4, 12);
    expect(down.gradePercent).toBeCloseTo(-400 / 3, 10);
    expect(down.gradeAngleDeg).toBeLessThan(0);
    // Length and run are magnitudes, so reversing the pick does not flip them.
    expect(down.length3dM).toBeCloseTo(5, 12);
    expect(down.horizontalM).toBeCloseTo(3, 12);
  });

  it('agrees with profileMetrics rather than re-deriving it', () => {
    const pm = profileMetrics(A, B, Z_UP);
    const r = lineBreakdown(A, B, Z_UP, METRE);
    expect(r.horizontalM).toBeCloseTo(pm.lengthHorizontal, 12);
    expect(r.verticalM).toBeCloseTo(pm.verticalDrop, 12);
    expect(r.length3dM).toBeCloseTo(pm.length3d, 12);
    expect(r.gradePercent).toBeCloseTo(pm.gradePercent, 12);
    expect(r.gradeAngleDeg).toBeCloseTo(pm.gradeAngleDeg, 12);
  });

  it('measures a Y-up scan against its own vertical', () => {
    // The same 3-4-5 shape, rebuilt so the rise runs along Y.
    const r = lineBreakdown([0, 0, 0], [3, 4, 0], Y_UP, METRE);
    expect(r.horizontalM).toBeCloseTo(3, 12);
    expect(r.verticalM).toBeCloseTo(4, 12);
    expect(r.length3dM).toBeCloseTo(5, 12);
    // Read against an assumed Z-up the same pick has no rise at all, which is
    // the failure this argument exists to prevent.
    const misread = lineBreakdown([0, 0, 0], [3, 4, 0], Z_UP, METRE);
    expect(misread.verticalM).toBeCloseTo(0, 12);
  });

  it('has no grade for a purely vertical pair, and does not invent one', () => {
    const r = lineBreakdown([0, 0, 0], [0, 0, 7], Z_UP, METRE);
    expect(r.horizontalM).toBeCloseTo(0, 12);
    expect(r.verticalM).toBeCloseTo(7, 12);
    expect(Number.isFinite(r.gradePercent)).toBe(false);
    expect(r.gradeAngleDeg).toBeCloseTo(90, 10);
  });

  describe('unit factors', () => {
    const cases: readonly (readonly [string, number])[] = [
      ['metre', METRE],
      ['international foot', INTERNATIONAL_FOOT],
      ['US survey foot', US_SURVEY_FOOT],
    ];

    for (const [name, f] of cases) {
      it(`converts every length by the ${name} factor exactly once`, () => {
        const r = lineBreakdown(A, B, Z_UP, f);
        expect(r.horizontalM).toBeCloseTo(3 * f, 12);
        expect(r.verticalM).toBeCloseTo(4 * f, 12);
        expect(r.length3dM).toBeCloseTo(5 * f, 12);
        // A grade is a ratio, so no factor touches it.
        expect(r.gradePercent).toBeCloseTo(400 / 3, 10);
      });
    }

    it('separates the international and US survey foot rather than treating them as one', () => {
      const intl = lineBreakdown(A, B, Z_UP, INTERNATIONAL_FOOT);
      const usft = lineBreakdown(A, B, Z_UP, US_SURVEY_FOOT);
      expect(usft.horizontalM).not.toBeCloseTo(intl.horizontalM, 9);
      // Two parts per million: small, and exactly the kind of difference a
      // survey deliverable is not allowed to absorb silently.
      const partsPerMillion = Math.abs(usft.horizontalM / intl.horizontalM - 1) * 1e6;
      expect(partsPerMillion).toBeGreaterThan(1.9);
      expect(partsPerMillion).toBeLessThan(2.1);
    });
  });

  describe('a compound CRS, where height carries its own unit', () => {
    // Horizontal metres with heights in international feet.
    const compound = (): LineBreakdown =>
      lineBreakdown(A, B, Z_UP, METRE, INTERNATIONAL_FOOT);

    it('converts the run and the rise by their own factors', () => {
      const r = compound();
      expect(r.horizontalM).toBeCloseTo(3 * METRE, 12);
      expect(r.verticalM).toBeCloseTo(4 * INTERNATIONAL_FOOT, 12);
    });

    it('flags the figures that combine the two axes', () => {
      expect(compound().mixedUnits).toBe(true);
      expect(lineBreakdown(A, B, Z_UP, METRE, METRE).mixedUnits).toBe(false);
    });

    it('builds the 3D length from the converted components, not from one factor', () => {
      const r = compound();
      // Scaling the render-space slant by the horizontal factor would give 5 m.
      // The honest composition of a 3 m run with a 1.2192 m rise is shorter.
      expect(r.length3dM).toBeCloseTo(Math.hypot(3, 4 * INTERNATIONAL_FOOT), 12);
      expect(r.length3dM).toBeLessThan(5);
    });

    it('is identical to the single-unit path when the two factors agree', () => {
      const single = lineBreakdown(A, B, Z_UP, INTERNATIONAL_FOOT);
      const explicit = lineBreakdown(A, B, Z_UP, INTERNATIONAL_FOOT, INTERNATIONAL_FOOT);
      expect(explicit).toEqual(single);
      expect(single.length3dM).toBeCloseTo(5 * INTERNATIONAL_FOOT, 12);
    });
  });
});

describe('areaBreakdown — what a closed ring knows', () => {
  /** A flat 10×10 square on the ground plane. */
  const flat: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 0],
    [0, 10, 0],
  ];
  /** The same square lifted along one edge, so its plane tilts. */
  const tilted: Vec3[] = [
    [0, 0, 0],
    [10, 0, 0],
    [10, 10, 10],
    [0, 10, 10],
  ];

  it('reports the plain figures for a flat ring', () => {
    const r = areaBreakdown(flat, Z_UP, METRE);
    expect(r.horizontalM2).toBeCloseTo(100, 9);
    expect(r.planarM2).toBeCloseTo(100, 9);
    expect(r.perimeterM).toBeCloseTo(40, 9);
    expect(r.vertexCount).toBe(4);
    expect(r.mixedUnits).toBe(false);
  });

  it('separates the planimetric area from the tilted plane area', () => {
    const r = areaBreakdown(tilted, Z_UP, METRE);
    // The footprint stays 10 × 10 however far the ring tilts.
    expect(r.horizontalM2).toBeCloseTo(100, 9);
    // The plane itself is longer in one direction: 10 across by √200 down-dip.
    expect(r.planarM2).toBeCloseTo(10 * Math.hypot(10, 10), 9);
    expect(r.planarM2).toBeGreaterThan(r.horizontalM2);
  });

  it('agrees with the geometry functions rather than re-deriving them', () => {
    const r = areaBreakdown(tilted, Z_UP, METRE);
    expect(r.horizontalM2).toBeCloseTo(polygonAreaHorizontal(tilted, Z_UP), 9);
    expect(r.planarM2).toBeCloseTo(polygonAreaPlanar(tilted), 9);
    expect(r.perimeterM).toBeCloseTo(polygonPerimeter(tilted), 9);
  });

  it('converts area by the factor SQUARED and perimeter by the factor once', () => {
    const f = INTERNATIONAL_FOOT;
    const r = areaBreakdown(flat, Z_UP, f);
    expect(r.horizontalM2).toBeCloseTo(100 * f * f, 12);
    expect(r.perimeterM).toBeCloseTo(40 * f, 12);
    // Converting an area once is the recurring mistake: it under-reports by
    // exactly the factor, so pin that this is NOT what happened.
    expect(r.horizontalM2).toBeLessThan(100 * f);
  });

  it('measures a Y-up ring against its own vertical', () => {
    const yUpFlat: Vec3[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ];
    // Flat in the XZ plane, which IS the map plane when Y is up.
    expect(areaBreakdown(yUpFlat, Y_UP, METRE).horizontalM2).toBeCloseTo(100, 9);
    // The same ring read against Z-up is a vertical wall with no footprint.
    expect(areaBreakdown(yUpFlat, Z_UP, METRE).horizontalM2).toBeCloseTo(0, 9);
  });

  it('returns zeros rather than a fabricated area for an unclosed ring', () => {
    for (const pts of [[], [flat[0]], [flat[0], flat[1]]]) {
      const r = areaBreakdown(pts, Z_UP, METRE);
      expect(r.horizontalM2).toBe(0);
      expect(r.planarM2).toBe(0);
      expect(r.perimeterM).toBe(0);
      expect(r.vertexCount).toBe(pts.length);
    }
  });

  it('flags a compound CRS on the ring too', () => {
    expect(areaBreakdown(flat, Z_UP, METRE, INTERNATIONAL_FOOT).mixedUnits).toBe(true);
    expect(areaBreakdown(flat, Z_UP, METRE, METRE).mixedUnits).toBe(false);
  });

  it("does not mutate the caller's ring", () => {
    const ring: Vec3[] = [...flat];
    const before = JSON.stringify(ring);
    areaBreakdown(ring, Z_UP, METRE);
    expect(JSON.stringify(ring)).toBe(before);
  });
});
