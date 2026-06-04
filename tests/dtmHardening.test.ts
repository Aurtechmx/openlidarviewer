/**
 * dtmHardening.test.ts — outlier despike + slope/distance-limited void fill.
 */

import { describe, it, expect } from 'vitest';
import { findSpikes, removeSpikes } from '../src/terrain/ground/despike';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import type { DemRaster } from '../src/terrain/ground/rasterizeDtm';

describe('despike — robust local outlier rejection', () => {
  it('flags a single spike in an otherwise flat field, and nothing else', () => {
    const cols = 5, rows = 5;
    const z = new Float32Array(cols * rows).fill(10);
    const had = new Uint8Array(cols * rows).fill(1);
    z[12] = 50; // centre spike
    const spikes = findSpikes(z, had, cols, rows);
    expect(spikes[12]).toBe(1);
    expect(Array.from(spikes).reduce((a, b) => a + b, 0)).toBe(1);

    const cleaned = removeSpikes(z, had, cols, rows);
    expect(cleaned.removed).toBe(1);
    expect(cleaned.hadData[12]).toBe(0);
    expect(Number.isNaN(cleaned.z[12])).toBe(true);
  });

  it('does not flag a smooth gradient', () => {
    const cols = 5, rows = 5;
    const z = new Float32Array(cols * rows);
    const had = new Uint8Array(cols * rows).fill(1);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = r + c; // planar
    const spikes = findSpikes(z, had, cols, rows);
    expect(Array.from(spikes).reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('respects the absolute minimum-deviation floor', () => {
    const cols = 5, rows = 5;
    const z = new Float32Array(cols * rows).fill(10);
    const had = new Uint8Array(cols * rows).fill(1);
    z[12] = 10.01; // 1 cm — below the 5 cm floor
    expect(findSpikes(z, had, cols, rows)[12]).toBe(0);
  });

  it('a conservative floor keeps a small real feature but removes a gross blunder', () => {
    const cols = 5, rows = 5;
    const had = new Uint8Array(cols * rows).fill(1);
    // 10 cm step in flat terrain — a real curb, not a blunder.
    const feature = new Float32Array(cols * rows).fill(10);
    feature[12] = 10.1;
    expect(findSpikes(feature, had, cols, rows, { minDeviationM: 0.3 })[12]).toBe(0);
    // 5 m spike — a clear blunder.
    const blunder = new Float32Array(cols * rows).fill(10);
    blunder[12] = 15;
    expect(findSpikes(blunder, had, cols, rows, { minDeviationM: 0.3 })[12]).toBe(1);
  });
});

function raster(z: number[], counts: number[], cols: number, rows: number): DemRaster {
  return {
    z: Float32Array.from(z.map((v) => (Number.isFinite(v) ? v : NaN))),
    counts: Uint32Array.from(counts),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    coverage: 'full',
    sourcePointCount: counts.reduce((a, b) => a + b, 0),
    analyzedPointCount: counts.reduce((a, b) => a + b, 0),
    filledCellCount: counts.filter((c) => c > 0).length,
    warnings: [],
  };
}

describe('buildDtmGrid — distance-limited void fill (hardening)', () => {
  // A 1×5 strip: measured at both ends, three empty cells between. The middle
  // cell is 2 cells from the nearest data; the two flanking it are 1 cell away.
  const r = raster([10, NaN, NaN, NaN, 10], [4, 0, 0, 0, 4], 5, 1);

  it('interpolates every reachable cell with no limit (default)', () => {
    const g = buildDtmGrid(r, {});
    // cells 1..3 are interpolated (coverage 1).
    expect(Array.from(g.coverage)).toEqual([2, 1, 1, 1, 2]);
  });

  it('withholds cells beyond maxInterpDistanceCells as genuine gaps', () => {
    const g = buildDtmGrid(r, { maxInterpDistanceCells: 1 });
    // the middle cell (distance 2) is withheld → coverage 0; the flanks stay.
    expect(g.coverage[2]).toBe(0);
    expect(g.confidence[2]).toBe(0);
    expect(g.coverage[1]).toBe(1);
    expect(g.coverage[3]).toBe(1);
    // measured cells untouched.
    expect(g.coverage[0]).toBe(2);
    expect(g.coverage[4]).toBe(2);
  });
});
