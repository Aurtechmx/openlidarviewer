/**
 * pcdOrganizedRange.test.ts — the acquisition grid an organized PCD declares.
 *
 * PCD states its organization in the header (WIDTH columns by HEIGHT rows) but
 * says nothing per record, so every claim here has to be checked against the
 * records the file actually supplies. The cases are picked for the failures
 * that render as something reasonable: a transposed grid, a header that
 * declares more cells than the body holds, and a cell linked to the wrong
 * record. Resolution is asserted by reading the coordinates at the resolved
 * index, never by comparing the index to a number.
 */

import { describe, it, expect } from 'vitest';
import { loadPcd } from '../src/io/loadPcd';
import { CellState, NO_RECORD, cellIndexOf, recordForCell } from '../src/model/OrganizedRange';

interface HeaderOptions {
  readonly width: number;
  readonly height: number;
  readonly points?: number;
  readonly viewpoint?: string | null;
}

/** An ascii PCD with x y z fields. `viewpoint: null` omits the line entirely. */
function asciiPcd(options: HeaderOptions, rows: readonly string[]): ArrayBuffer {
  const { width, height, points = width * height, viewpoint = '0 0 0 1 0 0 0' } = options;
  const lines = [
    '# .PCD v0.7',
    'VERSION 0.7',
    'FIELDS x y z',
    'SIZE 8 8 8',
    'TYPE F F F',
    'COUNT 1 1 1',
    `WIDTH ${width}`,
    `HEIGHT ${height}`,
    ...(viewpoint === null ? [] : [`VIEWPOINT ${viewpoint}`]),
    `POINTS ${points}`,
    'DATA ascii',
    ...rows,
    '',
  ];
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
}

/**
 * A 4-column by 3-row grid whose coordinates encode their own address:
 * x is the column, y is the row. Non-square on purpose — a transposed read
 * cannot hide on a square grid — and the coordinates make an off-by-one in
 * the record link visible rather than merely a different number.
 */
const GRID_ROWS: string[] = [];
for (let row = 0; row < 3; row++) {
  for (let column = 0; column < 4; column++) {
    GRID_ROWS.push(`${column} ${row} 0`);
  }
}

/** World coordinate of a display record, undoing the recentring origin. */
function worldXY(
  pc: { positions: Float32Array; origin: readonly number[] },
  record: number,
): [number, number] {
  return [pc.positions[record * 3] + pc.origin[0], pc.positions[record * 3 + 1] + pc.origin[1]];
}

describe('an organized ascii PCD', () => {
  const buffer = (): ArrayBuffer => asciiPcd({ width: 4, height: 3 }, GRID_ROWS);

  it('records one frame with the declared grid shape', async () => {
    const pc = await loadPcd(buffer());
    expect(pc.organizedRange?.organization).toBe('organized-grid');
    expect(pc.organizedRange?.frames).toHaveLength(1);
    const f = pc.organizedRange!.frames[0];
    expect(f.sourceKind).toBe('pcd-organized');
    expect(f.width).toBe(4);
    expect(f.height).toBe(3);
    expect(f.diagnostics.cells).toBe(12);
    expect(f.diagnostics.stateCounts[CellState.VALID_RETURN]).toBe(12);
  });

  it('reads the record stream row-major, across a non-square grid', async () => {
    const pc = await loadPcd(buffer());
    const f = pc.organizedRange!.frames[0];
    expect(f.linkage.kind).toBe('exact');
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 4; column++) {
        const r = recordForCell(f, row, column);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        // The coordinates carry the address, so a transposition or an
        // off-by-one resolves to a record that disagrees with the cell.
        expect(worldXY(pc, r.record)).toEqual([column, row]);
      }
    }
  });

  it('refuses a cell outside the grid', async () => {
    const f = (await loadPcd(buffer())).organizedRange!.frames[0];
    const r = recordForCell(f, 3, 0);
    expect(r.ok).toBe(false);
  });
});

describe('organization is a claim the records have to back', () => {
  it('records no grid for an unorganized file', async () => {
    const pc = await loadPcd(asciiPcd({ width: 3, height: 1 }, ['0 0 0', '1 0 0', '2 0 0']));
    expect(pc.organizedRange).toBeUndefined();
  });

  it('refuses a grid the decoded records cannot fill, and says so', async () => {
    // WIDTH x HEIGHT claims twelve cells; the body holds six records.
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3 }, GRID_ROWS.slice(0, 6)));
    expect(pc.organizedRange).toBeUndefined();
    const warnings = pc.metadata?.loadWarnings ?? [];
    expect(warnings.some((w) => w.includes('4') && w.includes('3') && w.includes('6'))).toBe(true);
  });

  it('refuses a grid whose cell count is not a safe integer', async () => {
    // 2e9 x 2e9 cells is 4e18: past Number.MAX_SAFE_INTEGER, and nine bytes a
    // cell past anything allocatable. The read still has to succeed.
    const pc = await loadPcd(
      asciiPcd({ width: 2_000_000_000, height: 2_000_000_000, points: 2 }, ['1 2 3', '4 5 6']),
    );
    expect(pc.pointCount).toBe(2);
    expect(pc.organizedRange).toBeUndefined();
  });

  it('refuses a grid when POINTS and WIDTH x HEIGHT disagree with the body', async () => {
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3, points: 6 }, GRID_ROWS.slice(0, 6)));
    expect(pc.pointCount).toBe(6);
    expect(pc.organizedRange).toBeUndefined();
  });
});

describe('cell states an organized PCD can justify', () => {
  it('marks a non-finite record source-invalid, never a no-return', async () => {
    const rows = [...GRID_ROWS];
    rows[5] = 'nan 1 0'; // row 1, column 1 under a row-major read
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3 }, rows));
    const f = pc.organizedRange!.frames[0];
    expect(f.cellState[cellIndexOf(1, 1, 4)]).toBe(CellState.SOURCE_INVALID);
    // PCD has no no-return semantics, so this loader must never emit one.
    expect(f.diagnostics.stateCounts[CellState.NO_RETURN]).toBe(0);
    const r = recordForCell(f, 1, 1);
    expect(r.ok).toBe(false);
    expect(f.cellToRecord[cellIndexOf(1, 1, 4)]).toBe(NO_RECORD);
  });

  it('keeps every surviving cell linked after the dropped record shifts the rest', async () => {
    const rows = [...GRID_ROWS];
    rows[5] = 'nan 1 0';
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3 }, rows));
    const f = pc.organizedRange!.frames[0];
    // Every cell after the casualty moved down one display index. The
    // coordinates are what prove the link followed it.
    const r = recordForCell(f, 2, 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(worldXY(pc, r.record)).toEqual([3, 2]);
  });
});

describe('the acquisition viewpoint', () => {
  it('carries an explicitly declared viewpoint, translation and quaternion', async () => {
    const pc = await loadPcd(
      asciiPcd({ width: 4, height: 3, viewpoint: '10 20 30 0.5 0.5 0.5 0.5' }, GRID_ROWS),
    );
    const pose = pc.organizedRange!.frames[0].acquisitionPose;
    expect(pose?.worldTranslation).toEqual([10, 20, 30]);
    // PCD writes the quaternion qw qx qy qz. Named components, so a reader
    // cannot mistake the order.
    expect(pose?.rotation).toEqual({ w: 0.5, x: 0.5, y: 0.5, z: 0.5 });
    expect(pose?.rotationSource).toBe('source-declared');
  });

  it('records no pose at all when the file declares no viewpoint', async () => {
    // An absent VIEWPOINT and the default `0 0 0 1 0 0 0` are different
    // assertions; only one of them is the file saying where the sensor was.
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3, viewpoint: null }, GRID_ROWS));
    expect(pc.organizedRange!.frames[0].acquisitionPose).toBeUndefined();
  });

  it('keeps an explicit default viewpoint distinguishable from an absent one', async () => {
    const pc = await loadPcd(asciiPcd({ width: 4, height: 3 }, GRID_ROWS));
    const pose = pc.organizedRange!.frames[0].acquisitionPose;
    expect(pose?.worldTranslation).toEqual([0, 0, 0]);
    expect(pose?.rotation).toEqual({ w: 1, x: 0, y: 0, z: 0 });
  });
});

describe('an encoding OLV does not walk itself', () => {
  /** A 3x2 f32 binary PCD. OLV reads no record of this body; three.js does. */
  function binaryPcd(): ArrayBuffer {
    const header = [
      '# .PCD v0.7',
      'VERSION 0.7',
      'FIELDS x y z',
      'SIZE 4 4 4',
      'TYPE F F F',
      'COUNT 1 1 1',
      'WIDTH 3',
      'HEIGHT 2',
      'VIEWPOINT 1 2 3 1 0 0 0',
      'POINTS 6',
      'DATA binary',
      '',
    ].join('\n');
    const head = new TextEncoder().encode(header);
    const out = new Uint8Array(head.length + 6 * 12);
    out.set(head, 0);
    const view = new DataView(out.buffer);
    let at = head.length;
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 3; column++) {
        view.setFloat32(at, column, true);
        view.setFloat32(at + 4, row, true);
        view.setFloat32(at + 8, 0, true);
        at += 12;
      }
    }
    return out.buffer;
  }

  it('keeps the topology and the pose but claims no record identity', async () => {
    const pc = await loadPcd(binaryPcd());
    expect(pc.pointCount).toBe(6);
    const f = pc.organizedRange!.frames[0];
    expect(f.width).toBe(3);
    expect(f.height).toBe(2);
    expect(f.acquisitionPose?.worldTranslation).toEqual([1, 2, 3]);
    expect(f.linkage).toEqual({
      kind: 'unavailable',
      reason: 'source-record-identity-unavailable',
    });
    expect([...f.cellToRecord]).toEqual(new Array(6).fill(NO_RECORD));
    // No record was delivered for any cell, and none of them is a statement
    // about the sensor.
    expect(f.diagnostics.stateCounts[CellState.NOT_DECODED]).toBe(6);
    expect(f.diagnostics.stateCounts[CellState.NO_RETURN]).toBe(0);
    const r = recordForCell(f, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain('unavailable');
  });
});
