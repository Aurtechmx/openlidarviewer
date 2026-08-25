/**
 * rangeFrameDiagnostics.ts — what an acquisition grid says about itself.
 *
 * `OrganizedRangeFrame` stores the scanner's grid: per-cell state, the display
 * record each cell produced, and a range where one exists. That is the raw
 * material. This module turns one frame, or one set, into the handful of
 * numbers a person would actually read, and nothing else.
 *
 * Pure and DOM-free, so it runs under Node and inside a worker. It returns
 * DATA, never strings: no rounding, no units, no locale, no percent signs. A
 * caller owns presentation, and a caller that wants three decimal places must
 * not have to parse them back out of a sentence.
 *
 * WHAT THIS MODULE REFUSES TO DO.
 *
 * It never names a cause. A band of NO_RETURN cells can be glass, water, wet
 * asphalt, a surface beyond the instrument's range, or a beam that left the
 * scene entirely. The frame records that nothing came back; which of those it
 * was is not derivable from the grid, and a diagnostic that guessed would be
 * inventing evidence. The same holds for a SOURCE_INVALID run: the file is
 * malformed here, and why is the writer's business.
 *
 * It never substitutes zero for absent. A frame with no `geometricRange` has
 * not measured a minimum of zero metres; it has not measured anything, and the
 * statistics come back `null`. Likewise every fraction over an empty
 * denominator: 0/0 is `null`, because a report that prints "NaN%" has already
 * lost the reader, and one that prints "0%" has lied to them.
 */

import {
  CELL_STATES,
  CellState,
  tallyCellStates,
  type CellStateValue,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
  type RangeLinkage,
} from '../model/OrganizedRange';
import { quantileSorted } from '../terrain/quantile';

/** A count and its share of the whole. `fraction` is null when there is no whole. */
export interface StateShare {
  readonly count: number;
  /** `count / cells`, or null when `cells` is zero. Never NaN. */
  readonly fraction: number | null;
}

export interface ValidityDiagnostics {
  readonly cells: number;
  /** Every state, always present, so a caller can render a stable table. */
  readonly byState: Readonly<Record<CellStateValue, StateShare>>;
}

/**
 * Order statistics over the cells that carry a finite range.
 *
 * The three counts are deliberately separate and are NOT interchangeable:
 *
 *   `finiteCount`        cells whose range is a real number, the sample every
 *                        statistic below is computed over.
 *   `excludedNonFinite`  cells the frame says produced a return (VALID_RETURN)
 *                        whose range is not finite. loadPtx writes NaN here
 *                        when a distance saturates float32, because Infinity
 *                        is not a distance. This is a representational limit,
 *                        not an observation.
 *   `cellsWithoutRange`  cells that never had a range to lose: a no-return, an
 *                        undecoded record, a missing one. The array is seeded
 *                        with NaN, so these are NaN too, and counting them
 *                        alongside the saturated returns would report a
 *                        property of the pipeline as a property of the file.
 *
 * The three sum to the cell total.
 */
export interface RangeStatistics {
  readonly finiteCount: number;
  readonly excludedNonFinite: number;
  readonly cellsWithoutRange: number;
  /** Null when `finiteCount` is zero. Absent is not zero. */
  readonly min: number | null;
  readonly max: number | null;
  readonly median: number | null;
  readonly p95: number | null;
}

/** One band of the grid along one axis, half-open: columns or rows `[start, end)`. */
export interface BandCoverage {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  /** Cells in the band: `(end - start)` times the length of the other axis. */
  readonly cells: number;
  /** Cells this session delivered a record for, i.e. everything not NOT_DECODED. */
  readonly decoded: number;
  readonly notDecoded: number;
  /** `decoded / cells`, or null for an empty band. */
  readonly decodedFraction: number | null;
}

/**
 * Where the decoded fraction actually falls on the grid.
 *
 * Stride sampling picks records in FILE order. The grid is two-dimensional and
 * a format writes it along one axis (PTX down a column, PCD across a row), so a
 * stride that keeps one record in four keeps whole bands of the fast axis and
 * skips whole bands of the slow one. The aggregate "25% decoded" is true and
 * says nothing about that. Splitting each axis into bands says where.
 *
 * THE HONEST LIMIT: this describes COVERAGE and nothing more. Even bands across
 * both axes mean the sampled cells are spread over the grid; it does not follow
 * that the sampled returns are representative of the scene, of its surfaces, or
 * of any quantity derived from them. A uniform sample of a grid is still a
 * sample, and this module makes no claim about what it preserves.
 */
export interface SamplingCoverage {
  readonly columnBands: readonly BandCoverage[];
  readonly rowBands: readonly BandCoverage[];
}

export interface RangeFrameSummary {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly linkage: RangeLinkage;
  readonly validity: ValidityDiagnostics;
  /** Null when the frame carries no `geometricRange` at all. */
  readonly range: RangeStatistics | null;
  readonly coverage: SamplingCoverage;
}

export interface RangeSetSummary {
  readonly organization: OrganizedRangeSet['organization'];
  readonly frames: readonly RangeFrameSummary[];
  /** Validity totalled over every frame. */
  readonly validity: ValidityDiagnostics;
  /** One entry per frame, in frame order. */
  readonly linkageKinds: readonly RangeLinkage['kind'][];
}

/**
 * Bands per axis.
 *
 * Eight is a reading number, not a statistical one. Enough to separate a
 * one-sided decimation from an even one and to show a gradient across the
 * grid; few enough that a person takes the whole row in at a glance and that
 * each band over a real scanner axis (hundreds to thousands of cells) still
 * holds a substantial count. More bands turn a diagnostic into a chart, which
 * is a different tool with a different owner. An axis shorter than this gets
 * one band per column or row, so no band is ever empty.
 */
export const COVERAGE_BAND_TARGET = 8;

function shareOf(count: number, total: number): StateShare {
  return { count, fraction: total === 0 ? null : count / total };
}

function validityFrom(cells: number, counts: Record<CellStateValue, number>): ValidityDiagnostics {
  const byState = {} as Record<CellStateValue, StateShare>;
  for (const state of CELL_STATES) byState[state] = shareOf(counts[state], cells);
  return { cells, byState };
}

/**
 * Band edges that tile `[0, length)` exactly.
 *
 * `floor(i * length / n)` gives contiguous, non-overlapping bands whose sizes
 * differ by at most one when `n` does not divide `length`. Computing a width
 * and multiplying instead leaves the last band short or long, which shows up
 * as a coverage figure over the wrong denominator.
 */
function bandEdges(length: number): readonly (readonly [number, number])[] {
  if (length <= 0) return [];
  const n = Math.min(COVERAGE_BAND_TARGET, length);
  const edges: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    edges.push([Math.floor((i * length) / n), Math.floor(((i + 1) * length) / n)]);
  }
  return edges;
}

function bandsAlong(
  frame: OrganizedRangeFrame,
  axis: 'column' | 'row',
): readonly BandCoverage[] {
  const { width, height, cellState } = frame;
  if (width <= 0 || height <= 0) return [];
  const edges = bandEdges(axis === 'column' ? width : height);
  return edges.map(([start, end], index) => {
    let decoded = 0;
    let cells = 0;
    const rowFrom = axis === 'row' ? start : 0;
    const rowTo = axis === 'row' ? end : height;
    const colFrom = axis === 'column' ? start : 0;
    const colTo = axis === 'column' ? end : width;
    for (let row = rowFrom; row < rowTo; row++) {
      for (let col = colFrom; col < colTo; col++) {
        cells++;
        if (cellState[row * width + col] !== CellState.NOT_DECODED) decoded++;
      }
    }
    return {
      index,
      start,
      end,
      cells,
      decoded,
      notDecoded: cells - decoded,
      decodedFraction: cells === 0 ? null : decoded / cells,
    };
  });
}

/**
 * Order statistics over the finite ranges, or null when the frame has none.
 *
 * PERCENTILE CONVENTION: type 7, the interpolating quantile, reused from
 * src/terrain/quantile.ts. That module is already declared THE convention for
 * this project after the v0.4.3 audit found three of them coexisting, and it
 * matches the default of NumPy, R and Excel's PERCENTILE.INC, so a reported p95
 * reproduces against standard tools. The nearest-rank form in
 * src/validation/checkpointAccuracy.ts is the other survivor and disagrees by
 * up to one order-statistic gap; it is not imported here, and a third private
 * implementation in this file would be a defect rather than a convenience.
 *
 * Collected into a plain `number[]`, which is float64. The values arrive as
 * float32 and every statistic here is an order statistic, so widening changes
 * none of them today; it is the storage that stays correct if a derived
 * quantity is ever added, and it costs nothing to state now. A float32 buffer
 * would additionally round the interpolated percentile, which is a real
 * difference and is pinned by a test.
 */
function rangeStatisticsOf(frame: OrganizedRangeFrame): RangeStatistics | null {
  const ranges = frame.geometricRange;
  if (!ranges) return null;

  const finite: number[] = [];
  let excludedNonFinite = 0;
  let cellsWithoutRange = 0;
  for (let i = 0; i < ranges.length; i++) {
    const v = ranges[i];
    if (Number.isFinite(v)) {
      finite.push(v);
      continue;
    }
    // The cell state decides which kind of absence this is. A VALID_RETURN
    // with no usable range is a return whose distance was not representable;
    // anything else never carried a range in the first place.
    if (frame.cellState[i] === CellState.VALID_RETURN) excludedNonFinite++;
    else cellsWithoutRange++;
  }

  if (finite.length === 0) {
    return {
      finiteCount: 0,
      excludedNonFinite,
      cellsWithoutRange,
      min: null,
      max: null,
      median: null,
      p95: null,
    };
  }

  finite.sort((a, b) => a - b);
  return {
    finiteCount: finite.length,
    excludedNonFinite,
    cellsWithoutRange,
    min: finite[0],
    max: finite[finite.length - 1],
    median: quantileSorted(finite, 0.5),
    p95: quantileSorted(finite, 0.95),
  };
}

/** Summarise one acquisition grid. Deterministic, and reads nothing outside the frame. */
export function summariseRangeFrame(frame: OrganizedRangeFrame): RangeFrameSummary {
  // Re-tallied rather than trusting `frame.diagnostics`, which is a snapshot
  // taken at construction and may predate an edit to `cellState`.
  const tally = tallyCellStates(frame.cellState);
  return {
    id: frame.id,
    width: frame.width,
    height: frame.height,
    linkage: frame.linkage,
    validity: validityFrom(tally.cells, tally.stateCounts),
    range: rangeStatisticsOf(frame),
    coverage: {
      columnBands: bandsAlong(frame, 'column'),
      rowBands: bandsAlong(frame, 'row'),
    },
  };
}

/**
 * Summarise a whole set: every frame, plus validity totalled across them.
 *
 * Range statistics are NOT pooled across frames. Each setup has its own origin,
 * so a range is a distance from a different point in every frame, and a median
 * over the union would be a median of distances to several instruments at once.
 * The per-frame statistics stay per frame.
 */
export function summariseRangeSet(set: OrganizedRangeSet): RangeSetSummary {
  const frames = set.frames.map(summariseRangeFrame);
  const totals = {} as Record<CellStateValue, number>;
  for (const state of CELL_STATES) totals[state] = 0;
  let cells = 0;
  for (const f of frames) {
    cells += f.validity.cells;
    for (const state of CELL_STATES) totals[state] += f.validity.byState[state].count;
  }
  return {
    organization: set.organization,
    frames,
    validity: validityFrom(cells, totals),
    linkageKinds: set.frames.map((f) => f.linkage.kind),
  };
}
