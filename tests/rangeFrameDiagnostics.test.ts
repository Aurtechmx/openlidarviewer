/**
 * rangeFrameDiagnostics.test.ts — the numbers a person reads off an
 * acquisition grid.
 *
 * Every frame here is built by hand and is small enough that each expected
 * value is known by construction rather than by running the code and copying
 * what it printed. The cases exist for four failures that all produce plausible
 * output: a fraction that surfaces as NaN, a NaN range counted as a measurement
 * of zero, a percentile that silently switches convention, and a decoded
 * fraction that is honest in aggregate while hiding which half of the grid was
 * thrown away.
 */

import { describe, it, expect } from 'vitest';
import {
  CellState,
  tallyCellStates,
  NO_RECORD,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from '../src/model/OrganizedRange';
import {
  summariseRangeFrame,
  summariseRangeSet,
  COVERAGE_BAND_TARGET,
} from '../src/diagnostics/rangeFrameDiagnostics';

/** Build a frame from a literal state grid, row-major, so the fixture reads like the grid. */
function frameOf(
  width: number,
  height: number,
  states: number[],
  ranges?: number[],
): OrganizedRangeFrame {
  const cellState = new Uint8Array(states);
  const cellToRecord = new Int32Array(width * height).fill(NO_RECORD);
  for (let i = 0; i < cellState.length; i++) {
    if (cellState[i] === CellState.VALID_RETURN) cellToRecord[i] = i;
  }
  return {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    geometricRange: ranges ? Float32Array.from(ranges) : undefined,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
}

describe('validity', () => {
  it('reports a fraction per state that sums to one', () => {
    // 4 cells: two valid, one no-return, one not decoded. Every fraction is a
    // quarter or a half, so no rounding can hide an off-by-one.
    const frame = frameOf(2, 2, [
      CellState.VALID_RETURN,
      CellState.VALID_RETURN,
      CellState.NO_RETURN,
      CellState.NOT_DECODED,
    ]);
    const v = summariseRangeFrame(frame).validity;
    expect(v.cells).toBe(4);
    expect(v.byState[CellState.VALID_RETURN]).toEqual({ count: 2, fraction: 0.5 });
    expect(v.byState[CellState.NO_RETURN]).toEqual({ count: 1, fraction: 0.25 });
    expect(v.byState[CellState.NOT_DECODED]).toEqual({ count: 1, fraction: 0.25 });
    expect(v.byState[CellState.SOURCE_INVALID]).toEqual({ count: 0, fraction: 0 });
  });

  it('leaves every fraction absent on a zero-cell frame rather than reporting NaN', () => {
    // A frame whose grid the file could not back has no cells at all. 0/0 is
    // not zero and not one; a report that prints "NaN%" has invented a number.
    const frame = frameOf(0, 0, []);
    const s = summariseRangeFrame(frame);
    expect(s.validity.cells).toBe(0);
    for (const share of Object.values(s.validity.byState)) {
      expect(share.count).toBe(0);
      expect(share.fraction).toBeNull();
    }
    expect(s.coverage.columnBands).toEqual([]);
    expect(s.coverage.rowBands).toEqual([]);
  });
});

describe('geometric range statistics', () => {
  it('is absent, not zero, when the frame carries no range array', () => {
    // Zero is a measurement. A frame with no geometricRange has not measured
    // anything, and a report that shows "min 0 m" is stating a false fact.
    const frame = frameOf(2, 1, [CellState.VALID_RETURN, CellState.VALID_RETURN]);
    expect(summariseRangeFrame(frame).range).toBeNull();
  });

  it('separates a range excluded as non-finite from a cell that never had one', () => {
    // The PTX loader seeds geometricRange with NaN and also writes NaN into a
    // VALID_RETURN cell whose range saturates float32. Those two NaNs mean
    // different things: one cell produced no return, the other produced a
    // return whose distance could not be represented. Collapsing them would
    // report an arithmetic limit as an observation about the scene.
    const frame = frameOf(
      2,
      2,
      [
        CellState.VALID_RETURN,
        CellState.VALID_RETURN,
        CellState.VALID_RETURN,
        CellState.NO_RETURN,
      ],
      [1, Number.NaN, 3, Number.NaN],
    );
    const r = summariseRangeFrame(frame).range;
    expect(r).not.toBeNull();
    expect(r?.finiteCount).toBe(2);
    expect(r?.excludedNonFinite).toBe(1);
    expect(r?.cellsWithoutRange).toBe(1);
    expect(r?.min).toBe(1);
    expect(r?.max).toBe(3);
  });

  it('reports every statistic as absent when no range is finite', () => {
    // Same rule as the missing array: nothing finite survived, so there is no
    // minimum to state. The counts still say how the frame got there.
    const frame = frameOf(
      2,
      1,
      [CellState.VALID_RETURN, CellState.VALID_RETURN],
      [Number.NaN, Number.NaN],
    );
    const r = summariseRangeFrame(frame).range;
    expect(r?.finiteCount).toBe(0);
    expect(r?.excludedNonFinite).toBe(2);
    expect(r?.min).toBeNull();
    expect(r?.max).toBeNull();
    expect(r?.median).toBeNull();
    expect(r?.p95).toBeNull();
  });

  it('interpolates the percentile (type 7), and sorts before it does', () => {
    // Five finite ranges 1..5, deliberately stored out of order so an
    // unsorted read fails rather than passing by luck.
    //
    // Type 7 (src/terrain/quantile.ts): rank = 0.95 * (5 - 1) = 3.8, so the
    // answer lies four fifths of the way from 4 to 5 = 4.8.
    // Nearest rank (src/validation/checkpointAccuracy.ts): ceil(0.95 * 5) - 1
    // = 4, so it would answer exactly 5. The two conventions disagree here by
    // a fifth of an order-statistic gap, which is the point of this case.
    //
    // The tolerance is tight on purpose. 4.8 is not representable in float32,
    // so narrowing the interpolated result to float32 (4.800000190734863)
    // fails this assertion while a loose toBeCloseTo default would not.
    const frame = frameOf(
      3,
      2,
      [
        CellState.VALID_RETURN,
        CellState.VALID_RETURN,
        CellState.VALID_RETURN,
        CellState.VALID_RETURN,
        CellState.VALID_RETURN,
        CellState.NO_RETURN,
      ],
      [3, 1, 5, 2, 4, Number.NaN],
    );
    const r = summariseRangeFrame(frame).range;
    expect(r?.finiteCount).toBe(5);
    expect(r?.excludedNonFinite).toBe(0);
    expect(r?.cellsWithoutRange).toBe(1);
    expect(r?.min).toBe(1);
    expect(r?.max).toBe(5);
    expect(r?.median).toBe(3);
    expect(r?.p95).toBeCloseTo(4.8, 12);
  });
});

describe('spatial sampling coverage', () => {
  it('shows which band a stride decimated, not merely that one did', () => {
    // 8 columns by 2 rows. The right half is entirely NOT_DECODED, so half of
    // the grid is missing overall — a single "50% decoded" number that is
    // perfectly true and tells a reader nothing about where the hole is.
    //
    // With one band per column the column report is 1,1,1,1,0,0,0,0 and the
    // row report is 0.5,0.5: the same shortfall, one axis uniform and the
    // other total.
    const states: number[] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 8; col++) {
        states.push(col < 4 ? CellState.VALID_RETURN : CellState.NOT_DECODED);
      }
    }
    const c = summariseRangeFrame(frameOf(8, 2, states)).coverage;
    expect(c.columnBands.map((b) => b.decodedFraction)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
    expect(c.columnBands.map((b) => b.cells)).toEqual([2, 2, 2, 2, 2, 2, 2, 2]);
    expect(c.rowBands.map((b) => b.decodedFraction)).toEqual([0.5, 0.5]);
    expect(c.rowBands.map((b) => b.cells)).toEqual([8, 8]);
  });

  it('partitions each axis exactly, with no cell counted twice or dropped', () => {
    // 11 columns does not divide by the band target, so the bands are uneven.
    // The invariant that matters is that they still tile the axis: contiguous,
    // start to end, summing to the width.
    const width = 11;
    const height = 3;
    const c = summariseRangeFrame(
      frameOf(width, height, new Array(width * height).fill(CellState.VALID_RETURN)),
    ).coverage;
    expect(c.columnBands.length).toBe(COVERAGE_BAND_TARGET);
    expect(c.columnBands[0].start).toBe(0);
    expect(c.columnBands[c.columnBands.length - 1].end).toBe(width);
    for (let i = 1; i < c.columnBands.length; i++) {
      expect(c.columnBands[i].start).toBe(c.columnBands[i - 1].end);
    }
    expect(c.columnBands.reduce((n, b) => n + (b.end - b.start), 0)).toBe(width);
    // No empty band. Deriving the edges from a fixed rounded-up width instead
    // of from the position keeps the axis contiguous and still leaves the last
    // bands with nothing in them, which is another 0/0 dressed as a band.
    for (const b of c.columnBands) {
      expect(b.end).toBeGreaterThan(b.start);
      expect(b.cells).toBe((b.end - b.start) * height);
      expect(b.decodedFraction).toBe(1);
    }
    // Fewer rows than bands: one band per row, never an empty band whose
    // decoded fraction would be another 0/0.
    expect(c.rowBands.length).toBe(height);
    for (const b of c.rowBands) expect(b.end - b.start).toBe(1);
  });
});

describe('set summary', () => {
  it('totals validity across frames and keeps each frame addressable by id', () => {
    // Two setups of different sizes: a total that ignored the second frame
    // would still look like a plausible report of the first.
    const a = frameOf(2, 1, [CellState.VALID_RETURN, CellState.NO_RETURN]);
    const b: OrganizedRangeFrame = {
      ...frameOf(2, 1, [CellState.NOT_DECODED, CellState.NOT_DECODED]),
      id: 'setup-2',
      linkage: { kind: 'partial', reason: 'stride' },
    };
    const set: OrganizedRangeSet = {
      kind: 'organized-range',
      frames: [a, b],
      organization: 'multi-grid',
    };
    const s = summariseRangeSet(set);
    expect(s.frames.map((f) => f.id)).toEqual(['setup-1', 'setup-2']);
    expect(s.validity.cells).toBe(4);
    expect(s.validity.byState[CellState.VALID_RETURN]).toEqual({ count: 1, fraction: 0.25 });
    expect(s.validity.byState[CellState.NOT_DECODED]).toEqual({ count: 2, fraction: 0.5 });
    expect(s.linkageKinds).toEqual(['exact', 'partial']);
  });

  it('reports no cells and no fractions for a set with no frames', () => {
    const s = summariseRangeSet({
      kind: 'organized-range',
      frames: [],
      organization: 'organized-grid',
    });
    expect(s.frames).toEqual([]);
    expect(s.validity.cells).toBe(0);
    expect(s.validity.byState[CellState.VALID_RETURN].fraction).toBeNull();
  });
});
