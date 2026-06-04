/**
 * contourFeatureModel.test.ts — shared model: grade-run split,
 * CRS handling, interpolated fraction.
 */

import { describe, it, expect } from 'vitest';
import { buildFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import { gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import type { ContourPolyline, ContourVertex, StitchedLevel } from '../src/terrain/contour/stitchContours';
import type { StyledLevel } from '../src/terrain/contour/contourStyle';

const v = (x: number, y: number, c: number): ContourVertex => ({
  x,
  y,
  confidence: c,
  grade: gradeForConfidence(c),
});

const styled = (value: number, isIndex: boolean): StyledLevel => ({
  value,
  isIndex,
  weight: isIndex ? 2 : 1,
  labelEligible: isIndex,
});

describe('buildFeatureModel', () => {
  it('splits a mixed-grade polyline into single-grade runs', () => {
    const poly: ContourPolyline = {
      value: 10,
      vertices: [v(0, 0, 90), v(1, 0, 90), v(2, 0, 10), v(3, 0, 10), v(4, 0, 90), v(5, 0, 90)],
      closed: false,
    };
    const stitched: StitchedLevel[] = [{ value: 10, polylines: [poly] }];
    const model = buildFeatureModel(stitched, [styled(10, true)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(model.features.length).toBe(3);
    expect(model.features.map((f) => f.grade)).toEqual(['solid', 'gap', 'solid']);
    expect(model.features.every((f) => f.isIndex)).toBe(true);
  });

  it('computes a length-weighted interpolated fraction', () => {
    const poly: ContourPolyline = {
      value: 10,
      vertices: [v(0, 0, 90), v(1, 0, 90), v(2, 0, 10), v(3, 0, 10), v(4, 0, 90), v(5, 0, 90)],
      closed: false,
    };
    const model = buildFeatureModel([{ value: 10, polylines: [poly] }], [styled(10, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    // total length 5, gap length 3 → 0.6
    expect(model.interpolatedFraction).toBeCloseTo(0.6, 6);
  });

  it('warns when CRS is unknown', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: null,
      intervalM: 1,
    });
    expect(model.crs).toBeNull();
    expect(model.warnings.join(' ')).toMatch(/CRS unknown/i);
  });

  it('keeps a single-grade closed ring as one closed feature', () => {
    const poly: ContourPolyline = {
      value: 5,
      vertices: [v(0, 0, 90), v(2, 0, 90), v(2, 2, 90), v(0, 2, 90)],
      closed: true,
    };
    const model = buildFeatureModel([{ value: 5, polylines: [poly] }], [styled(5, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(model.features.length).toBe(1);
    expect(model.features[0].closed).toBe(true);
  });

  it('computes a bounding box over all features', () => {
    const poly: ContourPolyline = {
      value: 1,
      vertices: [v(-1, 2, 90), v(3, 5, 90)],
      closed: false,
    };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(model.bbox).toEqual({ minX: -1, minY: 2, maxX: 3, maxY: 5 });
  });

  it('warns when CRS is unknown', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: null,
      verticalDatum: 'EPSG:5703',
      intervalM: 1,
    });
    expect(model.crs).toBeNull();
    expect(model.warnings.join(' ')).toMatch(/CRS unknown/i);
  });

  it('warns when the vertical datum is unknown', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const model = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      verticalDatum: null,
      intervalM: 1,
    });
    expect(model.warnings.join(' ')).toMatch(/datum unknown/i);
  });

  it('defaults coverageMode to full and carries an explicit one through', () => {
    const poly: ContourPolyline = { value: 1, vertices: [v(0, 0, 90), v(1, 0, 90)], closed: false };
    const full = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
    });
    expect(full.coverageMode).toBe('full');
    const resident = buildFeatureModel([{ value: 1, polylines: [poly] }], [styled(1, false)], {
      crs: 'EPSG:32610',
      intervalM: 1,
      coverageMode: 'resident-only',
    });
    expect(resident.coverageMode).toBe('resident-only');
  });
});
