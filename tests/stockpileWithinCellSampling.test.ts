/**
 * What area weighting does and does not remove.
 *
 * Each cell contributes its area times the median height of the points in it,
 * so a dense cell weighs no more than a sparse one. That removes unequal
 * weighting BETWEEN cells. It does not make a cell's median equal the cell's
 * area-average height: where the surface varies inside a cell, where in the
 * cell the points fall moves the median, and so the volume.
 *
 * The register's claim says exactly that (STOCKPILE-VOLUME scope). These cases
 * pin it on surface z = x over a 16 m square above a zero base, whose exact
 * volume is 2048 m³, with four points in every 2 m cell.
 */
import { describe, expect, it } from 'vitest';
import { stockpileAreaGrid, type AreaGridPoint } from '../src/render/measure/stockpileAreaGrid';

const S = 16;
const EXACT = (S * S * S) / 2; // ∫∫ x dx dy over [0,16]²
const square = (x0: number, x1: number) => [
  { x: x0, y: x0 },
  { x: x1, y: x0 },
  { x: x1, y: x1 },
  { x: x0, y: x1 },
];
const base = { kind: 'constant', zM: 0 } as const;

/** Four points per 2 m cell at x offsets `dx` from the cell's west edge, on `surface`. */
function perCell(dx: readonly number[], surface: (x: number, y: number) => number): AreaGridPoint[] {
  const out: AreaGridPoint[] = [];
  for (let cx = 0; cx < S; cx += 2) {
    for (let cy = 0; cy < S; cy += 2) {
      dx.forEach((d, i) => {
        const x = cx + d;
        const y = cy + (i % 2 ? 1.5 : 0.5);
        out.push({ x, y, z: surface(x, y) });
      });
    }
  }
  return out;
}

const volume = (points: AreaGridPoint[], cellSizeM?: number, polygon = square(0, S)) =>
  stockpileAreaGrid({ points, polygon, base, ...(cellSizeM ? { cellSizeM } : {}) } as Parameters<typeof stockpileAreaGrid>[0]);

const ramp = (x: number) => x;
const SYMMETRIC = [0.25, 0.75, 1.25, 1.75];
const LOW_SIDE = [0.25, 0.25, 0.75, 1.75]; // same count per cell, shifted west

describe('within-cell sampling on a surface that varies inside a cell', () => {
  it('2 m cells: symmetric samples give the exact volume', () => {
    const r = volume(perCell(SYMMETRIC, ramp), 2);
    expect(r.coverage).toBe('measured');
    expect(r.fillM3).toBeCloseTo(EXACT, 9);
  });

  it('2 m cells: the same number of samples shifted to the low side gives -6.25 %, the median offset times the area', () => {
    // Median of offsets 0.25, 0.25, 0.75, 1.75 is 0.5; the cell centre is 1.0.
    // Each cell reads 0.5 m low over 4 m², 64 cells: 2048 − 128 = 1920.
    const r = volume(perCell(LOW_SIDE, ramp), 2);
    expect(r.coverage).toBe('measured');
    expect(r.fillM3).toBeCloseTo(EXACT - 0.5 * S * S, 9);
  });

  it('default cell size: the two samplings disagree although both cover every cell', () => {
    const sym = volume(perCell(SYMMETRIC, ramp));
    const low = volume(perCell(LOW_SIDE, ramp));
    expect(sym.coverage).toBe('measured');
    expect(low.coverage).toBe('measured');
    expect(Math.abs(sym.fillM3 - EXACT) / EXACT).toBeLessThan(0.001);
    expect(Math.abs(low.fillM3 - sym.fillM3) / EXACT).toBeGreaterThan(0.005);
  });

  it('a smooth density gradient (more points to the east) biases the volume upward', () => {
    // Point x positions follow a density proportional to 1 + x on each row.
    const points: AreaGridPoint[] = [];
    const perRow = 400;
    const total = S + (S * S) / 2; // ∫ (1 + x) dx over [0, 16]
    for (let row = 0; row < 32; row++) {
      const y = (row + 0.5) * (S / 32);
      for (let k = 0; k < perRow; k++) {
        const u = ((k + 0.5) / perRow) * total; // inverse CDF of 1 + x
        const x = -1 + Math.sqrt(1 + 2 * u);
        points.push({ x, y, z: ramp(x) });
      }
    }
    const r = volume(points, 2);
    expect(r.coverage).toBe('measured');
    expect(r.fillM3).toBeGreaterThan(EXACT);
    expect(r.fillM3).toBeLessThan(EXACT * 1.05);
  });
});

describe('where area weighting does remove density effects', () => {
  const flat = () => 4;

  it('a surface flat inside each cell: clustered samples give the exact volume', () => {
    const r = volume(perCell(LOW_SIDE, flat), 2);
    expect(r.fillM3).toBeCloseTo(4 * S * S, 9);
  });

  it('boundary cells clipped by a footprint off the grid: exact on a flat surface', () => {
    const points = perCell(SYMMETRIC, flat);
    const r = volume(points, 2, square(0.3, 15.7));
    expect(r.fillM3).toBeCloseTo(4 * 15.4 * 15.4, 6);
  });
});
