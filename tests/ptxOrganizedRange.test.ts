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

describe('a range that overflows float32', () => {
  it('reports a non-finite range rather than a number that reads as a distance', async () => {
    // hypot of 1e308 saturates to Infinity in a Float32Array. The earlier
    // assertion here only checked the value was not NaN, which Infinity
    // satisfies, so it would have held even if every overflowing range were
    // garbage. A range must be finite to be a range.
    const body = [header(1, 1), '1e308 0 0 0.5'].join('\n');
    const pc = await loadPtx(ptx(body));
    const f = pc.organizedRange?.frames[0];
    if (f) {
      const r = f.geometricRange![0];
      // Either the cell carries a real distance, or it carries none. What it
      // must never do is carry Infinity, which reads as a measurement.
      expect(r).not.toBe(Number.POSITIVE_INFINITY);
      expect(Number.isFinite(r) || Number.isNaN(r)).toBe(true);
    }
  });
});

describe('linkage survives a record dropped in the middle of the grid', () => {
  // The translation is what makes this a real overflow. The point reader only
  // sees the scanner-local token, which is finite here; the world coordinate is
  // finite + finite = Infinity, so sanitation removes the SECOND of four
  // records and every index after it shifts down by one.
  const body = [
    header(1, 4, 1e308, 0, 0),
    '1 0 0 0.5',      // ordinal 0 -> record 0
    '1e308 0 0 0.5',  // ordinal 1 -> record 1, overflows the transform
    '0 0 5 0.5',      // ordinal 2 -> record 2, becomes record 1
    '0 0 9 0.5',      // ordinal 3 -> record 3, becomes record 2
  ].join('\n');

  it('drops exactly the overflowing record', async () => {
    const pc = await loadPtx(ptx(body));
    expect(pc.pointCount).toBe(3);
  });

  it('keeps exact linkage rather than degrading the whole set', async () => {
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    expect(f.linkage.kind).toBe('exact');
  });

  it('resolves a cell after the casualty to the right point, by coordinate', async () => {
    // The index alone cannot catch an off-by-one: 1 and 2 are both plausible
    // answers here. The z coordinate at the resolved record can only match one.
    const pc = await loadPtx(ptx(body));
    const f = pc.organizedRange!.frames[0];
    const third = recordForCell(f, 2, 0);
    expect(third.ok).toBe(true);
    if (third.ok) expect(pc.positions[third.record * 3 + 2]).toBeCloseTo(5, 4);
    const fourth = recordForCell(f, 3, 0);
    expect(fourth.ok).toBe(true);
    if (fourth.ok) expect(pc.positions[fourth.record * 3 + 2]).toBeCloseTo(9, 4);
    const first = recordForCell(f, 0, 0);
    expect(first.ok).toBe(true);
    if (first.ok) expect(pc.positions[first.record * 3 + 2]).toBeCloseTo(0, 4);
  });

  it('says the dropped cell was not decoded, not that nothing came back', async () => {
    // The scanner did get a return here. The pipeline is what discarded it, and
    // calling that a no-return would report a decoding limit as a measurement.
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    const ci = cellIndexOf(1, 0, 1);
    expect(f.cellState[ci]).toBe(CellState.NOT_DECODED);
    expect(f.cellToRecord[ci]).toBe(NO_RECORD);
    expect(recordForCell(f, 1, 0).ok).toBe(false);
    expect(f.diagnostics.stateCounts[CellState.NOT_DECODED]).toBe(1);
    expect(f.diagnostics.stateCounts[CellState.NO_RETURN]).toBe(0);
    expect(f.diagnostics.stateCounts[CellState.VALID_RETURN]).toBe(3);
  });

  it('records an unrepresentable range as absent, never as Infinity', async () => {
    // Float32 cannot hold a range of 1e308. Saturating to Infinity would put a
    // value that reads as a distance into the field; NaN is the field's own
    // "nothing recorded here", which is what is actually true.
    const f = (await loadPtx(ptx(body))).organizedRange!.frames[0];
    const r = f.geometricRange![cellIndexOf(1, 0, 1)];
    expect(r).not.toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(r)).toBe(true);
  });
});

describe('a grid the file cannot supply', () => {
  it('records no acquisition grid rather than allocating from the claim', async () => {
    // An 87-byte file declaring 100000 x 1000 asked for 900 MB of sidecar
    // before a single point line was read, because nothing checked the claim
    // against the file. The points still load; the grid does not, because a
    // declaration the records contradict is not evidence.
    const body = [header(100000, 1000), '1 2 3 0.5', '4 5 6 0.5'].join('\n');
    const pc = await loadPtx(ptx(body));
    expect(pc.pointCount).toBe(2);
    expect(pc.organizedRange).toBeUndefined();
    expect(pc.metadata?.loadWarnings?.join(' ')).toContain('cannot supply');
  });

  it('still keeps the grid for an ordinary truncated block', async () => {
    // The bound must not punish an honest file that simply ran out mid-grid,
    // which is the case the SOURCE_RECORD_MISSING tail exists for.
    const pc = await loadPtx(ptx([header(2, 2), '1 0 0 0.5', '0 1 0 0.5'].join('\n')));
    expect(pc.organizedRange?.frames).toHaveLength(1);
    expect(pc.organizedRange!.frames[0].diagnostics.stateCounts[CellState.SOURCE_RECORD_MISSING]).toBe(2);
  });
});
