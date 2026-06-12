/**
 * confidenceOverlay.test.ts — the colourblind-safe confidence ramp + raster +
 * 3D colour mode (the Cividis twin of coverageHeatmap.test.ts).
 *
 * Asserts that a grid of KNOWN confidences maps to the right Cividis-stop
 * pixels at the right cells, that empty cells are transparent, that the
 * thresholds agree with `gradeForConfidence` (the SAME buckets the coverage
 * minimap legend uses), and that the 3D `colorByConfidence` mode samples the
 * SAME cell per point as the coverage mode (shared grid-lookup core) while
 * painting the Cividis colours.
 */

import { describe, it, expect } from 'vitest';
import {
  confidenceOverlayImage,
  confidenceColorForConfidence,
  confidenceColorForGrade,
  CONFIDENCE_STRONG,
  CONFIDENCE_MODERATE,
  CONFIDENCE_WEAK,
  CONFIDENCE_NONE,
  CONFIDENCE_LEGEND,
} from '../src/terrain/surface/confidenceOverlay';
import {
  COVERAGE_NONE,
  COVERAGE_LEGEND,
  type CoverageGrid,
} from '../src/terrain/surface/coverageHeatmap';
import { EVIDENCE_THRESHOLDS, gradeForConfidence } from '../src/terrain/ground/cellConfidence';
import { colorByConfidence, type CoverageColorGrid } from '../src/render/colorModes';
import { listBuiltinPalettes } from '../src/render/paletteCatalog';

/** Read the RGBA at (col,row) of an image. */
function px(
  img: { data: Uint8ClampedArray; width: number },
  col: number,
  row: number,
): [number, number, number, number] {
  const o = (row * img.width + col) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

describe('confidenceColorForConfidence — thresholds tie to gradeForConfidence', () => {
  it('strong (>= solid) is the bright Cividis stop', () => {
    expect(confidenceColorForConfidence(EVIDENCE_THRESHOLDS.solid)).toEqual(CONFIDENCE_STRONG);
    expect(confidenceColorForConfidence(100)).toEqual(CONFIDENCE_STRONG);
  });

  it('moderate (dashed..solid) is the mid Cividis stop', () => {
    expect(confidenceColorForConfidence(EVIDENCE_THRESHOLDS.dashed)).toEqual(CONFIDENCE_MODERATE);
    expect(confidenceColorForConfidence(EVIDENCE_THRESHOLDS.solid - 1)).toEqual(
      CONFIDENCE_MODERATE,
    );
  });

  it('weak (< dashed) and non-finite are the dark Cividis stop', () => {
    expect(confidenceColorForConfidence(EVIDENCE_THRESHOLDS.dashed - 1)).toEqual(CONFIDENCE_WEAK);
    expect(confidenceColorForConfidence(0)).toEqual(CONFIDENCE_WEAK);
    expect(confidenceColorForConfidence(Number.NaN)).toEqual(CONFIDENCE_WEAK);
  });

  it('agrees with gradeForConfidence across the range — same buckets as the minimap legend', () => {
    for (let c = 0; c <= 100; c += 1) {
      expect(confidenceColorForConfidence(c)).toEqual(
        confidenceColorForGrade(gradeForConfidence(c)),
      );
    }
  });

  it('its stops are exact Cividis control points and the catalogue tags Cividis CVD-safe', () => {
    // Hand-copied from PALETTE_CIVIDIS (colorModes.ts): t=1.0 / t=0.6 / t=0.2.
    expect(CONFIDENCE_STRONG).toEqual({ r: 253, g: 231, b: 37 });
    expect(CONFIDENCE_MODERATE).toEqual({ r: 135, g: 132, b: 119 });
    expect(CONFIDENCE_WEAK).toEqual({ r: 44, g: 60, b: 100 });
    const cividis = listBuiltinPalettes().find((p) => p.id === 'cividis')!;
    expect(cividis.colorblindSafe).toBe(true);
  });

  it('legend words/meanings match the coverage legend bucket-for-bucket (only hues differ)', () => {
    expect(CONFIDENCE_LEGEND.map((s) => [s.grade, s.word, s.meaning])).toEqual(
      COVERAGE_LEGEND.map((s) => [s.grade, s.word, s.meaning]),
    );
    expect(CONFIDENCE_NONE).toEqual(COVERAGE_NONE);
  });
});

describe('confidenceOverlayImage — rasterises confidences to Cividis pixels', () => {
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

  it('paints bright / mid / dark at the right cells', () => {
    const img = confidenceOverlayImage(grid, { northUp: false });
    expect(img.width).toBe(2);
    expect(img.height).toBe(2);
    expect(px(img, 0, 0)).toEqual([
      CONFIDENCE_STRONG.r, CONFIDENCE_STRONG.g, CONFIDENCE_STRONG.b, 255,
    ]);
    expect(px(img, 1, 0)).toEqual([
      CONFIDENCE_MODERATE.r, CONFIDENCE_MODERATE.g, CONFIDENCE_MODERATE.b, 255,
    ]);
    expect(px(img, 0, 1)).toEqual([
      CONFIDENCE_WEAK.r, CONFIDENCE_WEAK.g, CONFIDENCE_WEAK.b, 255,
    ]);
  });

  it('leaves empty / no-data cells transparent', () => {
    const img = confidenceOverlayImage(grid, { northUp: false });
    expect(px(img, 1, 1)[3]).toBe(0);
  });

  it('flips rows for north-up (grid row 0 paints the bottom image row)', () => {
    const img = confidenceOverlayImage(grid, { northUp: true });
    // Grid (0,0) = strong is row 0 of the GRID, so north-up puts it at the
    // BOTTOM image row (row 1 of 2).
    expect(px(img, 0, 1)).toEqual([
      CONFIDENCE_STRONG.r, CONFIDENCE_STRONG.g, CONFIDENCE_STRONG.b, 255,
    ]);
  });
});

describe("colorByConfidence — the 3D 'Confidence' colour mode (coverage-mode pattern)", () => {
  // 2x2 grid, 1 m cells, origin (10, 20). Hand-mapped points:
  //   (10.5, 20.5) → cell (0,0) strong
  //   (11.5, 20.5) → cell (1,0) moderate
  //   (10.5, 21.5) → cell (0,1) weak
  //   (11.5, 21.5) → cell (1,1) empty → neutral grey
  //   (99, 99)     → outside the grid → neutral grey
  const grid: CoverageColorGrid = {
    confidence: new Float32Array([
      EVIDENCE_THRESHOLDS.solid, EVIDENCE_THRESHOLDS.dashed,
      EVIDENCE_THRESHOLDS.dashed - 5, 0,
    ]),
    coverage: new Uint8Array([2, 1, 1, 0]),
    cols: 2,
    rows: 2,
    cellSizeM: 1,
    originH1: 10,
    originH2: 20,
  };
  const positions = new Float32Array([
    10.5, 20.5, 0,
    11.5, 20.5, 0,
    10.5, 21.5, 0,
    11.5, 21.5, 0,
    99, 99, 0,
  ]);

  it('colours each point by the confidence bucket of the DTM cell it falls in', () => {
    const rgb = colorByConfidence(positions, 5, grid);
    expect([rgb[0], rgb[1], rgb[2]]).toEqual([
      CONFIDENCE_STRONG.r, CONFIDENCE_STRONG.g, CONFIDENCE_STRONG.b,
    ]);
    expect([rgb[3], rgb[4], rgb[5]]).toEqual([
      CONFIDENCE_MODERATE.r, CONFIDENCE_MODERATE.g, CONFIDENCE_MODERATE.b,
    ]);
    expect([rgb[6], rgb[7], rgb[8]]).toEqual([
      CONFIDENCE_WEAK.r, CONFIDENCE_WEAK.g, CONFIDENCE_WEAK.b,
    ]);
  });

  it('empty cells and out-of-grid points read the neutral dim grey', () => {
    const rgb = colorByConfidence(positions, 5, grid);
    expect([rgb[9], rgb[10], rgb[11]]).toEqual([
      CONFIDENCE_NONE.r, CONFIDENCE_NONE.g, CONFIDENCE_NONE.b,
    ]);
    expect([rgb[12], rgb[13], rgb[14]]).toEqual([
      CONFIDENCE_NONE.r, CONFIDENCE_NONE.g, CONFIDENCE_NONE.b,
    ]);
  });
});
