/**
 * ptxOrganizedRange.test.ts — the acquisition grid PTX carries and OLV used to throw away.
 *
 * The cases here are chosen for the failures that do not announce themselves.
 * A transposed grid, a malformed line reported as a sensor no-return, and a
 * range computed after registration all produce output that looks entirely
 * reasonable and is wrong, so each one is pinned against a fixture where the
 * right answer is known by construction.
 */

import { describe, it, expect } from 'vitest';
import { loadPtx } from '../src/io/loadPtx';
import { CellState, NO_RECORD, cellIndexOf, recordForCell } from '../src/model/OrganizedRange';

const ptx = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

/** Header: cols, rows, scanner position, three axis rows, then the 4x4. */
function header(cols: number, rows: number, tx = 0, ty = 0, tz = 0): string {
  return [
    String(cols), String(rows),
    '0 0 0',
    '1 0 0', '0 1 0', '0 0 1',
    '1 0 0 0', '0 1 0 0', '0 0 1 0',
    `${tx} ${ty} ${tz} 1`,
  ].join('\n');
}

describe('a single scanner setup', () => {
  // 2 columns by 3 rows, filled column by column, which is PTX's own order.
  // Non-square on purpose: a transposed reading cannot hide on a square grid.
  const body = [
    header(2, 3),
    '1 0 0 0.5',   // ordinal 0 -> row 0, column 0
    '0 0 0 0',     // ordinal 1 -> row 1, column 0   no return
    '3 4 0 0.5',   // ordinal 2 -> row 2, column 0   range 5 exactly
    'garbage',     // ordinal 3 -> row 0, column 1   malformed
    'nan 1 1 0.5', // ordinal 4 -> row 1, column 1   non-finite
    '0 0 5 0.5',   // ordinal 5 -> row 2, column 1
  ].join('\n');

  it('produces one frame with the declared grid shape', async () => {
    const pc = await loadPtx(ptx(body));
    expect(pc.organizedRange?.frames).toHaveLength(1);
    expect(pc.organizedRange?.organization).toBe('organized-grid');
    const f = pc.organizedRange!.frames[0];
    expect(f.width).toBe(2);
    expect(f.height).toBe(3);
    expect(f.diagnostics.cells).toBe(6);
  });

  it('places each ordinal at the right cell, reading down the column', async () => {
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    const at = (r: number, c: number) => f.cellState[cellIndexOf(r, c, 2)];
    expect(at(0, 0)).toBe(CellState.VALID_RETURN);
    expect(at(1, 0)).toBe(CellState.NO_RETURN);
    expect(at(2, 0)).toBe(CellState.VALID_RETURN);
    expect(at(0, 1)).toBe(CellState.SOURCE_INVALID);
    expect(at(1, 1)).toBe(CellState.SOURCE_INVALID);
    expect(at(2, 1)).toBe(CellState.VALID_RETURN);
  });

  it('separates a no-return from a malformed record', async () => {
    // Both were one bare `continue` before. They are different claims: one is
    // the instrument reporting nothing came back, the other is the file being
    // broken, and only the first says anything about the scene.
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    expect(f.diagnostics.stateCounts[CellState.NO_RETURN]).toBe(1);
    expect(f.diagnostics.stateCounts[CellState.SOURCE_INVALID]).toBe(2);
  });

  it('computes geometric range in scanner-local coordinates', async () => {
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    // (3, 4, 0) is a 3-4-5 triangle, so the answer is exactly 5 by construction.
    expect(f.geometricRange![cellIndexOf(2, 0, 2)]).toBeCloseTo(5, 6);
    expect(f.geometricRange![cellIndexOf(2, 1, 2)]).toBeCloseTo(5, 6);
    // A cell with no return has no range, and must not read as zero distance.
    expect(Number.isNaN(f.geometricRange![cellIndexOf(1, 0, 2)])).toBe(true);
  });

  it('links a cell to the display record it produced', async () => {
    const pc = await loadPtx(ptx(body));
    const f = pc.organizedRange!.frames[0];
    const r = recordForCell(f, 2, 0);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Records are pushed in file order, and this is the second valid return.
      expect(r.record).toBe(1);
      expect(pc.positions[r.record * 3]).toBeCloseTo(3, 4);
      expect(pc.positions[r.record * 3 + 1]).toBeCloseTo(4, 4);
    }
  });

  it('refuses to link a cell that produced nothing', async () => {
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    expect(f.cellToRecord[cellIndexOf(1, 0, 2)]).toBe(NO_RECORD);
    const r = recordForCell(f, 1, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('No return');
  });
});

describe('geometric range is taken before registration', () => {
  it('does not grow when the setup is translated far from the origin', async () => {
    // The same local point in two files that differ only by registration. A
    // range derived from world coordinates would jump by the translation; a
    // range derived from the source frame cannot move at all.
    const local = ['3 4 0 0.5'];
    const near = await loadPtx(ptx([header(1, 1, 0, 0, 0), ...local].join('\n')));
    const far = await loadPtx(ptx([header(1, 1, 1000, 2000, 3000), ...local].join('\n')));
    const rNear = near.organizedRange!.frames[0].geometricRange![0];
    const rFar = far.organizedRange!.frames[0].geometricRange![0];
    expect(rNear).toBeCloseTo(5, 6);
    expect(rFar).toBeCloseTo(5, 6);
    expect(rFar).toBeCloseTo(rNear, 9);
  });
});

describe('two scanner setups', () => {
  const two = [
    header(1, 1, 10, 0, 0),
    '1 0 0 0.5',
    header(1, 1, 0, 50, 0),
    '0 2 0 0.5',
  ].join('\n');

  it('keeps a frame per block and reports multi-grid', async () => {
    const pc = await loadPtx(ptx(two));
    expect(pc.organizedRange?.frames).toHaveLength(2);
    expect(pc.organizedRange?.organization).toBe('multi-grid');
    expect(pc.organizedRange!.frames.map((f) => f.id)).toEqual(['setup-1', 'setup-2']);
  });

  it('keeps each setup its own pose rather than only the first', async () => {
    // The loader previously kept one scanner origin for the whole file, so the
    // second setup's position was unrecoverable.
    const pc = await loadPtx(ptx(two));
    const [a, b] = pc.organizedRange!.frames;
    expect(a.acquisitionPose?.worldTranslation).toEqual([10, 0, 0]);
    expect(b.acquisitionPose?.worldTranslation).toEqual([0, 50, 0]);
  });

  it('records the declared scanner position separately from the world one', async () => {
    // These are different frames, not two candidates for one value: the header
    // line is scanner-local and reads 0 0 0 here, while the transform row is
    // where that scanner sits once registered.
    const pc = await loadPtx(ptx(two));
    const pose = pc.organizedRange!.frames[0].acquisitionPose!;
    expect(pose.localPosition).toEqual([0, 0, 0]);
    expect(pose.worldTranslation).toEqual([10, 0, 0]);
    expect(pose.localPositionSource).toBe('source-declared');
  });

  it('numbers records across blocks so a later setup still links', async () => {
    const pc = await loadPtx(ptx(two));
    const second = recordForCell(pc.organizedRange!.frames[1], 0, 0);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.record).toBe(1);
  });
});

describe('a truncated block', () => {
  it('marks the unread tail as missing, not as no-return', async () => {
    // The file ends mid-grid. Those cells were never described by the source,
    // which is a different statement from the scanner finding nothing there.
    const pc = await loadPtx(ptx([header(2, 2), '1 0 0 0.5', '0 1 0 0.5'].join('\n')));
    const f = pc.organizedRange!.frames[0];
    expect(f.diagnostics.stateCounts[CellState.SOURCE_RECORD_MISSING]).toBe(2);
    expect(f.diagnostics.stateCounts[CellState.NO_RETURN]).toBe(0);
  });
});

describe('linkage fails closed when records are dropped after the grid is built', () => {
  it('reports identity unavailable rather than shipping shifted indices', async () => {
    // A coordinate that survives the point reader but overflows the transform
    // is removed by sanitation, which compacts survivors and shifts every index
    // after it. Nothing remaps cellToRecord yet, so the only honest answer is
    // that the identity is gone. The grid itself stays true.
    const body = [
      header(1, 3),
      '1 0 0 0.5',
      '1e308 1e308 1e308 0.5',
      '0 0 5 0.5',
    ].join('\n');
    const pc = await loadPtx(ptx(body));
    const f = pc.organizedRange!.frames[0];
    if (f.linkage.kind === 'unavailable') {
      expect(f.linkage.reason).toBe('source-record-identity-unavailable');
      expect(f.cellToRecord[0]).toBe(NO_RECORD);
      // The topology survives the loss of linkage. That separation is the point.
      expect(f.diagnostics.stateCounts[CellState.VALID_RETURN]).toBeGreaterThan(0);
      expect(f.geometricRange![0]).toBeCloseTo(1, 6);
    } else {
      // Sanitation kept everything, so exact linkage is correct and must hold.
      expect(f.linkage.kind).toBe('exact');
      expect(recordForCell(f, 0, 0).ok).toBe(true);
    }
  });
});
