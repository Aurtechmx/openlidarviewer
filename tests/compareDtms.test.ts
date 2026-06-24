/**
 * compareDtms.test.ts — the DTM→change bridge plus the co-registration check
 * the bare change core can't do (world origin, CRS, vertical datum). No DOM.
 */

import { describe, it, expect } from 'vitest';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { dtmToChangeGrid, compareDtms, summarizeChange } from '../src/terrain/change/compareDtms';

/** Build a small DtmGrid from a row-major height array; empty cells are NaN. */
function grid(
  heights: number[],
  cols: number,
  rows: number,
  over: Partial<DtmGrid> = {},
): DtmGrid {
  const n = cols * rows;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = heights[i];
    if (Number.isNaN(h)) {
      coverage[i] = 0;
    } else {
      z[i] = h;
      coverage[i] = 1;
    }
  }
  return {
    z,
    confidence: new Float32Array(n).fill(100),
    coverage,
    counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n),
    cols,
    rows,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    crs: 'EPSG:32612',
    verticalDatum: 'EPSG:5703',
    coverageMode: 'full',
    sourcePointCount: n,
    analyzedPointCount: n,
    meanConfidence: 100,
    warnings: [],
    ...over,
  };
}

describe('dtmToChangeGrid', () => {
  it('carries empty (coverage 0) cells as NaN, heights elsewhere', () => {
    const dtm = grid([1, NaN, 3, 4], 2, 2);
    const cg = dtmToChangeGrid(dtm);
    expect(cg.width).toBe(2);
    expect(cg.height).toBe(2);
    expect(cg.cellSizeM).toBe(1);
    expect(cg.values[0]).toBe(1);
    expect(Number.isNaN(cg.values[1])).toBe(true);
    expect(cg.values[2]).toBe(3);
  });
});

describe('compareDtms', () => {
  it('a raised surface yields a positive net volume and co-registers cleanly', () => {
    const a = grid([1, 1, 1, 1], 2, 2);
    const b = grid([2, 2, 2, 2], 2, 2); // +1 m everywhere
    const cmp = compareDtms(a, b);
    expect(cmp.coregistered).toBe(true);
    expect(cmp.coregistrationNotes).toEqual([]);
    expect(cmp.result.stats.netVolumeM3).toBeCloseTo(4, 5); // 1 m × 4 cells × 1 m²
    expect(cmp.result.stats.gained).toBe(4);
  });

  it('flags a world-origin offset as not co-registered', () => {
    const a = grid([1, 1, 1, 1], 2, 2, { originH1: 0 });
    const b = grid([2, 2, 2, 2], 2, 2, { originH1: 50 }); // 50 m east — far beyond half a cell
    const cmp = compareDtms(a, b);
    expect(cmp.coregistered).toBe(false);
    expect(cmp.coregistrationNotes.join(' ')).toContain('offset');
  });

  it('flags a differing horizontal CRS', () => {
    const a = grid([1, 1], 2, 1, { crs: 'EPSG:32612' });
    const b = grid([2, 2], 2, 1, { crs: 'EPSG:32613' });
    const cmp = compareDtms(a, b);
    expect(cmp.coregistered).toBe(false);
    expect(cmp.coregistrationNotes.join(' ')).toContain('CRS differs');
  });

  it('flags a differing vertical datum', () => {
    const a = grid([1, 1], 2, 1, { verticalDatum: 'EPSG:5703' });
    const b = grid([2, 2], 2, 1, { verticalDatum: 'EPSG:5701' });
    const cmp = compareDtms(a, b);
    expect(cmp.coregistered).toBe(false);
    expect(cmp.coregistrationNotes.join(' ')).toContain('Vertical datum differs');
  });

  it('cautions when a horizontal CRS is unknown (cannot verify a shared frame)', () => {
    const a = grid([1, 1], 2, 1, { crs: null });
    const b = grid([2, 2], 2, 1); // default known CRS
    const cmp = compareDtms(a, b);
    expect(cmp.coregistered).toBe(false);
    expect(cmp.coregistrationNotes.join(' ')).toMatch(/CRS is unknown/i);
  });

  it('cautions when a vertical datum is unknown', () => {
    const a = grid([1, 1], 2, 1, { verticalDatum: null });
    const b = grid([2, 2], 2, 1); // default known datum
    const cmp = compareDtms(a, b);
    expect(cmp.coregistered).toBe(false);
    expect(cmp.coregistrationNotes.join(' ')).toMatch(/datum is unknown/i);
  });

  it('a mismatched raster is not co-registered (different cell size)', () => {
    const a = grid([1, 1, 1, 1], 2, 2, { cellSizeM: 1 });
    const b = grid([2, 2, 2, 2], 2, 2, { cellSizeM: 2 });
    const cmp = compareDtms(a, b);
    expect(cmp.result.aligned).toBe(false);
    expect(cmp.coregistered).toBe(false);
  });
});

describe('summarizeChange', () => {
  it('leads with the not-co-registered warning when alignment fails', () => {
    const a = grid([1, 1], 2, 1, { crs: 'EPSG:32612' });
    const b = grid([2, 2], 2, 1, { crs: 'EPSG:32613' });
    const lines = summarizeChange(compareDtms(a, b));
    expect(lines[0]).toContain('Not co-registered');
    expect(lines.some((l) => l.includes('Net volume change'))).toBe(true);
  });

  it('omits the warning and reports volumes when fully aligned', () => {
    const a = grid([1, 1, 1, 1], 2, 2);
    const b = grid([2, 2, 2, 2], 2, 2);
    const lines = summarizeChange(compareDtms(a, b));
    expect(lines[0]).toContain('Net volume change');
    // No co-registration checklist when the comparison IS co-registered.
    expect(lines.some((l) => /Needs for a measured result/.test(l))).toBe(false);
  });

  it('spells out the co-registration checklist when not co-registered', () => {
    const a = grid([1, 1], 2, 1, { crs: 'EPSG:32612' });
    const b = grid([2, 2], 2, 1, { crs: 'EPSG:32613' });
    const lines = summarizeChange(compareDtms(a, b));
    const checklist = lines.find((l) => /Needs for a measured result/.test(l));
    expect(checklist).toBeDefined();
    expect(checklist).toMatch(/CRS/);
    expect(checklist).toMatch(/datum/);
    expect(checklist).toMatch(/units/);
    expect(checklist).toMatch(/ground control/);
  });
});
