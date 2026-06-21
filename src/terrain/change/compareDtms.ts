/**
 * compareDtms.ts
 *
 * The bridge between the terrain DTM pipeline and the pure two-epoch change
 * core. `detectChange` only sees bare grids (values + cell size + dims), so it
 * can flag a cell-size / dimension mismatch but CANNOT see world position, CRS,
 * or vertical datum — exactly the things a change comparison is easiest to
 * mislead with. This module adds that co-registration check: two DTMs that
 * happen to share a raster shape but sit at different world origins, CRSs, or
 * vertical datums are NOT comparable cell-for-cell, and a silent subtraction
 * would measure misregistration, not change.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic. The wipe/heatmap UI
 * that visualises the difference is a separate, browser-verified layer.
 */

import type { DtmGrid } from '../ground/cellConfidence';
import {
  detectChange,
  type ChangeGrid,
  type ChangeResult,
  type ChangeDetectionOptions,
} from './changeDetection';

/**
 * Adapt a {@link DtmGrid} to the bare {@link ChangeGrid} the change core
 * consumes: heights row-major, with empty cells (coverage 0) carried as NaN so
 * they read as incomparable — never as a real 0 m height.
 */
export function dtmToChangeGrid(dtm: DtmGrid): ChangeGrid {
  const n = dtm.cols * dtm.rows;
  const values = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    values[i] = dtm.coverage[i] > 0 ? dtm.z[i] : Number.NaN;
  }
  return { width: dtm.cols, height: dtm.rows, cellSizeM: dtm.cellSizeM, values };
}

/** A two-epoch comparison plus the co-registration verdict the grids can't carry. */
export interface EpochComparison {
  readonly result: ChangeResult;
  /**
   * True only when the two DTMs share a raster (cell size + dims), sit at the
   * same world origin (within half a cell), and declare the same CRS + vertical
   * datum where both are known. When false, `coregistrationNotes` says why and
   * the difference should be treated as indicative, not measured.
   */
  readonly coregistered: boolean;
  /** Plain-language co-registration caveats (empty when fully aligned). */
  readonly coregistrationNotes: readonly string[];
}

/**
 * Compare two terrain DTMs (epoch `a` = before, `b` = after), adding the
 * world-origin / CRS / vertical-datum co-registration check on top of the pure
 * `detectChange` grid math.
 */
export function compareDtms(
  a: DtmGrid,
  b: DtmGrid,
  options: ChangeDetectionOptions = {},
): EpochComparison {
  const notes: string[] = [];

  // World origin: same raster shape is not enough — the grids must start at the
  // same world point, or cell (x,y) of one is a different place than the other.
  const tol = Math.max(a.cellSizeM, b.cellSizeM) * 0.5;
  const dH1 = Math.abs(a.originH1 - b.originH1);
  const dH2 = Math.abs(a.originH2 - b.originH2);
  if (dH1 > tol || dH2 > tol) {
    const off = Math.max(dH1, dH2);
    notes.push(
      `The two epochs are offset by about ${off.toFixed(2)} m at the grid origin — ` +
        `co-register them (align to common ground control) before trusting the difference.`,
    );
  }

  if (a.crs && b.crs && a.crs !== b.crs) {
    notes.push(
      `Horizontal CRS differs (${a.crs} vs ${b.crs}) — the grids aren't in the same frame.`,
    );
  }
  if (a.verticalDatum && b.verticalDatum && a.verticalDatum !== b.verticalDatum) {
    notes.push(
      `Vertical datum differs (${a.verticalDatum} vs ${b.verticalDatum}) — ` +
        `heights aren't on a common reference, so the elevation difference is unreliable.`,
    );
  }

  const result = detectChange(dtmToChangeGrid(a), dtmToChangeGrid(b), options);
  // The raster mismatch (cell size / dims) is already in result.warnings; the
  // overall co-registration verdict folds those in too.
  const coregistered = result.aligned && notes.length === 0;
  return { result, coregistered, coregistrationNotes: notes };
}

/**
 * A short, human-readable summary of a comparison for a panel or export — the
 * cut/fill volumes, the change significance, and every co-registration caveat,
 * so the numbers never travel without their honesty context.
 */
export function summarizeChange(comparison: EpochComparison): string[] {
  const { result, coregistered, coregistrationNotes } = comparison;
  const s = result.stats;
  const lines: string[] = [];

  if (!coregistered) {
    lines.push('⚠ Not co-registered — treat the difference as indicative, not measured.');
  }
  lines.push(
    `Net volume change: ${s.netVolumeM3.toFixed(1)} m³ ` +
      `(gain ${s.gainVolumeM3.toFixed(1)} m³, loss ${s.lossVolumeM3.toFixed(1)} m³).`,
  );
  lines.push(
    `${(s.significantFraction * 100).toFixed(1)}% of comparable cells changed beyond the ` +
      `detection floor (${s.gained} gained, ${s.lost} lost, ${s.unchanged} unchanged).`,
  );
  lines.push(
    `Largest gain ${s.maxGainM.toFixed(2)} m, largest loss ${s.maxLossM.toFixed(2)} m; ` +
      `mean |Δ| ${s.meanAbsChangeM.toFixed(2)} m over ${s.comparable} comparable cells.`,
  );
  for (const w of result.warnings) lines.push(`• ${w}`);
  for (const note of coregistrationNotes) lines.push(`• ${note}`);
  return lines;
}
