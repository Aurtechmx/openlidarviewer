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
