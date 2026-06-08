/**
 * coverageHeatmap.test.ts — the coverage-heatmap rasteriser + ramp.
 *
 * Asserts that a grid of KNOWN confidences maps to the right green/yellow/red
 * pixels at the right cells, that empty cells are transparent, and that the
 * thresholds agree with `gradeForConfidence` (the dashed-contour evidence).
 */

import { describe, it, expect } from 'vitest';
import {
  coverageHeatmapImage,
  coverageColorForConfidence,
  coverageColorForGrade,
  COVERAGE_STRONG,
  COVERAGE_MODERATE,
  COVERAGE_WEAK,
  type CoverageGrid,
} from '../src/terrain/surface/coverageHeatmap';
import { EVIDENCE_THRESHOLDS, gradeForConfidence } from '../src/terrain/ground/cellConfidence';

/** Read the RGBA at (col,row) of an image. */
function px(
  img: { data: Uint8ClampedArray; width: number },
  col: number,
  row: number,
): [number, number, number, number] {
  const o = (row * img.width + col) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

describe('coverageColorForConfidence — thresholds tie to gradeForConfidence', () => {
  it('strong (>= solid) is green', () => {
    expect(coverageColorForConfidence(EVIDENCE_THRESHOLDS.solid)).toEqual(COVERAGE_STRONG);
    expect(coverageColorForConfidence(100)).toEqual(COVERAGE_STRONG);
  });

  it('moderate (dashed..solid) is yellow', () => {
    expect(coverageColorForConfidence(EVIDENCE_THRESHOLDS.dashed)).toEqual(COVERAGE_MODERATE);
    expect(coverageColorForConfidence(EVIDENCE_THRESHOLDS.solid - 1)).toEqual(COVERAGE_MODERATE);
  });

  it('weak (< dashed) and non-finite are red', () => {
    expect(coverageColorForConfidence(EVIDENCE_THRESHOLDS.dashed - 1)).toEqual(COVERAGE_WEAK);
    expect(coverageColorForConfidence(0)).toEqual(COVERAGE_WEAK);
    expect(coverageColorForConfidence(Number.NaN)).toEqual(COVERAGE_WEAK);
  });

  it('agrees with gradeForConfidence across the range', () => {
    for (let c = 0; c <= 100; c += 1) {
      expect(coverageColorForConfidence(c)).toEqual(coverageColorForGrade(gradeForConfidence(c)));
    }
  });
});

describe('coverageHeatmapImage — rasterises confidences to coloured pixels', () => {
  // 2x2 grid (no north-up flip so cell (col,row) maps to pixel (col,row)):
  //   (0,0) strong  (1,0) moderate
  //   (0,1) weak     (1,1) empty (transparent)
  const grid: CoverageGrid = {
    confidence: new Float32Array([
      EVIDENCE_THRESHOLDS.solid, EVIDENCE_THRESHOLDS.dashed,
      EVIDENCE_THRESHOLDS.dashed - 5, 0,
    ]),
    coverage: new Uint8Array([2, 1, 1, 0]),
    cols: 2,
    rows: 2,
  };

  it('paints green / yellow / red at the right cells', () => {
    const img = coverageHeatmapImage(grid, { northUp: false });
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(px(img, 0, 0)).toEqual([COVERAGE_STRONG.r, COVERAGE_STRONG.g, COVERAGE_STRONG.b, 255]);
    expect(px(img, 1, 0)).toEqual([COVERAGE_MODERATE.r, COVERAGE_MODERATE.g, COVERAGE_MODERATE.b, 255]);
    expect(px(img, 0, 1)).toEqual([COVERAGE_WEAK.r, COVERAGE_WEAK.g, COVERAGE_WEAK.b, 255]);
  });

  it('leaves empty / no-data cells transparent', () => {
    const img = coverageHeatmapImage(grid, { northUp: false });
    expect(px(img, 1, 1)[3]).toBe(0);
  });

  it('flips rows north-up by default', () => {
    // With the default north-up flip, grid bottom row (row 1) lands at image
    // top (row 0). So image (0,0) is grid (0,1) = weak red.
    const img = coverageHeatmapImage(grid);
    expect(px(img, 0, 0)).toEqual([COVERAGE_WEAK.r, COVERAGE_WEAK.g, COVERAGE_WEAK.b, 255]);
    expect(px(img, 0, 1)).toEqual([COVERAGE_STRONG.r, COVERAGE_STRONG.g, COVERAGE_STRONG.b, 255]);
  });

  it('returns an empty image for a zero-sized grid', () => {
    const img = coverageHeatmapImage({ confidence: [], coverage: [], cols: 0, rows: 0 });
    expect(img.width).toBe(0);
    expect(img.height).toBe(0);
    expect(img.data.length).toBe(0);
  });
});
