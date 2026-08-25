/**
 * organizedRangeCellLink.test.ts — the refusal is the feature.
 *
 * The 2D to 3D link's whole value is that it either names the display record
 * the loader decoded a cell from, or says why it cannot. A version that quietly
 * answered with the nearest point would pass any test that only checked "the
 * user gets an answer", so these assertions check the SHAPE of the answer: a
 * refusal must carry no record field at all, in every linkage state.
 */

import { describe, it, expect } from 'vitest';
import {
  CellState,
  type OrganizedRangeFrame,
  type RangeLinkage,
  cellIndexOf,
  tallyCellStates,
} from '../src/model/OrganizedRange';
import {
  linkageText,
  resolveCellLink,
  unavailableReasonText,
} from '../src/diagnostics/rangeCellLink';

/** 4 columns by 2 rows: non-square, so a transposed read cannot hide. */
function frame(linkage: RangeLinkage): OrganizedRangeFrame {
  const width = 4;
  const height = 2;
  const cellState = new Uint8Array(width * height).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(width * height);
  for (let i = 0; i < cellToRecord.length; i++) cellToRecord[i] = i + 50;
  // Row 1, column 0 got nothing back; row 0, column 3 was never decoded.
  cellState[cellIndexOf(1, 0, width)] = CellState.NO_RETURN;
  cellToRecord[cellIndexOf(1, 0, width)] = -1;
  cellState[cellIndexOf(0, 3, width)] = CellState.NOT_DECODED;
  cellToRecord[cellIndexOf(0, 3, width)] = -1;
  return {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    linkage,
    diagnostics: tallyCellStates(cellState),
  };
}

const EXACT: RangeLinkage = { kind: 'exact' };
const PARTIAL: RangeLinkage = { kind: 'partial', reason: 'stride' };
const GONE: RangeLinkage = { kind: 'unavailable', reason: 'voxel-centroids' };

describe('exact linkage', () => {
  it('names the record the loader decoded the cell from', () => {
    const r = resolveCellLink(frame(EXACT), 1, 3);
    expect(r.kind).toBe('linked');
    // Row 1, column 3 is cell index 7, so record 57 — fixed by construction.
    expect(r.kind === 'linked' && r.record).toBe(57);
    expect(r.headline).toContain('Row 1, column 3');
  });

  it('refuses a cell that produced nothing, and names the state', () => {
    const r = resolveCellLink(frame(EXACT), 1, 0);
    expect(r.kind).toBe('refused');
    expect(r).not.toHaveProperty('record');
    expect(r.headline).toContain('No return');
  });

  it('refuses a cell outside the acquisition grid', () => {
    const r = resolveCellLink(frame(EXACT), 5, 0);
    expect(r.kind).toBe('refused');
    expect(r).not.toHaveProperty('record');
    expect(r.headline).toContain('Outside the acquisition grid');
  });
});

describe('partial source coverage', () => {
  it('still links a decoded cell exactly, and says the coverage is partial', () => {
    const r = resolveCellLink(frame(PARTIAL), 0, 0);
    expect(r.kind).toBe('linked');
    expect(r.kind === 'linked' && r.record).toBe(50);
    expect(r.detail).toContain('partial source coverage');
  });

  it('refuses an undecoded cell and says the return was not decoded', () => {
    const r = resolveCellLink(frame(PARTIAL), 0, 3);
    expect(r.kind).toBe('refused');
    expect(r).not.toHaveProperty('record');
    expect(r.headline).toContain('Not decoded');
    expect(r.detail).toContain('partial source coverage');
  });
});

describe('linkage unavailable', () => {
  it('refuses EVERY cell, including one whose stored index still looks valid', () => {
    // The frame here deliberately still carries a plausible index at row 0,
    // column 0. A resolver that read `cellToRecord` directly, or that fell back
    // to whatever point was closest, would answer 50. It must not.
    const r = resolveCellLink(frame(GONE), 0, 0);
    expect(r.kind).toBe('refused');
    expect(r).not.toHaveProperty('record');
    expect(r.headline).toContain('identity is gone');
    expect(r.detail).toContain('voxel centroids');
    expect(r.detail).toContain('No point in the displayed cloud is offered in its place');
  });

  it('names each unavailable reason in the register’s own vocabulary', () => {
    expect(unavailableReasonText('voxel-centroids')).toContain('voxel centroids');
    expect(unavailableReasonText('invalid-source-topology')).toContain('acquisition grid');
    expect(unavailableReasonText('source-record-identity-unavailable')).toContain(
      'source record identity',
    );
  });
});

describe('the vocabulary the claim register approved', () => {
  const everything = [
    linkageText(EXACT),
    linkageText(PARTIAL),
    linkageText(GONE),
    ...[EXACT, PARTIAL, GONE].flatMap((l) =>
      [
        [0, 0],
        [1, 0],
        [0, 3],
        [5, 0],
      ].flatMap(([row, column]) => {
        const r = resolveCellLink(frame(l), row, column);
        return [r.headline, r.detail];
      }),
    ),
  ].join(' | ');

  // ORG-TOPOLOGY-IDENTITY and ORG-RANGE-GEOMETRIC both prohibit these outright.
  it.each(['measured range', 'sensor accuracy', 'confidence', 'Flash LiDAR'])(
    'never writes %s',
    (word) => {
      expect(everything.toLowerCase()).not.toContain(word.toLowerCase());
    },
  );

  it('uses the approved words for the states it does describe', () => {
    expect(linkageText(EXACT)).toBe('Exact linkage');
    expect(linkageText(PARTIAL)).toBe('Partial source coverage');
    expect(linkageText(GONE)).toContain('Exact linkage unavailable');
  });
});
