/**
 * dtmCellStatus.ts
 *
 * Pure-data leaf — assigns every DTM cell an explicit evidence status so
 * the rest of the pipeline (quality gate, contour grading, exports) never
 * treats an interpolated or edge cell like a measured one.
 *
 * Status precedence (a cell gets exactly one, highest-priority first):
 *   empty        — no reachable data; height is undefined.
 *   edgeRisk     — far from any measured cell (interpolation distance ≥
 *                  `edgeInterpDistanceCells`); the surface here is a long
 *                  reach from real returns and is the first thing a
 *                  surveyor should distrust.
 *   lowConfidence— covered, but confidence below the `dashed` threshold.
 *   interpolated — filled from nearby measured cells, acceptable confidence.
 *   measured     — at least one ground return landed in the cell.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { DtmGrid } from '../ground/cellConfidence';
import { EVIDENCE_THRESHOLDS } from '../ground/cellConfidence';
import { outsideCoverageMask } from '../ground/coverageFootprint';

/** The five mutually-exclusive cell statuses. */
export type CellStatus = 'measured' | 'interpolated' | 'empty' | 'lowConfidence' | 'edgeRisk';

/** Numeric codes (stored in a Uint8Array, parallel to the grid). */
export const CELL_STATUS_CODE = {
  empty: 0,
  measured: 1,
  interpolated: 2,
  lowConfidence: 3,
  edgeRisk: 4,
} as const;

/** Options for {@link classifyCellStatus}. */
export interface CellStatusParams {
  /** Confidence below this (0..100) marks a covered cell `lowConfidence`. Default = dashed threshold. */
  readonly lowConfidenceBelow?: number;
  /** Interpolation distance (cells) at/above which an interpolated cell is `edgeRisk`. Default 3. */
  readonly edgeInterpDistanceCells?: number;
}

/** Per-cell status counts. */
export interface CellStatusTally {
  readonly measured: number;
  readonly interpolated: number;
  readonly empty: number;
  readonly lowConfidence: number;
  readonly edgeRisk: number;
  readonly total: number;
  /**
   * The `empty` cells that lie OUTSIDE the surveyed area (no-data reaching the
   * grid border), as opposed to gaps the data surrounds. A strip survey in a
   * square grid leaves most of the grid here; it is not a gap in the surface.
   * Shares of the surveyed area divide by `total − outsideCoverage` and count
   * `empty − outsideCoverage` as its gaps. Absent on a tally built without the
   * grid (treated as 0).
   */
  readonly outsideCoverage?: number;
}

/**
 * Classify every cell of a DTM grid into a {@link CellStatus} code,
 * returned as a Uint8Array parallel to `dtm.z`.
 */
export function classifyCellStatus(dtm: DtmGrid, params: CellStatusParams = {}): Uint8Array {
  const lowBelow = params.lowConfidenceBelow ?? EVIDENCE_THRESHOLDS.dashed;
  const edgeDist = params.edgeInterpDistanceCells ?? 3;
  const n = dtm.coverage.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const cov = dtm.coverage[i];
    if (cov === 0) {
      out[i] = CELL_STATUS_CODE.empty;
      continue;
    }
    // A measured cell (has ≥1 ground return) is ALWAYS `measured` — its
    // status records provenance, not confidence. A thin (low-confidence)
    // measured cell still observed the ground; lumping it into
    // `lowConfidence` would make a sparse-but-real scan look like it has
    // no measured ground and wrongly block it. Confidence is a separate
    // axis (meanCellConfidence + the quality gate's confidence check).
    if (cov === 2) {
      out[i] = CELL_STATUS_CODE.measured;
      continue;
    }
    // Interpolated cell (cov === 1): edge-risk → low-confidence →
    // ordinary interpolated.
    const conf = dtm.confidence[i];
    const interpDist = dtm.interpDistanceCells[i];
    if (Number.isFinite(interpDist) && interpDist >= edgeDist) {
      out[i] = CELL_STATUS_CODE.edgeRisk;
    } else if (conf < lowBelow) {
      out[i] = CELL_STATUS_CODE.lowConfidence;
    } else {
      out[i] = CELL_STATUS_CODE.interpolated;
    }
  }
  return out;
}

/** Classify and tally a DTM grid, separating no-data outside the surveyed area. */
export function tallyDtmCellStatus(dtm: DtmGrid, params: CellStatusParams = {}): CellStatusTally {
  return tallyCellStatus(classifyCellStatus(dtm, params), outsideCoverageMask(dtm.coverage, dtm.cols, dtm.rows));
}

/**
 * Tally a status array into per-status counts. `outside` (1 = outside the
 * surveyed area, parallel to `statuses`) counts the empty cells that are not
 * gaps in the survey; omitted, none are.
 */
export function tallyCellStatus(statuses: Uint8Array, outside?: Uint8Array): CellStatusTally {
  let measured = 0;
  let interpolated = 0;
  let empty = 0;
  let lowConfidence = 0;
  let edgeRisk = 0;
  for (const status of statuses) {
    switch (status) {
      case CELL_STATUS_CODE.measured:
        measured++;
        break;
      case CELL_STATUS_CODE.interpolated:
        interpolated++;
        break;
      case CELL_STATUS_CODE.lowConfidence:
        lowConfidence++;
        break;
      case CELL_STATUS_CODE.edgeRisk:
        edgeRisk++;
        break;
      default:
        empty++;
    }
  }
  if (!outside) return { measured, interpolated, empty, lowConfidence, edgeRisk, total: statuses.length };
  let outsideCoverage = 0;
  for (let i = 0; i < statuses.length; i++) {
    if (outside[i] === 1 && statuses[i] === CELL_STATUS_CODE.empty) outsideCoverage++;
  }
  return { measured, interpolated, empty, lowConfidence, edgeRisk, total: statuses.length, outsideCoverage };
}
