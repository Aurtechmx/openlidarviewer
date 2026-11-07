/**
 * mainChannel.test.ts — the longest flow path of a catchment, its profile and
 * the slopes taken from it.
 *
 * The ramps have closed forms: a uniform ramp has the same slope under every
 * definition, and the two-slope ramp lets the Taylor–Schwarz expression be
 * written out by hand.
 */
import { describe, expect, it } from 'vitest';
import { mainChannel } from '../src/simulation/flowPulse/watershed/mainChannel';
import type { Figure } from '../src/simulation/flowPulse/watershed/catchmentMorphometrics';
import { CELL_OUTLET, CELL_ROUTED, type FlowGrid } from '../src/simulation/flowPulse/flowTypes';
import { d8Flow, type D8Result } from '../src/simulation/flowPulse/d8Flow';

function valueOf<T>(figure: Figure<T>): T {
  if (!('value' in figure)) throw new Error(`figure withheld: ${figure.withheld}`);
  return figure.value;
}

/** One row of `cols` cells, 1 m apart, falling toward column 0; height = rise(col). */
function strip(cols: number, rise: (col: number) => number): FlowGrid {
  const z = new Float64Array(cols);
  for (let c = 0; c < cols; c++) z[c] = rise(c);
  return { z, valid: new Uint8Array(cols).fill(1), cols, rows: 1, cellMetresX: 1, cellMetresY: 1 };
}

/** Every cell sends its flow west by hand, so a flat reach can be tested. */
function westward(cols: number): D8Result {
  const receiver = new Int32Array(cols);
  const direction = new Int8Array(cols);
  const status = new Uint8Array(cols);
  for (let c = 0; c < cols; c++) {
    receiver[c] = c - 1;
    direction[c] = c === 0 ? -1 : 4;
    status[c] = c === 0 ? CELL_OUTLET : CELL_ROUTED;
  }
  return { receiver, direction, status, sinkCount: 0, flatCount: 0, outletCount: 1 };
}

const noCoverage = (n: number) => new Uint8Array(n).fill(2);
const all = (n: number) => new Uint8Array(n).fill(1);

/** A routed ramp (three rows so D8 sees a real grid) with the catchment in the middle row. */
function ramp(cols: number, step: number): { grid: FlowGrid; routed: D8Result; mask: Uint8Array; outlet: number } {
  const rows = 3;
  const z = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = c * step;
  const grid: FlowGrid = { z, valid: new Uint8Array(cols * rows).fill(1), cols, rows, cellMetresX: 1, cellMetresY: 1 };
  const mask = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c++) mask[cols + c] = 1;
  return { grid, routed: d8Flow(grid), mask, outlet: cols };
}

describe('mainChannel', () => {
  it('slope1085 equals the analytic slope on a uniform ramp', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(grid.z.length) });
    expect(valueOf(ch.lengthM)).toBeCloseTo(100, 9);
    expect(valueOf(ch.slope1085)).toBeCloseTo(0.05, 9);
  });

  it('Taylor–Schwarz equals the uniform slope on a uniform ramp', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(grid.z.length) });
    expect(valueOf(ch.slopeTaylorSchwarz)).toBeCloseTo(0.05, 9);
  });

  it('runs from the divide down to the outlet with distance and height above the outlet', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(grid.z.length) });
    expect(ch.cells.length).toBe(101);
    expect(ch.cells[0]).toBe(101 + 100);
    expect(ch.cells[100]).toBe(outlet);
    expect(ch.profile.distanceM[0]).toBe(0);
    expect(ch.profile.distanceM[100]).toBeCloseTo(100, 9);
    expect(ch.profile.elevationM[0]).toBeCloseTo(5, 9);
    expect(ch.profile.elevationM[100]).toBe(0);
    expect(ch.d8LengthBiasMax).toBe(0.082);
  });

  it('scales heights by the vertical unit', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 0.3048, coverage: noCoverage(grid.z.length) });
    expect(valueOf(ch.slope1085)).toBeCloseTo(0.05 * 0.3048, 9);
    expect(ch.profile.elevationM[0]).toBeCloseTo(5 * 0.3048, 9);
  });

  it('reports three reaches by thirds of the length', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(grid.z.length) });
    expect(ch.reachSlopes).toHaveLength(3);
    expect(ch.reachSlopes[0].fromM).toBe(0);
    expect(ch.reachSlopes[0].toM).toBeCloseTo(100 / 3, 9);
    expect(ch.reachSlopes[2].toM).toBeCloseTo(100, 9);
    for (const reach of ch.reachSlopes) expect(reach.slope).toBeCloseTo(0.05, 9);
  });

  it('weights Taylor–Schwarz toward the gentle reaches on a two-slope channel', () => {
    // Near the outlet 0.02 for 50 m, then 0.10 for 50 m: five reaches of each.
    const grid = strip(101, (c) => (c <= 50 ? 0.02 * c : 1 + 0.1 * (c - 50)));
    const mask = new Uint8Array(101).fill(1);
    const ch = mainChannel({ grid, routed: westward(101), outlet: 0, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(101) });
    const expected = (10 / (5 / Math.sqrt(0.02) + 5 / Math.sqrt(0.1))) ** 2;
    expect(valueOf(ch.slopeTaylorSchwarz)).toBeCloseTo(expected, 9);
    // 10-85 slope: heights at 85 m and 10 m up the channel from the outlet.
    const e85 = 1 + 0.1 * (85 - 50);
    const e10 = 0.02 * 10;
    expect(valueOf(ch.slope1085)).toBeCloseTo((e85 - e10) / 75, 9);
  });

  it('uses 1e-4 for a flat reach in Taylor–Schwarz', () => {
    // The ten metres nearest the outlet are level, then 0.10.
    const grid = strip(101, (c) => (c <= 10 ? 0 : 0.1 * (c - 10)));
    const mask = new Uint8Array(101).fill(1);
    const ch = mainChannel({ grid, routed: westward(101), outlet: 0, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(101) });
    const expected = (10 / (1 / Math.sqrt(1e-4) + 9 / Math.sqrt(0.1))) ** 2;
    expect(valueOf(ch.slopeTaylorSchwarz)).toBeCloseTo(expected, 12);
    expect(valueOf(ch.slope1085)).toBeCloseTo(0.1, 9);
  });

  it('profile marks cells over interpolated ground', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const coverage = noCoverage(grid.z.length);
    coverage[101 + 3] = 1; // column 3 of the channel row
    coverage[101 + 4] = 1;
    coverage[101 + 5] = 0; // no data under it: not "interpolated"
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage });
    const at = (col: number) => ch.cells.indexOf(101 + col);
    expect(ch.profile.interpolated[at(3)]).toBe(1);
    expect(ch.profile.interpolated[at(4)]).toBe(1);
    expect(ch.profile.interpolated[at(5)]).toBe(0);
    expect(ch.profile.interpolated[at(6)]).toBe(0);
    expect(Array.from(ch.profile.interpolated).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('marks every cell interpolated when the coverage says so', () => {
    const { grid, routed, mask, outlet } = ramp(11, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage: all(grid.z.length) });
    expect(Array.from(ch.profile.interpolated)).toEqual(new Array(11).fill(1));
  });

  it('breaks a tie between equally long paths by the lowest cell index', () => {
    const grid = strip(3, (c) => (c === 1 ? 0 : 1));
    const routed: D8Result = {
      receiver: Int32Array.from([1, -1, 1]),
      direction: Int8Array.from([0, -1, 4]),
      status: Uint8Array.from([CELL_ROUTED, CELL_OUTLET, CELL_ROUTED]),
      sinkCount: 0, flatCount: 0, outletCount: 1,
    };
    const ch = mainChannel({ grid, routed, outlet: 1, mask: new Uint8Array(3).fill(1), complete: true, verticalToMetres: 1, coverage: noCoverage(3) });
    expect(Array.from(ch.cells)).toEqual([0, 1]);
    expect(valueOf(ch.lengthM)).toBe(1);
  });

  it('reports a minimum length and withholds the slopes for an open catchment', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: false, verticalToMetres: 1, coverage: noCoverage(grid.z.length) });
    expect(ch.lengthM).toEqual({ value: 100, bound: 'minimum' });
    expect(ch.slope1085).toEqual({ withheld: 'open-catchment' });
    expect(ch.slopeTaylorSchwarz).toEqual({ withheld: 'open-catchment' });
    expect(ch.reachSlopes).toHaveLength(0);
    expect(ch.cells.length).toBe(101);
  });

  it('withholds the slopes when the vertical unit is unresolved', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: null, coverage: noCoverage(grid.z.length) });
    expect(valueOf(ch.lengthM)).toBeCloseTo(100, 9);
    expect(ch.slope1085).toEqual({ withheld: 'vertical-unresolved' });
    expect(ch.slopeTaylorSchwarz).toEqual({ withheld: 'vertical-unresolved' });
    expect(ch.reachSlopes).toHaveLength(0);
    expect(Number.isNaN(ch.profile.elevationM[0])).toBe(true);
  });

  it('puts the open-catchment reason ahead of the vertical one', () => {
    const { grid, routed, mask, outlet } = ramp(101, 0.05);
    const ch = mainChannel({ grid, routed, outlet, mask, complete: false, verticalToMetres: null, coverage: noCoverage(grid.z.length) });
    expect(ch.slope1085).toEqual({ withheld: 'open-catchment' });
  });

  it('withholds the figures for a one-cell catchment', () => {
    const { grid, routed, outlet } = ramp(11, 0.05);
    const mask = new Uint8Array(grid.z.length);
    mask[outlet] = 1;
    const ch = mainChannel({ grid, routed, outlet, mask, complete: true, verticalToMetres: 1, coverage: noCoverage(grid.z.length) });
    expect(Array.from(ch.cells)).toEqual([outlet]);
    expect(valueOf(ch.lengthM)).toBe(0);
    expect(ch.slope1085).toEqual({ withheld: 'too-small' });
    expect(ch.slopeTaylorSchwarz).toEqual({ withheld: 'too-small' });
  });
});
