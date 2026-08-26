/**
 * organizedRange.test.ts — the topology model's invariants.
 *
 * Two of these cases exist because the failure they catch is invisible: a
 * transposed grid mapping and a resurrected record index both produce output
 * that looks entirely plausible and is wrong. The rest pin the rule that a cell
 * which cannot prove its record says so rather than returning a nearby one.
 */

import { describe, it, expect } from 'vitest';
import {
  CellState,
  CELL_STATES,
  NO_RECORD,
  cellIndexOf,
  ptxCellFromOrdinal,
  tallyCellStates,
  recordForCell,
  withLinkageUnavailable,
  buildCellReturns,
  cellIndexForRecord,
  returnsForCell,
  aggregateCellState,
  RETURN_VALUE_MAX,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from '../src/model/OrganizedRange';

/** A 3 wide by 2 high frame: deliberately non-square so a transposition shows. */
function frameFixture(over: Partial<OrganizedRangeFrame> = {}): OrganizedRangeFrame {
  const width = 3;
  const height = 2;
  const cellState = new Uint8Array(width * height).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(width * height);
  for (let i = 0; i < cellToRecord.length; i++) cellToRecord[i] = i;
  return {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
    ...over,
  };
}

describe('grid addressing', () => {
  it('stores row-major, so a row step moves by the width', () => {
    expect(cellIndexOf(0, 0, 3)).toBe(0);
    expect(cellIndexOf(0, 2, 3)).toBe(2);
    expect(cellIndexOf(1, 0, 3)).toBe(3);
  });

  it('reads a PTX ordinal down the column, with the row as the fast axis', () => {
    // PTX writes every row of column 0 before starting column 1. On a grid of
    // 4 rows, ordinal 4 is therefore the TOP of column 1, not the second row of
    // column 0. A transposed reading returns row 1 column 0 here and passes
    // every square-grid test ever written, which is why this one is 3 by 4.
    expect(ptxCellFromOrdinal(0, 4)).toEqual({ row: 0, column: 0 });
    expect(ptxCellFromOrdinal(3, 4)).toEqual({ row: 3, column: 0 });
    expect(ptxCellFromOrdinal(4, 4)).toEqual({ row: 0, column: 1 });
    expect(ptxCellFromOrdinal(11, 4)).toEqual({ row: 3, column: 2 });
  });
});

describe('cell state tallies', () => {
  it('counts every state and reports the cell total', () => {
    const s = new Uint8Array([
      CellState.VALID_RETURN,
      CellState.VALID_RETURN,
      CellState.NO_RETURN,
      CellState.SOURCE_INVALID,
      CellState.NOT_DECODED,
      CellState.SOURCE_RECORD_MISSING,
    ]);
    const d = tallyCellStates(s);
    expect(d.cells).toBe(6);
    expect(d.stateCounts[CellState.VALID_RETURN]).toBe(2);
    expect(d.stateCounts[CellState.NO_RETURN]).toBe(1);
    expect(d.stateCounts[CellState.SOURCE_RECORD_MISSING]).toBe(1);
    // The tally must be complete: nothing may fall outside the known states.
    const summed = CELL_STATES.reduce((n: number, k) => n + d.stateCounts[k], 0);
    expect(summed).toBe(d.cells);
  });
});

describe('resolving a cell to its display record', () => {
  it('returns the recorded index for a valid cell', () => {
    const r = recordForCell(frameFixture(), 1, 2);
    expect(r).toEqual({ ok: true, record: cellIndexOf(1, 2, 3) });
  });

  it('refuses a cell outside the grid rather than clamping', () => {
    const r = recordForCell(frameFixture(), 5, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('outside');
  });

  it('names the state when a cell holds no return', () => {
    const f = frameFixture();
    f.cellState[cellIndexOf(0, 1, 3)] = CellState.NO_RETURN;
    const r = recordForCell(f, 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('No return');
  });

  it('refuses when linkage is unavailable, whatever the array still holds', () => {
    // The guard is on linkage, not on the array contents, so a frame whose
    // indices were never cleared still refuses. Belt and braces: the degrade
    // helper clears them too.
    const f = frameFixture({ linkage: { kind: 'unavailable', reason: 'voxel-centroids' } });
    const r = recordForCell(f, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('voxel-centroids');
  });

  it('still resolves under partial linkage, because the decoded records are exact', () => {
    const f = frameFixture({ linkage: { kind: 'partial', reason: 'stride' } });
    expect(recordForCell(f, 0, 0)).toEqual({ ok: true, record: 0 });
  });
});

describe('degrading linkage', () => {
  const set: OrganizedRangeSet = {
    kind: 'organized-range',
    frames: [frameFixture()],
    organization: 'organized-grid',
  };

  it('erases the record indices rather than leaving them readable', () => {
    // A caller that reads cellToRecord directly must not be able to resurrect a
    // stale index that now points at a centroid.
    const out = withLinkageUnavailable(set, 'voxel-centroids');
    expect([...out.frames[0].cellToRecord]).toEqual(new Array(6).fill(NO_RECORD));
    expect(out.frames[0].linkage).toEqual({ kind: 'unavailable', reason: 'voxel-centroids' });
  });

  it('keeps the topology, which is the whole reason the two are separable', () => {
    const out = withLinkageUnavailable(set, 'voxel-centroids');
    expect(out.frames[0].width).toBe(3);
    expect(out.frames[0].diagnostics.cells).toBe(6);
    expect(out.frames[0].cellState).toEqual(set.frames[0].cellState);
  });

  it('does not mutate the input set', () => {
    withLinkageUnavailable(set, 'voxel-centroids');
    expect(set.frames[0].linkage).toEqual({ kind: 'exact' });
    expect(set.frames[0].cellToRecord[3]).toBe(3);
  });
});

describe('worker transferables', () => {
  it('finds every typed array in every frame, without naming one', async () => {
    const { organizedRangeTransferables } = await import('../src/model/OrganizedRange');
    const set: OrganizedRangeSet = {
      kind: 'organized-range',
      frames: [
        { ...frameFixture(), geometricRange: new Float32Array(6) },
        { ...frameFixture(), id: 'setup-2' },
      ],
      organization: 'multi-grid',
    };
    // Frame one has cellState, cellToRecord and geometricRange; frame two has
    // the first two. Counting rather than listing is the point: the helper
    // reads the frame's own values, so an array added later is carried without
    // anyone remembering to update a list.
    expect(organizedRangeTransferables(set)).toHaveLength(5);
  });

  it('picks up an array the type did not have when the helper was written', async () => {
    const { organizedRangeTransferables } = await import('../src/model/OrganizedRange');
    const withExtra = { ...frameFixture(), somethingNew: new Uint16Array(3) };
    const set = {
      kind: 'organized-range',
      frames: [withExtra],
      organization: 'organized-grid',
    } as unknown as OrganizedRangeSet;
    // This is the regression the hand-written list could not have caught: the
    // new array crosses by transfer rather than by a silent clone.
    expect(organizedRangeTransferables(set)).toHaveLength(3);
  });
});

/**
 * Multiple returns per cell.
 *
 * E57 lets one (row, column) carry several returns of the same pulse. The
 * fixtures below are built so that the two classic prefix-sum defects cannot
 * hide: the LAST cell of the grid is populated (an offsets array one entry
 * short, or a sum shifted by one, resolves it wrongly or throws), and the
 * returns of one cell arrive out of `returnIndex` order.
 */
describe('multiple returns per cell', () => {
  /**
   * A 3 by 2 grid. Cell (0,0) holds one return, cell (0,1) holds none, cell
   * (1,2) — the LAST cell — holds three, and they are supplied 2, 0, 1 so a
   * build that trusts arrival order is visible.
   */
  function multiReturnFixture(): OrganizedRangeFrame {
    const width = 3;
    const height = 2;
    const cellState = new Uint8Array(width * height).fill(CellState.NO_RETURN);
    cellState[cellIndexOf(0, 0, width)] = CellState.VALID_RETURN;
    cellState[cellIndexOf(1, 2, width)] = CellState.VALID_RETURN;
    const built = buildCellReturns(width, height, [
      { row: 0, column: 0, record: 10, returnIndex: 0, returnCount: 1, sourceRange: null },
      { row: 1, column: 2, record: 22, returnIndex: 2, returnCount: 3, sourceRange: null },
      { row: 1, column: 2, record: 20, returnIndex: 0, returnCount: 3, sourceRange: null },
      { row: 1, column: 2, record: 21, returnIndex: 1, returnCount: 3, sourceRange: null },
    ]);
    return {
      id: 'setup-e57',
      sourceKind: 'e57-structured',
      width,
      height,
      cellState,
      cellToRecord: new Int32Array(width * height).fill(NO_RECORD),
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
      returnCellStart: built.returnCellStart,
      returnRecord: built.returnRecord,
      returnIndex: built.returnIndex,
      returnCountDeclared: built.returnCountDeclared,
      returnsSkipped: built.skippedCount,
    };
  }

  it('describes a cell that produced exactly one return', () => {
    const r = returnsForCell(multiReturnFixture(), 0, 0);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returns).toEqual([{ record: 10, returnIndex: 0, returnCount: 1, sourceRange: null }]);
  });

  it('reports zero returns as an empty list, not as a missing description', () => {
    // A described cell that got nothing back is evidence about the scene. It
    // must not read the same as a frame that never described its returns.
    const r = returnsForCell(multiReturnFixture(), 0, 1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.returns).toEqual([]);
  });

  it('separates "no returns" from "this frame never described returns"', () => {
    const single = frameFixture();
    const r = returnsForCell(single, 0, 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not-described');
  });

  it('resolves the three returns of the LAST cell in the grid', () => {
    // The off-by-one case. Reading only a middle cell passes with a prefix sum
    // shifted by one and with a missing terminator entry alike.
    const r = returnsForCell(multiReturnFixture(), 1, 2);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.returns).toEqual([
        { record: 20, returnIndex: 0, returnCount: 3, sourceRange: null },
        { record: 21, returnIndex: 1, returnCount: 3, sourceRange: null },
        { record: 22, returnIndex: 2, returnCount: 3, sourceRange: null },
      ]);
    }
  });

  it('carries the CSR terminator, so the last cell has an end offset', () => {
    const f = multiReturnFixture();
    expect(f.returnCellStart).toBeDefined();
    expect(f.returnCellStart!.length).toBe(f.width * f.height + 1);
    expect(f.returnCellStart![f.width * f.height]).toBe(4);
    // The first cell starts at zero: the prefix sum is exclusive, and a sum
    // shifted by one puts a non-zero value here.
    expect(f.returnCellStart![0]).toBe(0);
    expect(f.returnCellStart![1]).toBe(1);
  });

  it('orders each cell by returnIndex and moves the payload with it', () => {
    // Returns arrived 2, 0, 1. The sort is ascending by returnIndex, and the
    // record must travel with its own index rather than staying put.
    const f = multiReturnFixture();
    const start = f.returnCellStart![cellIndexOf(1, 2, 3)];
    expect([...f.returnIndex!.slice(start, start + 3)]).toEqual([0, 1, 2]);
    expect([...f.returnRecord!.slice(start, start + 3)]).toEqual([20, 21, 22]);
  });

  it('counts returns that fell outside the grid rather than placing them', () => {
    const built = buildCellReturns(3, 2, [
      { row: 0, column: 0, record: 1, returnIndex: 0, returnCount: 1, sourceRange: null },
      { row: 9, column: 0, record: 2, returnIndex: 0, returnCount: 1, sourceRange: null },
      { row: 0, column: -1, record: 3, returnIndex: 0, returnCount: 1, sourceRange: null },
    ]);
    expect(built.skippedCount).toBe(2);
    expect(built.returnRecord.length).toBe(1);
    expect(built.returnCellStart[6]).toBe(1);
  });

  it('refuses every cell when linkage is unavailable', () => {
    const f: OrganizedRangeFrame = {
      ...multiReturnFixture(),
      linkage: { kind: 'unavailable', reason: 'voxel-centroids' },
    };
    const r = returnsForCell(f, 1, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('linkage-unavailable');
  });

  it('erases the per-return record indices on degrade, keeping the topology', () => {
    // Same defect as cellToRecord: a stale index surviving a voxel reduction
    // would claim a centroid IS a source return.
    const set: OrganizedRangeSet = {
      kind: 'organized-range',
      frames: [multiReturnFixture()],
      organization: 'organized-grid',
    };
    const out = withLinkageUnavailable(set, 'voxel-centroids');
    expect([...out.frames[0].returnRecord!]).toEqual(new Array(4).fill(NO_RECORD));
    // The grid of what was interrogated survives; only identity is spent.
    expect([...out.frames[0].returnCellStart!]).toEqual([...set.frames[0].returnCellStart!]);
    expect([...out.frames[0].returnIndex!]).toEqual([...set.frames[0].returnIndex!]);
    expect(set.frames[0].returnRecord![0]).toBe(10);
  });

  it('leaves a single-return frame alone on degrade', () => {
    const set: OrganizedRangeSet = {
      kind: 'organized-range',
      frames: [frameFixture()],
      organization: 'organized-grid',
    };
    const out = withLinkageUnavailable(set, 'voxel-centroids');
    expect(out.frames[0].returnRecord).toBeUndefined();
  });

  it('transfers the new arrays instead of cloning them', async () => {
    const { organizedRangeTransferables } = await import('../src/model/OrganizedRange');
    const set: OrganizedRangeSet = {
      kind: 'organized-range',
      frames: [multiReturnFixture()],
      organization: 'organized-grid',
    };
    // cellState, cellToRecord, returnCellStart, returnRecord, returnIndex,
    // returnCountDeclared. Counted, not listed, for the same reason as above.
    expect(organizedRangeTransferables(set)).toHaveLength(6);
  });
});

describe('return column values the source declared', () => {
  /** Every boundary of a 16-bit store, and four values that clear it. */
  const BOUNDARIES = [0, 1, 65534, 65535, 65536, 70000, 4294967294];

  it('stores a declared returnIndex above 65535 as the source declared it', () => {
    // A `Uint16Array` took each of these modulo 65536 in silence: 65536 became
    // 0, 70000 became 4464, and 4294967294 became 65534. Nothing in the frame
    // could tell the wrapped value from a measured one afterwards.
    const built = buildCellReturns(
      BOUNDARIES.length,
      1,
      BOUNDARIES.map((v, k) => ({
        row: 0,
        column: k,
        record: k,
        returnIndex: v,
        returnCount: v,
        sourceRange: null,
      })),
    );
    expect([...built.returnIndex]).toEqual(BOUNDARIES);
    expect([...built.returnCountDeclared!]).toEqual(BOUNDARIES);
  });

  it('keeps the sort honest for indices that a 16-bit store would reorder', () => {
    // 65536 wraps to 0 and 70000 wraps to 4464, so a narrowed build sorted this
    // cell as 0, 4464, 65535 and handed back the records in the wrong order.
    const built = buildCellReturns(1, 1, [
      { row: 0, column: 0, record: 7, returnIndex: 70000, returnCount: 3, sourceRange: null },
      { row: 0, column: 0, record: 8, returnIndex: 65535, returnCount: 3, sourceRange: null },
      { row: 0, column: 0, record: 9, returnIndex: 65536, returnCount: 3, sourceRange: null },
    ]);
    expect([...built.returnIndex]).toEqual([65535, 65536, 70000]);
    expect([...built.returnRecord]).toEqual([8, 9, 7]);
  });

  it('orders a returnIndex tie by record, so arrival order cannot decide it', () => {
    // Two returns declaring the same index used to keep the order the caller
    // supplied, so the same records read at a different stride produced a
    // different frame. The pair (returnIndex, record) is a total order and does
    // not have that freedom.
    const entries = [
      { row: 0, column: 0, record: 42, returnIndex: 1, returnCount: 2, sourceRange: null },
      { row: 0, column: 0, record: 17, returnIndex: 1, returnCount: 2, sourceRange: null },
    ];
    const forward = buildCellReturns(1, 1, entries);
    const backward = buildCellReturns(1, 1, [...entries].reverse());
    expect([...forward.returnRecord]).toEqual([17, 42]);
    expect([...backward.returnRecord]).toEqual([...forward.returnRecord]);
  });

  it('refuses a value no return column can hold rather than wrapping it', () => {
    // Widening covers everything the E57 sink can hand over, which is `u32`.
    // Past that there is no honest store, so the build stops and says so.
    expect(() =>
      buildCellReturns(1, 1, [
        {
          row: 0,
          column: 0,
          record: 0,
          returnIndex: RETURN_VALUE_MAX + 1,
          returnCount: 1,
          sourceRange: null,
        },
      ]),
    ).toThrow(/returnIndex 4294967296 at entry 0 is outside 0\.\.4294967295/);
  });
});

describe('reversing a record back to its cell', () => {
  /** One cell holding two returns, the case a single primary cannot describe. */
  function twoReturnFrame(): OrganizedRangeFrame {
    const width = 3;
    const height = 2;
    const cellState = new Uint8Array(width * height).fill(CellState.NO_RETURN);
    cellState[cellIndexOf(1, 2, width)] = CellState.VALID_RETURN;
    const built = buildCellReturns(width, height, [
      { row: 1, column: 2, record: 100, returnIndex: 0, returnCount: 2, sourceRange: 12.5 },
      { row: 1, column: 2, record: 101, returnIndex: 1, returnCount: 2, sourceRange: 30.25 },
    ]);
    const cellToRecord = new Int32Array(width * height).fill(NO_RECORD);
    cellToRecord[cellIndexOf(1, 2, width)] = 100;
    return {
      id: 'setup-two',
      sourceKind: 'e57-structured',
      width,
      height,
      cellState,
      cellToRecord,
      linkage: { kind: 'exact' },
      diagnostics: tallyCellStates(cellState),
      returnCellStart: built.returnCellStart,
      returnRecord: built.returnRecord,
      returnIndex: built.returnIndex,
      returnCountDeclared: built.returnCountDeclared,
      returnSourceRange: built.returnSourceRange,
      returnsSkipped: built.skippedCount,
    };
  }

  it('reverses EVERY record the cell lists, not only the primary', () => {
    // The forward and reverse directions must agree about which records exist.
    // Searching `cellToRecord` alone answered null for record 101 while
    // `returnsForCell` listed it, so the second return of a pulse was reachable
    // in one direction only.
    const frame = twoReturnFrame();
    const cell = cellIndexOf(1, 2, frame.width);
    const listed = returnsForCell(frame, 1, 2);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.why);
    expect(listed.returns.map((r) => r.record)).toEqual([100, 101]);
    for (const r of listed.returns) {
      expect(cellIndexForRecord(frame, r.record)).toBe(cell);
    }
  });

  it('still answers null for a record the frame never produced', () => {
    expect(cellIndexForRecord(twoReturnFrame(), 9999)).toBeNull();
  });

  it('answers null for every record once linkage is unavailable', () => {
    const set: OrganizedRangeSet = {
      kind: 'organized-range',
      frames: [twoReturnFrame()],
      organization: 'organized-grid',
    };
    const gone = withLinkageUnavailable(set, 'voxel-centroids').frames[0];
    expect(cellIndexForRecord(gone, 101)).toBeNull();
  });

  it('keeps both distances of a two-return pulse', () => {
    // 12.5 m and 30.25 m are two measurements, and one cell-level number
    // described whichever the traversal reached last.
    const listed = returnsForCell(twoReturnFrame(), 1, 2);
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error(listed.why);
    expect(listed.returns.map((r) => r.sourceRange)).toEqual([12.5, 30.25]);
  });
});

describe('aggregating what several records say about one cell', () => {
  it('gives the same state for either order of a valid and an invalid record', () => {
    const forward = aggregateCellState(
      aggregateCellState(CellState.SOURCE_RECORD_MISSING, CellState.VALID_RETURN),
      CellState.SOURCE_INVALID,
    );
    const backward = aggregateCellState(
      aggregateCellState(CellState.SOURCE_RECORD_MISSING, CellState.SOURCE_INVALID),
      CellState.VALID_RETURN,
    );
    expect(forward).toBe(CellState.VALID_RETURN);
    expect(backward).toBe(CellState.VALID_RETURN);
  });

  it('keeps SOURCE_INVALID when no record of the cell was usable', () => {
    expect(
      aggregateCellState(CellState.SOURCE_RECORD_MISSING, CellState.SOURCE_INVALID),
    ).toBe(CellState.SOURCE_INVALID);
  });
});

describe('a source that declared no return count', () => {
  it('is distinguishable from a source that declared zero', () => {
    const silent = buildCellReturns(1, 1, [
      { row: 0, column: 0, record: 0, returnIndex: 0, returnCount: null, sourceRange: null },
    ]);
    const declaredZero = buildCellReturns(1, 1, [
      { row: 0, column: 0, record: 0, returnIndex: 0, returnCount: 0, sourceRange: null },
    ]);
    // Absence is the missing array, never a zero written into one whose name
    // asserts the source declared it.
    expect(silent.returnCountDeclared).toBeUndefined();
    expect(declaredZero.returnCountDeclared).toBeDefined();
    expect([...declaredZero.returnCountDeclared!]).toEqual([0]);
  });
});
