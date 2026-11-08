/**
 * catchmentMorphometrics.test.ts — shape, relief and hypsometry of a catchment,
 * and the reasons a figure is withheld instead of printed.
 *
 * The cone has closed forms (circularity 1, Gravelius 1, hypsometric integral
 * 1/3). The rectangle is small enough to read every length off the picture.
 */
import { describe, expect, it } from 'vitest';
import { catchmentMorphometrics, type Figure } from '../src/simulation/flowPulse/watershed/catchmentMorphometrics';
import { traceDivide, type TracedDivide } from '../src/simulation/flowPulse/watershed/divideTrace';
import type { FlowGrid } from '../src/simulation/flowPulse/flowTypes';

function valueOf<T>(figure: Figure<T>): T {
  if (!('value' in figure)) throw new Error(`figure withheld: ${figure.withheld}`);
  return figure.value;
}

/** Cone: apex at the centre, z = H (1 − r / R), H = 50 m, R = 100 m, 1 m cells. */
function cone(): { grid: FlowGrid; mask: Uint8Array; outlet: number } {
  const size = 200;
  const grid: FlowGrid = {
    z: new Float64Array(size * size),
    valid: new Uint8Array(size * size).fill(1),
    cols: size, rows: size, cellMetresX: 1, cellMetresY: 1,
  };
  const mask = new Uint8Array(size * size);
  const centre = size / 2;
  let outlet = -1;
  let outletR = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const d = Math.hypot(c + 0.5 - centre, r + 0.5 - centre);
      (grid.z as Float64Array)[r * size + c] = 50 * (1 - d / 100);
      if (d <= 100) {
        mask[r * size + c] = 1;
        if (d > outletR) { outletR = d; outlet = r * size + c; }
      }
    }
  }
  return { grid, mask, outlet };
}

/** 40 columns by 10 rows, falling toward column 0; the outlet is cell (0, 0). */
function rectangle(): { grid: FlowGrid; mask: Uint8Array; outlet: number } {
  const cols = 40;
  const rows = 10;
  const grid: FlowGrid = {
    z: new Float64Array(cols * rows),
    valid: new Uint8Array(cols * rows).fill(1),
    cols, rows, cellMetresX: 1, cellMetresY: 1,
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) (grid.z as Float64Array)[r * cols + c] = 100 + c * 0.5;
  return { grid, mask: new Uint8Array(cols * rows).fill(1), outlet: 0 };
}

const closed = { complete: true, verticalToMetres: 1, originZ: 0 };

describe('catchmentMorphometrics', () => {
  it('matches closed forms on a circular cone', () => {
    const { grid, mask, outlet } = cone();
    const divide = traceDivide(grid, mask);
    const m = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed });
    expect(valueOf(m.gravelius)).toBeGreaterThan(0.97);
    expect(valueOf(m.gravelius)).toBeLessThan(1.03);
    expect(Math.abs(valueOf(m.circularity) - 1)).toBeLessThan(0.05);
    const h = valueOf(m.hypsometry);
    expect(Math.abs(h.integral - 1 / 3)).toBeLessThan(0.02);
    expect(h.relArea.length).toBe(20);
    expect(h.relHeight.length).toBe(20);
    expect(h.relArea[0]).toBe(1);
    // Area of a disc of radius 100 m, to the cell-staircase tolerance.
    expect(Math.abs(valueOf(m.areaM2) - Math.PI * 1e4) / (Math.PI * 1e4)).toBeLessThan(0.005);
    // The cone falls at 50 / 100 = 50 %.
    expect(Math.abs(valueOf(m.meanSlopePct) - 50)).toBeLessThan(1.5);
    expect(valueOf(m.reliefM)).toBeGreaterThan(49);
  });

  it('computes form factor and elongation from Lb', () => {
    const { grid, mask, outlet } = rectangle();
    const divide = traceDivide(grid, mask);
    const m = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed });
    // Outlet cell centre (0.5, 0.5) to the far corner (40, 10).
    const lb = Math.hypot(39.5, 9.5);
    expect(valueOf(m.basinLengthM)).toBeCloseTo(lb, 9);
    expect(valueOf(m.areaM2)).toBe(400);
    expect(valueOf(m.formFactor)).toBeCloseTo(400 / (lb * lb), 9);
    expect(valueOf(m.elongation)).toBeCloseTo((1.128 * 20) / lb, 9);
    expect(valueOf(m.gravelius)).toBeCloseTo((0.282 * divide.perimeterM) / 20, 9);
    expect(valueOf(m.circularity)).toBeCloseTo((4 * Math.PI * 400) / (divide.perimeterM ** 2), 9);
    // 96 boundary cells, half of them, one cell area each.
    expect(m.areaBandM2).toBe(48);
    // z runs 100 .. 119.5 over the columns: relief is 19.5 m from the outlet.
    expect(valueOf(m.reliefM)).toBeCloseTo(19.5, 9);
    expect(valueOf(m.meanSlopePct)).toBeGreaterThan(49);
    expect(valueOf(m.meanSlopePct)).toBeLessThan(51);
  });

  it('prints area and relief as minimums and withholds shape for an open catchment', () => {
    const { grid, mask, outlet } = rectangle();
    const divide = traceDivide(grid, mask);
    const m = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed, complete: false });
    expect(m.areaM2).toEqual({ value: 400, bound: 'minimum' });
    expect(m.reliefM).toEqual({ value: 19.5, bound: 'minimum' });
    for (const f of [m.perimeterM, m.gravelius, m.formFactor, m.elongation, m.circularity,
      m.basinLengthM, m.meanSlopePct, m.hypsometry, m.meanElevationM]) {
      expect(f).toEqual({ withheld: 'open-catchment' });
    }
  });

  it('withholds vertical figures when the vertical unit is unresolved', () => {
    const { grid, mask, outlet } = rectangle();
    const divide = traceDivide(grid, mask);
    const m = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed, verticalToMetres: null });
    for (const f of [m.reliefM, m.meanSlopePct, m.hypsometry, m.meanElevationM]) {
      expect(f).toEqual({ withheld: 'vertical-unresolved' });
    }
    // Horizontal figures do not depend on the vertical unit.
    expect(valueOf(m.areaM2)).toBe(400);
    expect(valueOf(m.gravelius)).toBeGreaterThan(0);
  });

  it('prints elevations relative to the outlet when originZ is null', () => {
    const { grid, mask, outlet } = rectangle();
    const divide = traceDivide(grid, mask);
    const rel = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed, originZ: null });
    expect(rel.elevationsRelative).toBe(true);
    // Mean of 0 .. 19.5 in steps of 0.5 is 9.75 above the outlet at z = 100.
    expect(valueOf(rel.meanElevationM)).toBeCloseTo(9.75, 9);
    const abs = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed, originZ: 1000 });
    expect(abs.elevationsRelative).toBe(false);
    expect(valueOf(abs.meanElevationM)).toBeCloseTo(1000 + 109.75, 9);
    // A foot-vertical grid converts the lot.
    const ft = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed, originZ: 1000, verticalToMetres: 0.3048 });
    expect(valueOf(ft.meanElevationM)).toBeCloseTo(1109.75 * 0.3048, 9);
    expect(valueOf(ft.reliefM)).toBeCloseTo(19.5 * 0.3048, 9);
  });

  it('withholds shape figures for a two-cell catchment as too small', () => {
    const { grid } = rectangle();
    const mask = new Uint8Array(grid.cols * grid.rows);
    mask[0] = 1;
    mask[1] = 1;
    const divide = traceDivide(grid, mask);
    const m = catchmentMorphometrics({ grid, mask, outlet: 0, divide, ...closed });
    for (const f of [m.gravelius, m.formFactor, m.elongation, m.circularity, m.hypsometry]) {
      expect(f).toEqual({ withheld: 'too-small' });
    }
    expect(valueOf(m.areaM2)).toBe(2);
  });

  it('does not use the perimeter or outline of a degenerate divide', () => {
    const { grid, mask, outlet } = rectangle();
    const real = traceDivide(grid, mask);
    const divide: TracedDivide = { ...real, outer: new Float64Array([0, 0, 40, 10]), perimeterM: 82.4, degenerate: true };
    const m = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed });
    for (const f of [m.perimeterM, m.gravelius, m.formFactor, m.elongation, m.circularity, m.basinLengthM, m.hypsometry]) {
      expect(f).toEqual({ withheld: 'too-small' });
    }
  });

  it('withholds the hypsometric curve on a flat catchment', () => {
    const { grid, mask, outlet } = rectangle();
    (grid.z as Float64Array).fill(5);
    const divide = traceDivide(grid, mask);
    const m = catchmentMorphometrics({ grid, mask, outlet, divide, ...closed });
    expect(m.hypsometry).toEqual({ withheld: 'not-applicable' });
    expect(valueOf(m.reliefM)).toBe(0);
  });
});
