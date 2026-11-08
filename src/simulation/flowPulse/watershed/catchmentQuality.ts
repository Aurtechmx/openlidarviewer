/**
 * catchmentQuality.ts — how much of a catchment rests on measured ground, and
 * the grade that follows.
 *
 * Components.
 *  - `measuredShare`: catchment cells with measured ground (DTM coverage 2)
 *    over the valid cells of the catchment plus the NoData cells enclosed by
 *    its divide. A hole inside the divide is ground the scan never saw, so it
 *    counts against the share. It is 0 for an empty catchment.
 *  - `channelInterpolatedShare`: the length of main channel that runs over
 *    interpolated ground, over the channel length. Each D8 step is weighted by
 *    its length on the anisotropic grid (`cellMetresX`, `cellMetresY`), and a
 *    step belongs to its upstream cell. 0 when the channel has no step.
 *  - `longestFarInterpolatedRun`: the longest run of consecutive main-channel
 *    cells that are interpolated (coverage 1) with a confidence below
 *    `EVIDENCE_THRESHOLDS.dashed` (33). A confidence that is not a number does
 *    not reach 33, so it counts as low.
 *  - `touchesEnclosedHole`: a main-channel cell has an 8-neighbour that is
 *    NoData and is enclosed by data. NoData that reaches the grid border
 *    through other NoData lies outside the survey (`outsideSurface`) and does
 *    not count.
 *  - `groundPointsPerM2`: the ground returns counted in each catchment cell
 *    (DTM `counts`, the returns that reached the cell) summed over the mask,
 *    over the catchment area in m². Null when the horizontal scale is not
 *    resolved, when a cell length is not a positive number, or when the
 *    catchment has no cells. `horizontalScaleResolved` is optional and
 *    defaults to true, because the report is offered only when the scale is
 *    resolved.
 *
 * Verdict, exactly:
 *  - Supported: measured share >= 0.90 AND channel interpolated share <= 0.10
 *    AND the catchment is complete.
 *  - Not supported: a run of more than 5 far-interpolated channel cells, OR the
 *    channel touches an enclosed NoData cell. This wins over every other rule.
 *  - Limited: everything else. An open catchment is never better than limited.
 *
 * `reasons` lists every condition that applies, in a fixed order, as stable
 * ids for the wording catalog: 'measured-share-below-0.90',
 * 'channel-interpolated-over-0.10', 'channel-far-interpolated-run',
 * 'channel-touches-hole', 'catchment-open'.
 *
 * Pure: no DOM. Reads its inputs; changes none.
 */

import type { DtmGrid } from '../../../terrain/ground/cellConfidence';
import { EVIDENCE_THRESHOLDS } from '../../../terrain/ground/cellConfidence';
import { D8_NEIGHBOURS, outsideSurface, type FlowGrid } from '../flowTypes';
import type { MainChannel } from './mainChannel';
import type { TracedDivide } from './divideTrace';

export type Verdict = 'supported' | 'limited' | 'not-supported';

/** Measured share needed for a supported catchment (inclusive). */
export const SUPPORTED_MEASURED_SHARE = 0.9;
/** Largest share of the channel over interpolated ground in a supported catchment (inclusive). */
export const SUPPORTED_CHANNEL_INTERPOLATED_SHARE = 0.1;
/** A run longer than this many far-interpolated channel cells is not supported. */
export const MAX_FAR_INTERPOLATED_RUN = 5;

const COVERAGE_INTERPOLATED = 1;
const COVERAGE_MEASURED = 2;

export interface CatchmentQuality {
  /** Measured valid cells / (valid cells + enclosed hole cells). */
  readonly measuredShare: number;
  /** Interpolated main-channel length / main-channel length. */
  readonly channelInterpolatedShare: number;
  /** Cells, coverage 1 && confidence < 33. */
  readonly longestFarInterpolatedRun: number;
  readonly touchesEnclosedHole: boolean;
  readonly complete: boolean;
  /** Ground returns counted per m² of catchment; null when the scale is unresolved. */
  readonly groundPointsPerM2: number | null;
  readonly verdict: Verdict;
  /** Catalog keys for the wording, in a fixed order. */
  readonly reasons: readonly string[];
}

function isLength(m: number): boolean {
  return Number.isFinite(m) && m > 0;
}

export function catchmentQuality(input: {
  dtm: DtmGrid;
  mask: Uint8Array;
  channel: MainChannel;
  divide: TracedDivide;
  complete: boolean;
  flowGrid: FlowGrid;
  horizontalScaleResolved?: boolean;
}): CatchmentQuality {
  const { dtm, mask, channel, divide, complete, flowGrid } = input;
  const { cols, rows, cellMetresX, cellMetresY } = flowGrid;
  const cells = channel.cells;

  // --- Measured share ------------------------------------------------------
  let maskCells = 0;
  let measuredCells = 0;
  let returns = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) continue;
    maskCells++;
    if (dtm.coverage[i] === COVERAGE_MEASURED) measuredCells++;
    returns += dtm.counts[i];
  }
  const denominator = maskCells + divide.enclosedHoleCells;
  const measuredShare = denominator > 0 ? measuredCells / denominator : 0;

  // --- Ground density ------------------------------------------------------
  const scaleResolved = (input.horizontalScaleResolved ?? true) && isLength(cellMetresX) && isLength(cellMetresY);
  const areaM2 = maskCells * cellMetresX * cellMetresY;
  const groundPointsPerM2 = scaleResolved && maskCells > 0 ? returns / areaM2 : null;

  // --- Channel over interpolated ground, by length -------------------------
  let channelLength = 0;
  let interpolatedLength = 0;
  for (let k = 0; k + 1 < cells.length; k++) {
    const from = cells[k];
    const to = cells[k + 1];
    const dCol = (to % cols) - (from % cols);
    const dRow = Math.floor(to / cols) - Math.floor(from / cols);
    const step = Math.hypot(dCol * cellMetresX, dRow * cellMetresY);
    channelLength += step;
    if (channel.profile.interpolated[k] === 1) interpolatedLength += step;
  }
  const channelInterpolatedShare = channelLength > 0 ? interpolatedLength / channelLength : 0;

  // --- Longest run of far-interpolated cells -------------------------------
  let longestFarInterpolatedRun = 0;
  let run = 0;
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k];
    const far = dtm.coverage[cell] === COVERAGE_INTERPOLATED && !(dtm.confidence[cell] >= EVIDENCE_THRESHOLDS.dashed);
    run = far ? run + 1 : 0;
    if (run > longestFarInterpolatedRun) longestFarInterpolatedRun = run;
  }

  // --- Channel beside a NoData cell the data encloses ----------------------
  let touchesEnclosedHole = false;
  if (cells.length > 0) {
    const outside = outsideSurface(flowGrid);
    scan:
    for (let k = 0; k < cells.length; k++) {
      const col = cells[k] % cols;
      const row = Math.floor(cells[k] / cols);
      for (const [dc, dr] of D8_NEIGHBOURS) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
        const nb = r * cols + c;
        if (flowGrid.valid[nb] === 0 && outside[nb] === 0) { touchesEnclosedHole = true; break scan; }
      }
    }
  }

  // --- Verdict -------------------------------------------------------------
  const lowMeasured = measuredShare < SUPPORTED_MEASURED_SHARE;
  const channelInterpolated = channelInterpolatedShare > SUPPORTED_CHANNEL_INTERPOLATED_SHARE;
  const farRun = longestFarInterpolatedRun > MAX_FAR_INTERPOLATED_RUN;

  const reasons: string[] = [];
  if (lowMeasured) reasons.push('measured-share-below-0.90');
  if (channelInterpolated) reasons.push('channel-interpolated-over-0.10');
  if (farRun) reasons.push('channel-far-interpolated-run');
  if (touchesEnclosedHole) reasons.push('channel-touches-hole');
  if (!complete) reasons.push('catchment-open');

  let verdict: Verdict;
  if (farRun || touchesEnclosedHole) verdict = 'not-supported';
  else if (!lowMeasured && !channelInterpolated && complete) verdict = 'supported';
  else verdict = 'limited';

  return {
    measuredShare,
    channelInterpolatedShare,
    longestFarInterpolatedRun,
    touchesEnclosedHole,
    complete,
    groundPointsPerM2,
    verdict,
    reasons,
  };
}
