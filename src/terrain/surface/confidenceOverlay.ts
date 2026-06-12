/**
 * confidenceOverlay.ts
 *
 * The COLOURBLIND-SAFE companion to the coverage heatmap: the same calibrated
 * per-cell DTM confidence ({@link DtmGrid.confidence}), the same three trust
 * buckets ({@link gradeForConfidence} — the thresholds the Analyse panel's
 * coverage minimap legend already uses), but rendered on the Cividis ramp
 * instead of the traffic-light green/yellow/red. Cividis is the ONE palette
 * the catalogue tags fully colourblind-safe (paletteCatalog.ts): monotonic
 * luminance, readable to deuteranopes / protanopes / tritanopes. The
 * traffic-light coverage ramp is conventional but invisible to ~8 % of
 * users; this overlay says the same thing in a vocabulary everyone can read.
 *
 * Honesty contract (identical to the coverage heatmap — the buckets MEAN the
 * same thing, only the hues differ):
 *   - STRONG   — measured: a ground return landed in the cell.
 *   - MODERATE — interpolated from nearby data — a reasonable fill.
 *   - WEAK     — extrapolated / low-confidence / gap — a directional guess.
 * Empty / no-data cells are TRANSPARENT in the 2D tile and neutral dim grey
 * in the 3D mode, so a hole is never painted as a confidence. Thresholds are
 * {@link EVIDENCE_THRESHOLDS} via {@link gradeForConfidence}, so this overlay
 * agrees cell-for-cell with the coverage tile, the dashed-contour evidence,
 * and the panel's click-to-sample readout. Approximate; never survey-grade.
 *
 * The three stops are exact Cividis control points (colorModes.ts
 * PALETTE_CIVIDIS, from Nuñez, Anderton & Renslow 2018) — strong = t 1.0,
 * moderate = t 0.6, weak = t 0.2. Weak deliberately uses the t 0.2 stop, not
 * t 0.0: the ramp floor (0, 32, 76) is nearly indistinguishable from the
 * dark viewer background (#0a0e1a), and a weak cell must stay VISIBLE — a
 * vanished point would read as "no data" rather than "untrustworthy data".
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import {
  gradeForConfidence,
  type EvidenceGrade,
} from '../ground/cellConfidence';
import type { CoverageRgb, CoverageGrid, CoverageImage } from './coverageHeatmap';
import { COVERAGE_NONE } from './coverageHeatmap';

/**
 * The colourblind-safe confidence ramp — exact Cividis control points, so the
 * mode inherits the palette's CVD guarantees instead of approximating them.
 * DATA colours (the meaning of the value), not theme colours — fixed so the
 * same trust always reads the same hue across the 2D tile, the 3D cloud and
 * any legend.
 */
export const CONFIDENCE_STRONG: CoverageRgb = { r: 253, g: 231, b: 37 }; // cividis t=1.0
export const CONFIDENCE_MODERATE: CoverageRgb = { r: 135, g: 132, b: 119 }; // cividis t=0.6
export const CONFIDENCE_WEAK: CoverageRgb = { r: 44, g: 60, b: 100 }; // cividis t=0.2

/**
 * Neutral dim grey for the 3D mode's "no analysed cell here" case — the SAME
 * grey the coverage mode uses, so "outside the analysis" reads identically
 * whichever trust overlay is active.
 */
export const CONFIDENCE_NONE: CoverageRgb = COVERAGE_NONE;

/** Map an evidence grade to its confidence ramp colour. */
export function confidenceColorForGrade(grade: EvidenceGrade): CoverageRgb {
  switch (grade) {
    case 'solid':
      return CONFIDENCE_STRONG;
    case 'dashed':
      return CONFIDENCE_MODERATE;
    case 'gap':
      return CONFIDENCE_WEAK;
  }
}

/**
 * Map a 0..100 calibrated confidence to its ramp colour, through the SAME
 * thresholds as the coverage tile + dashed-contour evidence
 * ({@link gradeForConfidence}). A non-finite confidence reads as weak,
 * matching the grade mapping.
 */
export function confidenceColorForConfidence(confidence: number): CoverageRgb {
  return confidenceColorForGrade(gradeForConfidence(confidence));
}

/** The three-stop legend, strong → weak, for the tile and 3D legends. */
export const CONFIDENCE_LEGEND: ReadonlyArray<{
  readonly grade: EvidenceGrade;
  readonly color: CoverageRgb;
  readonly word: string;
  readonly meaning: string;
}> = [
  { grade: 'solid', color: CONFIDENCE_STRONG, word: 'strong', meaning: 'measured' },
  { grade: 'dashed', color: CONFIDENCE_MODERATE, word: 'moderate', meaning: 'interpolated' },
  { grade: 'gap', color: CONFIDENCE_WEAK, word: 'weak', meaning: 'extrapolated / gap' },
] as const;

/** The honesty caption shown beside every confidence surface. */
export const CONFIDENCE_CAPTION =
  'Calibrated trust in the bare-earth surface — bright = measured, mid = ' +
  'interpolated, dark = extrapolated/gap. Colourblind-safe (Cividis); approximate.';

/**
 * Rasterise a confidence grid to an RGBA image — the colourblind-safe twin of
 * `coverageHeatmapImage`, sharing its grid contract and north-up convention.
 * Each cell with a height (coverage > 0) is coloured by its confidence grade;
 * empty / no-data cells (coverage 0) are transparent.
 *
 * Deterministic and DOM-free: returns a plain `Uint8ClampedArray` the caller
 * can hand to `ImageData` / `putImageData`, write to a PNG, or test directly.
 */
export function confidenceOverlayImage(
  grid: CoverageGrid,
  opts: { readonly northUp?: boolean } = {},
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
      const di = (row * width + c) * 4;
      if (grid.coverage[si] === 0) continue; // transparent — a true hole
      const rgb = confidenceColorForConfidence(grid.confidence[si]);
      data[di] = rgb.r;
      data[di + 1] = rgb.g;
      data[di + 2] = rgb.b;
      data[di + 3] = 255;
    }
  }
  return { data, width, height };
}
