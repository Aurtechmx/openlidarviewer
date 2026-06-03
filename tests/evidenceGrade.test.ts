/**
 * evidenceGrade.test.ts — specs for the length-weighted grade
 * summary that feeds the honest "% interpolated" caveat.
 */

import { describe, it, expect } from 'vitest';
import {
  tallySegments,
  tallyContourSet,
  interpolatedCaption,
} from '../src/terrain/contour/evidenceGrade';
import type { ContourSegment, ContourSet } from '../src/terrain/contour/contoursAt';

const seg = (len: number, grade: ContourSegment['grade']): ContourSegment => ({
  x1: 0,
  y1: 0,
  x2: len,
  y2: 0,
  confidence: grade === 'solid' ? 90 : grade === 'dashed' ? 50 : 10,
  grade,
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
