/**
 * contourOverlayGeometry.test.ts — pure-data overlay buffer builder.
 */

import { describe, it, expect } from 'vitest';
import { buildContourOverlayBuffers } from '../src/terrain/contour/contourOverlayGeometry';
import type { ContourFeature, ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';

function feat(
  grade: ContourFeature['grade'],
  coordinates: Array<[number, number]>,
  value = 10,
  isIndex = false,
): ContourFeature {
  return { value, isIndex, grade, meanConfidence: 80, closed: false, coordinates };
}

function model(features: ContourFeature[]): ContourFeatureModel {
  return {
    features,
    crs: 'EPSG:32610',
    verticalDatum: null,
    intervalM: 1,
    bbox: null,
    interpolatedFraction: 0,
    warnings: [],
  };
}

describe('buildContourOverlayBuffers', () => {
  it('emits one segment per consecutive coordinate pair with elevation as Z', () => {
    const b = buildContourOverlayBuffers(model([feat('solid', [[0, 0], [1, 0], [2, 0]], 10, true)]));
    expect(b.segmentCount).toBe(2);
    expect(b.positions.length).toBe(12); // 2 segs * 2 verts * 3
    // First vertex (0,0) at elevation 10 → z slot.
    expect(Array.from(b.positions.slice(0, 3))).toEqual([0, 0, 10]);
    expect(Array.from(b.grades)).toEqual([0, 0]); // solid
    expect(Array.from(b.isIndex)).toEqual([1, 1]);
  });

  it('excludes gap segments by default and includes them when asked', () => {
    const m = model([feat('solid', [[0, 0], [1, 0]]), feat('gap', [[0, 1], [1, 1]])]);
    expect(buildContourOverlayBuffers(m).segmentCount).toBe(1);
    expect(buildContourOverlayBuffers(m, { includeGap: true }).segmentCount).toBe(2);
  });

  it('maps elevation onto Y for a Y-up scene and applies zScale', () => {
    const b = buildContourOverlayBuffers(model([feat('solid', [[3, 4], [5, 6]], 10)]), {
      verticalAxis: 'y',
      zScale: 2,
    });
    // (x, elevation*zScale, y) = (3, 20, 4)
    expect(Array.from(b.positions.slice(0, 3))).toEqual([3, 20, 4]);
  });

  it('returns empty buffers for an empty model', () => {
    const b = buildContourOverlayBuffers(model([]));
    expect(b.segmentCount).toBe(0);
    expect(b.positions.length).toBe(0);
  });
});
