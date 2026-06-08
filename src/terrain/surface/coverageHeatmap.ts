/**
 * coverageHeatmap.ts
 *
 * Pure rasteriser for the COVERAGE HEATMAP — a green/yellow/red read of how
 * much the bare-earth DTM can be TRUSTED at each cell. It is a projection of
 * the per-cell confidence the DTM pipeline already computes
 * ({@link DtmGrid.confidence}); it derives no new analysis. The same colour
 * ramp drives both surfaces it feeds: the 2D preview tile in the Analyse panel
 * and the 3D point-cloud "Coverage" colour mode.
 *
 * Honesty contract. The three stops mean strong / moderate / weak terrain
 * SUPPORT, not accuracy classes:
 *   - GREEN  — strong: a measured / high-confidence cell (a ground return
 *              landed here; the surface is observed, not invented).
 *   - YELLOW — moderate: interpolated from nearby data — a reasonable fill.
 *   - RED    — weak: extrapolated / low-confidence / a gap — a directional
 *              guess or no reliable surface at all.
 * Empty / no-data cells are TRANSPARENT (alpha 0), so the eye reads a true
 * hole rather than a fabricated colour. The thresholds come from
 * {@link EVIDENCE_THRESHOLDS} / {@link gradeForConfidence}, so the heatmap
 * agrees cell-for-cell with the dashed-contour evidence. It is approximate and
 * never "survey-grade".
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import {
  EVIDENCE_THRESHOLDS,
  gradeForConfidence,
  type EvidenceGrade,
} from '../ground/cellConfidence';

/** 0..255 RGB triple. */
export interface CoverageRgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * The green / yellow / red coverage ramp. These are DATA colours (the meaning
 * of the value), not theme colours — they are deliberately fixed so the same
 * trust always reads the same hue across the 2D tile, the 3D cloud, and any
 * legend. Tuned for contrast against a dark viewer background while staying
 * within a conventional traffic-light reading.
 */
export const COVERAGE_STRONG: CoverageRgb = { r: 56, g: 176, b: 88 }; // green
export const COVERAGE_MODERATE: CoverageRgb = { r: 232, g: 196, b: 64 }; // yellow
export const COVERAGE_WEAK: CoverageRgb = { r: 214, g: 76, b: 64 }; // red

/**
 * Neutral dim grey for the 3D mode's "no analysed cell here" case (a point
 * outside the grid, or in an empty/no-data cell). The 2D tile renders those
 * cells transparent instead — see {@link coverageHeatmapImage}.
 */
export const COVERAGE_NONE: CoverageRgb = { r: 90, g: 94, b: 102 };

/** Map an evidence grade to its coverage ramp colour. */
export function coverageColorForGrade(grade: EvidenceGrade): CoverageRgb {
  switch (grade) {
    case 'solid':
      return COVERAGE_STRONG;
    case 'dashed':
      return COVERAGE_MODERATE;
    case 'gap':
      return COVERAGE_WEAK;
  }
}

/**
 * Map a 0..100 confidence to its coverage ramp colour, using the SAME
 * thresholds as the dashed-contour evidence ({@link gradeForConfidence}). A
 * non-finite confidence reads as weak (red), matching the grade mapping.
 */
export function coverageColorForConfidence(confidence: number): CoverageRgb {
  return coverageColorForGrade(gradeForConfidence(confidence));
}

/** The three-stop legend, strong → weak, for the tile and 3D legends. */
export const COVERAGE_LEGEND: ReadonlyArray<{
  readonly grade: EvidenceGrade;
  readonly color: CoverageRgb;
  readonly word: string;
  readonly meaning: string;
}> = [
  { grade: 'solid', color: COVERAGE_STRONG, word: 'strong', meaning: 'measured' },
  { grade: 'dashed', color: COVERAGE_MODERATE, word: 'moderate', meaning: 'interpolated' },
  { grade: 'gap', color: COVERAGE_WEAK, word: 'weak', meaning: 'extrapolated / gap' },
] as const;

/**
 * The honesty caption shown beneath every coverage surface.
 */
export const COVERAGE_CAPTION =
  'Where the bare-earth surface is measured (green) vs interpolated (yellow) ' +
  'vs unreliable (red) — approximate.';

/** The minimal grid the rasteriser needs — a {@link DtmGrid} fits structurally. */
export interface CoverageGrid {
  /** 0..100 trust per cell, row-major. */
  readonly confidence: ArrayLike<number>;
  /** Per-cell provenance (0 = none/empty, >0 = has a height). Row-major. */
  readonly coverage: ArrayLike<number>;
  readonly cols: number;
  readonly rows: number;
}

/** A rasterised coverage image — RGBA, row-major, top-left origin. */
export interface CoverageImage {
  /** Interleaved RGBA bytes, length `width * height * 4`. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Options for {@link coverageHeatmapImage}. */
export interface CoverageHeatmapOptions {
  /**
   * Flip rows so NORTH reads UP (grid row 0 is the bottom edge). Default true,
   * matching the other Analyse preview tiles. Set false for a raw, row-major
   * image (e.g. when the caller flips itself).
   */
  readonly northUp?: boolean;
}

/**
 * Rasterise a coverage grid to an RGBA image. Each cell with a height
 * (coverage > 0) is coloured green / yellow / red by its confidence grade;
 * empty / no-data cells (coverage 0) are transparent.
 *
 * Deterministic and DOM-free: returns a plain `Uint8ClampedArray` the caller
 * can hand to `ImageData` / `putImageData`, write to a PNG, or test directly.
 */
export function coverageHeatmapImage(
  grid: CoverageGrid,
  opts: CoverageHeatmapOptions = {},
): CoverageImage {
  const { cols, rows } = grid;
  const width = Math.max(0, cols | 0);
  const height = Math.max(0, rows | 0);
  const data = new Uint8ClampedArray(width * height * 4);
  if (width === 0 || height === 0) return { data, width, height };

  const northUp = opts.northUp ?? true;
  for (let row = 0; row < height; row++) {
    // When north-up, paint destination row `row` from the source row counted
    // from the bottom of the grid, so grid-north ends up at the image top.
    const srcRow = northUp ? height - 1 - row : row;
    for (let c = 0; c < width; c++) {
      const si = srcRow * width + c;
      const o = (row * width + c) * 4;
      // Empty / no-data cells stay transparent — a true hole, not a colour.
      if (grid.coverage[si] === 0) {
        data[o + 3] = 0;
        continue;
      }
      const col = coverageColorForConfidence(grid.confidence[si]);
      data[o] = col.r;
      data[o + 1] = col.g;
      data[o + 2] = col.b;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

// Re-export the threshold object so a consumer can read the cutoffs without
// reaching past the rasteriser into the confidence leaf.
export { EVIDENCE_THRESHOLDS };
