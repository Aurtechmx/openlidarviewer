/**
 * flowGridCursor.test.ts — the cell/cursor math behind the keyboard- and
 * pointer-accessible result grid.
 *
 * Pure functions, so every mapping a click or an arrow key resolves to is
 * checked here without a browser: clamp/move a cursor, a canvas pixel back to
 * a cell, and the readable sentence a cursor move announces.
 */
import { describe, expect, it } from 'vitest';

import {
  cellAnnouncement,
  cellAt,
  cellIndex,
  clampCell,
  describeCell,
  inBounds,
  moveCursor,
  pixelToCell,
  statusLabel,
} from '../src/simulation/flowPulse/flowGridCursor';
import { CELL_FLAT, CELL_NODATA, CELL_OUTLET, CELL_ROUTED, CELL_SINK } from '../src/simulation/flowPulse/flowTypes';
import type { AccumulationResult } from '../src/simulation/flowPulse/flowAccumulation';
import type { D8Result } from '../src/simulation/flowPulse/d8Flow';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

describe('clampCell / moveCursor', () => {
  it('rounds and clamps into the grid', () => {
    expect(clampCell(4, 3, 1.6, -1)).toEqual({ col: 2, row: 0 });
    expect(clampCell(4, 3, 99, 99)).toEqual({ col: 3, row: 2 });
    expect(clampCell(4, 3, -99, -99)).toEqual({ col: 0, row: 0 });
  });

  it('moves and clamps at the edge rather than wrapping', () => {
    expect(moveCursor(4, 3, { col: 0, row: 0 }, -1, 0)).toEqual({ col: 0, row: 0 });
    expect(moveCursor(4, 3, { col: 3, row: 2 }, 1, 1)).toEqual({ col: 3, row: 2 });
    expect(moveCursor(4, 3, { col: 1, row: 1 }, 1, 0)).toEqual({ col: 2, row: 1 });
  });
});

describe('inBounds', () => {
  it('accepts an integer address inside the grid', () => {
    expect(inBounds(4, 3, 0, 0)).toBe(true);
    expect(inBounds(4, 3, 3, 2)).toBe(true);
  });

  it('rejects outside the grid, negative, or non-integer', () => {
    expect(inBounds(4, 3, 4, 0)).toBe(false);
    expect(inBounds(4, 3, 0, 3)).toBe(false);
    expect(inBounds(4, 3, -1, 0)).toBe(false);
    expect(inBounds(4, 3, 1.5, 0)).toBe(false);
  });
});

describe('cellIndex / cellAt', () => {
  it('round-trips row-major indexing, matching every routing array', () => {
    const cols = 5;
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < cols; col++) {
        const i = cellIndex(cols, { col, row });
        expect(i).toBe(row * cols + col);
        expect(cellAt(cols, i)).toEqual({ col, row });
      }
    }
  });
});

describe('pixelToCell', () => {
  it('maps a canvas point to the nearest cell', () => {
    // 4x3 grid rendered at 40x30 px ⇒ 10px per cell.
    expect(pixelToCell(4, 3, 40, 30, 0, 0)).toEqual({ col: 0, row: 0 });
    expect(pixelToCell(4, 3, 40, 30, 39, 29)).toEqual({ col: 3, row: 2 });
    expect(pixelToCell(4, 3, 40, 30, 15, 12)).toEqual({ col: 1, row: 1 });
  });

  it('returns null off-canvas or for an empty grid', () => {
    expect(pixelToCell(4, 3, 40, 30, -1, 0)).toBeNull();
    expect(pixelToCell(4, 3, 40, 30, 40, 0)).toBeNull();
    expect(pixelToCell(0, 3, 40, 30, 5, 5)).toBeNull();
  });
});

describe('statusLabel', () => {
  it('names every routed status', () => {
    expect(statusLabel(CELL_ROUTED)).toBe('routed');
    expect(statusLabel(CELL_SINK)).toBe('sink');
    expect(statusLabel(CELL_FLAT)).toBe('flat, unresolved');
    expect(statusLabel(CELL_OUTLET)).toBe('outlet');
    expect(statusLabel(CELL_NODATA)).toBe('no data');
  });
});

describe('describeCell / cellAnnouncement', () => {
  // 2x2: [[3,2],[1,0]] with cell (1,1) made NoData.
  const grid: FlowGrid = {
    z: Float32Array.from([3, 2, 1, 0]),
    valid: Uint8Array.from([1, 1, 1, 0]),
    cols: 2, rows: 2, cellMetresX: 1, cellMetresY: 1,
  };
  const routed: D8Result = {
    receiver: Int32Array.from([1, 3, -1, -1]),
    direction: Int8Array.from([0, 2, -1, -1]),
    status: Uint8Array.from([CELL_ROUTED, CELL_OUTLET, CELL_SINK, CELL_NODATA]),
    sinkCount: 1, flatCount: 0, outletCount: 1,
  };
  const accumulation: AccumulationResult = {
    upstreamCells: Uint32Array.from([1, 2, 1, 0]),
    drainedCells: 3, unresolvedCells: 0,
  };
  const areaM2 = Float64Array.from([1, 2, 1, 0]);

  it('reports status, upstream cells and area for a readable cell, withholding elevation with no reference', () => {
    const report = describeCell(grid, routed, accumulation, areaM2, { col: 1, row: 0 });
    expect(report).toEqual({
      col: 1, row: 0, readable: true, elevation: null, elevationUnit: 'unknown', status: 'outlet',
      upstreamCells: 2, contributingAreaM2: 2,
    });
    expect(cellAnnouncement(report)).toBe(
      'Column 1, row 0, elevation unknown, outlet, 2 cell(s) upstream, 2.0 square metres contributing.',
    );
  });

  it('withholds elevation, upstream count and area for a NoData cell', () => {
    const report = describeCell(grid, routed, accumulation, areaM2, { col: 1, row: 1 });
    expect(report.readable).toBe(false);
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBeNull();
    expect(report.upstreamCells).toBeNull();
    expect(report.contributingAreaM2).toBeNull();
    expect(cellAnnouncement(report)).toBe('Column 1, row 1, no elevation.');
  });

  it('drops the area clause entirely when area is withheld (null scale)', () => {
    const report = describeCell(grid, routed, accumulation, null, { col: 0, row: 0 });
    expect(cellAnnouncement(report)).toBe('Column 0, row 0, elevation unknown, routed, 1 cell(s) upstream.');
  });

  // The grid-local z must never be printed as if it were a real elevation.
  // With a resolved origin/unit the report adds the origin back and labels
  // the unit; the fixture mirrors a real USGS 3DEP tile — a local
  // z of ~2 rebased against a ~1232 m NAVD88 origin reads ~1234 m, not "2.00".
  it('reports a real elevation with unit when the origin and vertical unit resolve', () => {
    const report = describeCell(grid, routed, accumulation, areaM2, { col: 1, row: 0 }, {
      originZ: 1232, unitLabel: 'm',
    });
    expect(report.elevation).toBeCloseTo(1234, 6);
    expect(report.elevationUnit).toBe('m');
    expect(cellAnnouncement(report)).toBe(
      'Column 1, row 0, elevation 1234.00 m, outlet, 2 cell(s) upstream, 2.0 square metres contributing.',
    );
  });

  it('reports elevation unknown when the origin resolved but the vertical unit did not', () => {
    const report = describeCell(grid, routed, accumulation, areaM2, { col: 1, row: 0 }, {
      originZ: 1232, unitLabel: 'units',
    });
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBe('unknown');
  });

  it('reports elevation unknown when the vertical unit resolved but the origin did not', () => {
    const report = describeCell(grid, routed, accumulation, areaM2, { col: 1, row: 0 }, {
      originZ: null, unitLabel: 'm',
    });
    expect(report.elevation).toBeNull();
    expect(report.elevationUnit).toBe('unknown');
  });
});
