/**
 * evidenceGrade.test.ts — specs for the length-weighted grade
 * summary that feeds the honest "% interpolated" caveat.
 */

import { describe, it, expect } from 'vitest';
import {
  tallySegments,
  tallyContourSet,
  interpolatedCaption,
  contourShareCaption,
  contourShareLine,
  contourShareParts,
} from '../src/terrain/contour/evidenceGrade';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import type { ContourSegment, ContourSet } from '../src/terrain/contour/contoursAt';

const seg = (len: number, grade: ContourSegment['grade']): ContourSegment => ({
  x1: 0,
  y1: 0,
  x2: len,
  y2: 0,
  confidence: grade === 'solid' ? 90 : grade === 'dashed' ? 50 : 10,
  grade,
  provBits: 1,
});

describe('tallySegments', () => {
  it('computes length-weighted grade shares', () => {
    const t = tallySegments([seg(1, 'solid'), seg(1, 'solid'), seg(2, 'dashed')]);
    expect(t.solid.count).toBe(2);
    expect(t.solid.length).toBeCloseTo(2, 6);
    expect(t.dashed.length).toBeCloseTo(2, 6);
    expect(t.totalLength).toBeCloseTo(4, 6);
    expect(t.interpolatedFraction).toBeCloseTo(0.5, 6);
  });

  it('reports NaN interpolated fraction for an empty set', () => {
    const t = tallySegments([]);
    expect(Number.isNaN(t.interpolatedFraction)).toBe(true);
    expect(t.totalLength).toBe(0);
  });

  it('counts gap length as interpolated', () => {
    const t = tallySegments([seg(3, 'solid'), seg(1, 'gap')]);
    expect(t.interpolatedFraction).toBeCloseTo(0.25, 6);
  });
});

describe('tallyContourSet', () => {
  it('flattens all levels', () => {
    const set: ContourSet = {
      levels: [
        { value: 1, segments: [seg(2, 'solid')] },
        { value: 2, segments: [seg(2, 'gap')] },
      ],
      intervalM: 1,
      requestedIntervalM: 1,
      crs: 'EPSG:32610',
      verticalDatum: null,
      minZ: 0,
      maxZ: 2,
      warnings: [],
    };
    const t = tallyContourSet(set);
    expect(t.totalLength).toBeCloseTo(4, 6);
    expect(t.interpolatedFraction).toBeCloseTo(0.5, 6);
  });
});

describe('interpolatedCaption', () => {
  it('phrases the share for a deliverable', () => {
    expect(interpolatedCaption(tallySegments([seg(3, 'solid'), seg(1, 'gap')]))).toMatch(/25%/);
    expect(interpolatedCaption(tallySegments([seg(1, 'solid')]))).toMatch(/measured terrain/i);
    expect(interpolatedCaption(tallySegments([]))).toMatch(/no contours/i);
  });
});

describe('contour share line', () => {
  const model = (interpolated: number, sparse: number, gap: number): ContourFeatureModel => ({
    features: [], interpolatedFraction: interpolated + sparse + gap,
    interpolatedLengthFraction: interpolated, sparseLengthFraction: sparse, gapLengthFraction: gap,
  }) as unknown as ContourFeatureModel;

  it('names interpolated and sparse ground apart, by contour length', () => {
    expect(contourShareLine({ interpolated: 0.04, sparse: 0.45, gap: 0 }))
      .toBe('4% interpolated \u00b7 45% sparse ground (by contour length)');
    expect(contourShareParts({ interpolated: 0.04, sparse: 0.45, gap: 0.004 }))
      .toEqual(['4% interpolated', '45% sparse ground', '1% gap']);
  });

  it('always states both shares, even when one is zero', () => {
    expect(contourShareLine({ interpolated: 0, sparse: 0.3, gap: 0 })).toBe('0% interpolated \u00b7 30% sparse ground (by contour length)');
  });

  it('the panel caption is the same line, or the all-confident sentence when nothing is below solid', () => {
    expect(contourShareCaption(model(0.04, 0.45, 0.01))).toBe(contourShareLine({ interpolated: 0.04, sparse: 0.45, gap: 0.01 }));
    expect(contourShareCaption(model(0, 0, 0))).toBe('All contour length is from confident, measured terrain.');
    expect(contourShareCaption(model(Number.NaN, Number.NaN, Number.NaN))).toBe('No contours drawn.');
  });
});
