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
    // Triggered by an ORIGIN OFFSET — an indicative case where the numbers
    // still print with a caveat. This test previously used a CRS mismatch as
    // the trigger and asserted the numbers printed anyway; a PROVEN mismatch
    // now refuses them (see the frame-incompatibility suite below).
    const a = grid([1, 1], 2, 1);
    const b = grid([2, 2], 2, 1, { originH1: 10 });
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
    const a = grid([1, 1], 2, 1);
    const b = grid([2, 2], 2, 1, { originH1: 10 });
    const lines = summarizeChange(compareDtms(a, b));
    const checklist = lines.find((l) => /Needs for a measured result/.test(l));
    expect(checklist).toBeDefined();
    expect(checklist).toMatch(/CRS/);
    expect(checklist).toMatch(/datum/);
    expect(checklist).toMatch(/units/);
    expect(checklist).toMatch(/ground control/);
  });
});

/**
 * A PROVEN frame mismatch is refused, not annotated.
 *
 * The preflight already diagnosed a differing horizontal CRS or vertical datum,
 * but the numeric comparison ran anyway and the numbers shipped with a caveat
 * attached. "Indicative" is the right posture for an UNKNOWN frame; a proven
 * mismatch is different in kind — a Δz between UTM 12N and 13N, or between
 * NAVD88 and ellipsoidal heights, describes nothing, and a warning under a
 * confident number does not make the number meaningful.
 */
describe('compareDtms — a proven frame mismatch refuses the numbers', () => {
  const flat = [1, 1, 1, 1];

  it('flags a differing horizontal CRS as frame-incompatible', () => {
    const cmp = compareDtms(grid(flat, 2, 2), grid(flat, 2, 2, { crs: 'EPSG:32613' }));
    expect(cmp.frameIncompatible).toBe(true);
  });

  it('flags a differing vertical datum as frame-incompatible', () => {
    const cmp = compareDtms(
      grid(flat, 2, 2, { verticalDatum: 'NAVD88' }),
      grid(flat, 2, 2, { verticalDatum: 'EPSG:4979' }),
    );
    expect(cmp.frameIncompatible).toBe(true);
  });

  it('does NOT flag an unknown frame — that stays indicative, not refused', () => {
    // Refusing on absence of evidence would block the ordinary case of two
    // scans whose files simply declare nothing.
    const cmp = compareDtms(grid(flat, 2, 2, { crs: null }), grid(flat, 2, 2, { crs: null }));
    expect(cmp.frameIncompatible).toBe(false);
  });

  it('does not flag matching frames', () => {
    expect(compareDtms(grid(flat, 2, 2), grid(flat, 2, 2)).frameIncompatible).toBe(false);
  });

  it('summarizeChange leads with the refusal and withholds every number', () => {
    const cmp = compareDtms(grid(flat, 2, 2), grid(flat, 2, 2, { crs: 'EPSG:32613' }));
    const lines = summarizeChange(cmp);
    expect(lines[0]).toMatch(/not comparable/i);
    const text = lines.join('\n');
    expect(text).not.toContain('Net volume');
    expect(text).not.toContain('Largest gain');
    // The diagnosis still travels, so the user can see WHY.
    expect(text).toContain('Horizontal CRS differs');
  });

  it('summarizeChange still prints numbers for merely-unknown frames', () => {
    const cmp = compareDtms(grid(flat, 2, 2, { crs: null }), grid(flat, 2, 2, { crs: null }));
    expect(summarizeChange(cmp).join('\n')).toContain('Net volume');
  });
});
