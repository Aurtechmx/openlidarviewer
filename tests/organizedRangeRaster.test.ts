/**
 * organizedRangeRaster.test.ts — the two things a raster can silently get wrong.
 *
 * A transposed display-to-source mapping and an absent range painted as a short
 * one both produce a picture that looks entirely reasonable. Neither would be
 * caught by rendering the widget and looking at it, so both are pinned here
 * against grids where the right answer is fixed by construction.
 *
 * EVERY GRID IN THIS FILE IS NON-SQUARE, deliberately. On a square grid a
 * mapping that swaps row and column is indistinguishable from a correct one.
 */

import { describe, it, expect } from 'vitest';
import {
  CellState,
  type CellStateValue,
  type OrganizedRangeFrame,
  type RangeLinkage,
  cellIndexOf,
  tallyCellStates,
} from '../src/model/OrganizedRange';
import {
  CELL_STATE_RGB,
  RANGE_ABSENT_RGB,
  cellForRecord,
  cellRgb,
  displayPixelOf,
  planRangeRaster,
  rangeDomainOf,
  rangeRampRgb,
  rasterizeRangeFrame,
  sourceCellAt,
} from '../src/diagnostics/rangeRaster';

/** A frame with an explicit per-cell state and range, addressed row-major. */
function frameOf(opts: {
  width: number;
  height: number;
  state?: (row: number, column: number) => CellStateValue;
  range?: (row: number, column: number) => number;
  record?: (row: number, column: number) => number;
  linkage?: RangeLinkage;
}): OrganizedRangeFrame {
  const { width, height } = opts;
  const cells = width * height;
  const cellState = new Uint8Array(cells).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(cells).fill(-1);
  const geometricRange = opts.range ? new Float32Array(cells).fill(NaN) : undefined;
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const i = cellIndexOf(row, column, width);
      if (opts.state) cellState[i] = opts.state(row, column);
      if (opts.record) cellToRecord[i] = opts.record(row, column);
      if (geometricRange && opts.range) geometricRange[i] = opts.range(row, column);
    }
  }
  return {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    ...(geometricRange ? { geometricRange } : {}),
    linkage: opts.linkage ?? { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
}

describe('the display to source mapping', () => {
  // 5 columns by 3 rows. Every assertion below fails if the two axes are swapped.
  const plan = planRangeRaster(5, 3, 100, 100);

  it('never enlarges a grid past one pixel per cell', () => {
    expect(plan.displayWidth).toBe(5);
    expect(plan.displayHeight).toBe(3);
  });

  it('maps the horizontal display axis to the COLUMN and the vertical to the ROW', () => {
    // The load-bearing case: display (4, 0) is the last column of the first row.
    // A transposed mapping would answer row 4, which does not exist on a 3-row
    // grid, and would be clamped to row 2 — a plausible, wrong cell.
    expect(sourceCellAt(plan, 4, 0)).toEqual({ row: 0, column: 4 });
    expect(sourceCellAt(plan, 0, 2)).toEqual({ row: 2, column: 0 });
    expect(sourceCellAt(plan, 3, 1)).toEqual({ row: 1, column: 3 });
  });

  it('refuses a display coordinate outside the raster', () => {
    expect(sourceCellAt(plan, 5, 0)).toBeNull();
    expect(sourceCellAt(plan, 0, 3)).toBeNull();
    expect(sourceCellAt(plan, -1, 0)).toBeNull();
  });

  it('keeps cell identity through a downscale, on a non-square grid', () => {
    // 100 columns by 20 rows drawn into a 10 by 4 box: 10 columns and 5 rows of
    // source cells per display pixel. The right-hand edge must still be the
    // right-hand edge of the SOURCE.
    const down = planRangeRaster(100, 20, 10, 4);
    expect(down.displayWidth).toBe(10);
    expect(down.displayHeight).toBe(4);
    expect(sourceCellAt(down, 0, 0)).toEqual({ row: 0, column: 0 });
    expect(sourceCellAt(down, 9, 3)).toEqual({ row: 15, column: 90 });
    // A transposition here would ask for column 15 and row 90 — both in range
    // for SOME grid, which is exactly why the shape is non-square.
    expect(sourceCellAt(down, 1, 0)).toEqual({ row: 0, column: 10 });
    expect(sourceCellAt(down, 0, 1)).toEqual({ row: 5, column: 0 });
  });

  it('round-trips a source cell back to the pixel it is drawn at', () => {
    const down = planRangeRaster(100, 20, 10, 4);
    expect(displayPixelOf(down, 15, 90)).toEqual({ x: 9, y: 3 });
    expect(displayPixelOf(down, 0, 0)).toEqual({ x: 0, y: 0 });
    // Outside the SOURCE grid, not the display one.
    expect(displayPixelOf(down, 20, 0)).toBeNull();
    expect(displayPixelOf(down, 0, 100)).toBeNull();
  });
});

describe('the mode colour mapping', () => {
  it('gives each of the five cell states its own colour', () => {
    const frame = frameOf({ width: 5, height: 1 });
    const seen = new Set<string>();
    for (const state of [
      CellState.VALID_RETURN,
      CellState.NO_RETURN,
      CellState.SOURCE_INVALID,
      CellState.NOT_DECODED,
      CellState.SOURCE_RECORD_MISSING,
    ]) {
      frame.cellState[0] = state;
      const rgb = cellRgb(frame, 0, 'validity', null);
      expect(rgb).toEqual(CELL_STATE_RGB[state]);
      seen.add(rgb.join(','));
    }
    expect(seen.size).toBe(5);
  });

  it('paints a cell with no geometric range in a colour that is NOT on the ramp', () => {
    // 4 columns by 2 rows. Column 0 has no return, so its range is NaN; the
    // rest carry a real distance. The near end of the ramp must not be reused
    // for the absent cell, or "nothing came back" reads as "zero away".
    const frame = frameOf({
      width: 4,
      height: 2,
      state: (_r, c) => (c === 0 ? CellState.NO_RETURN : CellState.VALID_RETURN),
      range: (_r, c) => (c === 0 ? NaN : 10 + c),
    });
    const domain = rangeDomainOf(frame)!;
    expect(domain).toEqual({ min: 11, max: 13 });

    const absent = cellRgb(frame, cellIndexOf(0, 0, 4), 'range', domain);
    const nearest = cellRgb(frame, cellIndexOf(0, 1, 4), 'range', domain);
    expect(absent).toEqual(RANGE_ABSENT_RGB);
    expect(nearest).toEqual(rangeRampRgb(0));
    expect(absent).not.toEqual(nearest);
    // And it is not the ramp's far end either, nor anywhere along it.
    for (let t = 0; t <= 1.0001; t += 0.05) {
      expect(rangeRampRgb(t)).not.toEqual(RANGE_ABSENT_RGB);
    }
  });

  it('reports no range domain at all for a frame that carries no geometric range', () => {
    expect(rangeDomainOf(frameOf({ width: 3, height: 2 }))).toBeNull();
  });

  it('paints every cell absent when the frame carries no geometric range', () => {
    const frame = frameOf({ width: 3, height: 2 });
    expect(cellRgb(frame, 0, 'range', null)).toEqual(RANGE_ABSENT_RGB);
  });
});

describe('rasterising a frame', () => {
  it('writes the plan-sized buffer, not the source-sized one', () => {
    const frame = frameOf({ width: 100, height: 20 });
    const plan = planRangeRaster(100, 20, 10, 4);
    const raster = rasterizeRangeFrame(frame, 'validity', plan);
    expect(raster.pixels.length).toBe(10 * 4 * 4);
  });

  it('draws the state of the SOURCE cell each pixel samples', () => {
    // A single invalid cell at row 1, column 4 of a 5 by 3 grid. Drawn at 1:1,
    // the pixel at x=4, y=1 carries the invalid colour and no other does.
    const frame = frameOf({
      width: 5,
      height: 3,
      state: (r, c) => (r === 1 && c === 4 ? CellState.SOURCE_INVALID : CellState.VALID_RETURN),
    });
    const plan = planRangeRaster(5, 3, 50, 50);
    const { pixels } = rasterizeRangeFrame(frame, 'validity', plan);
    const at = (x: number, y: number): number[] => {
      const p = (y * plan.displayWidth + x) * 4;
      return [pixels[p], pixels[p + 1], pixels[p + 2]];
    };
    expect(at(4, 1)).toEqual([...CELL_STATE_RGB[CellState.SOURCE_INVALID]]);
    expect(at(1, 4 % 3)).not.toEqual([...CELL_STATE_RGB[CellState.SOURCE_INVALID]]);
    expect(at(0, 0)).toEqual([...CELL_STATE_RGB[CellState.VALID_RETURN]]);
  });
});

describe('finding the cell a display record came from', () => {
  const frame = frameOf({
    width: 5,
    height: 3,
    record: (row, column) => cellIndexOf(row, column, 5) + 100,
  });

  it('answers the exact cell the loader recorded', () => {
    // Record 100 + (1 * 5 + 4) = 109 lives at row 1, column 4.
    expect(cellForRecord(frame, 109)).toEqual({ row: 1, column: 4 });
  });

  it('answers null for a record this grid never produced', () => {
    expect(cellForRecord(frame, 9999)).toBeNull();
  });

  it('answers null for every record once linkage is unavailable', () => {
    const gone = frameOf({
      width: 5,
      height: 3,
      record: (row, column) => cellIndexOf(row, column, 5) + 100,
      linkage: { kind: 'unavailable', reason: 'voxel-centroids' },
    });
    expect(cellForRecord(gone, 109)).toBeNull();
  });
});
