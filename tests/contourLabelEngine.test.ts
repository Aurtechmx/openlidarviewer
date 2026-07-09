/**
 * contourLabelEngine.test.ts
 *
 * Print-aware label placement (spec §17): priority order, the audit, upright
 * text, and the honesty rule that an unsupported span is never labelled.
 */

import { describe, it, expect } from 'vitest';
import {
  placeContourLabels,
  type LabelEngineParams,
} from '../src/terrain/contourStudio/contourLabelEngine';
import type { ContourFeature } from '../src/terrain/contour/contourFeatureModel';

function feature(coords: Array<[number, number]>, over: Partial<ContourFeature> = {}): ContourFeature {
  return {
    value: 10, isIndex: false, grade: 'solid', meanConfidence: 90, closed: false, coordinates: coords, ...over,
  } as ContourFeature;
}

const params: LabelEngineParams = {
  page: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  minStraightLen: 5,
  maxCurvature: 0.4,
  edgeMargin: 2,
  labelHeight: 2,
  charWidth: 1,
  minFeatureLenForScale: 4,
};

const straightLong = (y: number, over: Partial<ContourFeature> = {}) =>
  feature([[10, y], [30, y], [50, y]], over); // length 40, dead straight, central

describe('placeContourLabels', () => {
  it('places a label on a long straight measured contour, upright and on-line', () => {
    const { labels, audit } = placeContourLabels([straightLong(50)], params);
    expect(labels).toHaveLength(1);
    expect(audit.placed).toBe(1);
    expect(labels[0].support).toBe('measured');
    expect(Math.abs(labels[0].angle)).toBeLessThanOrEqual(Math.PI / 2); // upright
    // Placed on the line (y == 50) near its centre.
    expect(labels[0].y).toBeCloseTo(50, 6);
  });

  it('never labels an unsupported (gap) span; records a support suppression', () => {
    const { labels, audit } = placeContourLabels([straightLong(50, { grade: 'gap' })], params);
    expect(labels).toHaveLength(0);
    expect(audit.suppressedBySupport).toBe(1);
  });

  it('labels an interpolated span but marks it interpolated', () => {
    const { labels } = placeContourLabels([straightLong(50, { grade: 'dashed' })], params);
    expect(labels).toHaveLength(1);
    expect(labels[0].support).toBe('interpolated');
  });

  it('suppresses a feature too short for the scale', () => {
    const tiny = feature([[10, 10], [11, 10]]); // length 1 < minFeatureLenForScale
    const { labels, audit } = placeContourLabels([tiny], params);
    expect(labels).toHaveLength(0);
    expect(audit.suppressedByScale).toBe(1);
  });

  it('suppresses a jagged feature with no straight run long enough to host a label', () => {
    // Sharp turns AND short segments (~2.2 units each < minStraightLen 5), so no
    // low-curvature run clears the minimum straight length.
    const zig = feature([[10, 10], [11, 12], [12, 10], [13, 12], [14, 10], [15, 12], [16, 10]]);
    const { labels, audit } = placeContourLabels([zig], params);
    expect(labels).toHaveLength(0);
    expect(audit.suppressedByCurvature).toBe(1);
  });

  it('suppresses a second label that would collide with the first', () => {
    // Two parallel lines one unit apart — label boxes (height 2) overlap.
    const { labels, audit } = placeContourLabels([straightLong(50), straightLong(50.5)], params);
    expect(labels).toHaveLength(1);
    expect(audit.suppressedByCollision).toBe(1);
  });

  it('prioritises index contours first', () => {
    const intermediate = straightLong(30, { value: 3 });
    const index = straightLong(70, { value: 5, isIndex: true });
    // Tight cap of 1 → the index contour must win.
    const { labels } = placeContourLabels([intermediate, index], { ...params, maxLabels: 1 });
    expect(labels).toHaveLength(1);
    expect(labels[0].isIndex).toBe(true);
    expect(labels[0].value).toBe(5);
  });

  it('honours indexOnly by not labelling intermediate contours', () => {
    const { labels } = placeContourLabels([straightLong(50, { isIndex: false })], { ...params, indexOnly: true });
    expect(labels).toHaveLength(0);
  });

  it('uses the injected locale formatter for the label text', () => {
    const { labels } = placeContourLabels([straightLong(50, { value: 1234.5 })], {
      ...params,
      formatValue: (v) => `${v.toFixed(1)} m`,
    });
    expect(labels[0].text).toBe('1234.5 m');
  });
});
