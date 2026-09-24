/**
 * terrainAccessDirectionalGrade.test.ts: a route feels a cell's slope
 * differently by heading (TA-2), a heading is a physical vector rather than a
 * raster offset on an anisotropic grid (TA-10), and total slope is never
 * silently substituted for cross slope (the §31 adversarial case).
 */
import { describe, expect, it } from 'vitest';

import {
  directionalSlope, gradientAt, gradientField, headingUnit,
} from '../src/simulation/terrainAccess/directionalGrade';
import { hornSlopeAspect } from '../src/terrain/ground/terrainDerivatives';

describe('gradientAt', () => {
  it('is zero on flat ground regardless of the aspect sentinel', () => {
    const g = gradientAt(0, 0);
    expect(g.east).toBeCloseTo(0, 12);
    expect(g.north).toBeCloseTo(0, 12);
  });

  it('points opposite the downslope direction, with the slope tangent as magnitude', () => {
    // Downslope due east (alpha = 0): the surface falls toward +east, so the
    // gradient (which points toward INCREASING elevation) points west.
    const g = gradientAt(0.36, 0);
    expect(g.east).toBeCloseTo(-0.36, 6);
    expect(g.north).toBeCloseTo(0, 6);
    expect(Math.hypot(g.east, g.north)).toBeCloseTo(0.36, 6);
  });
});

describe('headingUnit', () => {
  it('is exact for the four cardinal offsets regardless of cell size', () => {
    expect(headingUnit(1, 0, 3, 7)).toEqual({ east: 1, north: 0 });
    expect(headingUnit(0, 1, 3, 7)).toEqual({ east: 0, north: 1 });
  });

  it('TA-10: a diagonal offset is NOT 45° on an anisotropic grid', () => {
    // 10 m east per cell, 1 m south per cell: a (1,1) step is a much shallower
    // heading than 45° once expressed in real metres.
    const h = headingUnit(1, 1, 10, 1);
    const angleDeg = (Math.atan2(h.north, h.east) * 180) / Math.PI;
    expect(angleDeg).toBeLessThan(20); // close to due-east, not 45°
    expect(Math.hypot(h.east, h.north)).toBeCloseTo(1, 6); // still a unit vector
  });
});

describe('directionalSlope', () => {
  const m = 0.36; // an arbitrary nonzero grade
  const grad = gradientAt(m, 0); // downslope due east

  it('TA-2: directly upslope/downslope carries the full grade and zero cross slope', () => {
    const east = directionalSlope(grad, headingUnit(1, 0, 1, 1));
    expect(east.longitudinalGrade).toBeCloseTo(m, 6);
    expect(east.crossSlope).toBeCloseTo(0, 6);
  });

  it('TA-2: along the contour carries zero longitudinal grade and the full cross slope', () => {
    const north = directionalSlope(grad, headingUnit(0, 1, 1, 1));
    expect(north.longitudinalGrade).toBeCloseTo(0, 6);
    expect(north.crossSlope).toBeCloseTo(m, 6);
  });

  it('TA-2: a diagonal heading splits the grade between both terms', () => {
    const diag = directionalSlope(grad, headingUnit(1, 1, 1, 1));
    expect(diag.longitudinalGrade).toBeCloseTo(m * Math.SQRT1_2, 6);
    expect(diag.crossSlope).toBeCloseTo(m * Math.SQRT1_2, 6);
  });

  it('longitudinal² + cross² reproduces the total slope tangent for ANY heading', () => {
    const headings = [
      headingUnit(1, 0, 1, 1), headingUnit(1, 1, 1, 1), headingUnit(0, 1, 1, 1),
      headingUnit(-1, 1, 1, 1), headingUnit(2, 3, 4, 5),
    ];
    for (const h of headings) {
      const { longitudinalGrade, crossSlope } = directionalSlope(grad, h);
      const total = Math.hypot(longitudinalGrade, crossSlope);
      expect(total).toBeCloseTo(m, 5);
    }
  });

  it('adversarial: total slope is not a stand-in for cross slope — they agree only for the one heading perpendicular to downslope', () => {
    const totalSlope = Math.hypot(grad.east, grad.north);
    const east = directionalSlope(grad, headingUnit(1, 0, 1, 1));
    const north = directionalSlope(grad, headingUnit(0, 1, 1, 1));
    // Moving downslope: cross slope is ~0, far below total slope.
    expect(east.crossSlope).toBeLessThan(totalSlope * 0.01);
    // Moving along the contour: cross slope equals total slope exactly, but
    // that is the ONE heading where they coincide, not a general identity.
    expect(north.crossSlope).toBeCloseTo(totalSlope, 6);
  });
});

describe('gradientField, against a real Horn slope/aspect grid', () => {
  it('reproduces the analytical gradient of a tilted plane rising to the west', () => {
    // z = -x (elevation falls 1 m per metre east): downslope is due east.
    const cols = 5;
    const rows = 5;
    const z = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = -c;
    const derivatives = hornSlopeAspect(z, cols, rows, 1, 1);
    const field = gradientField(derivatives);
    const centre = 2 * cols + 2;
    expect(field.east[centre]).toBeCloseTo(-1, 3); // gradient points west (uphill)
    expect(field.north[centre]).toBeCloseTo(0, 3);
  });
});
