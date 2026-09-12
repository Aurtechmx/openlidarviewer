/**
 * kernelRefusals.test.ts — the reusable scientific kernel refuses impossible
 * specifications and unequal inputs instead of repairing or truncating them.
 *
 * Every function here used to answer: a bad cell size became 1, a percentile
 * was clamped, a malformed SMRF parameter was replaced by a default under a
 * warning, and two evaluation kernels scored the SHORTER of two arrays, so a
 * defective implementation that produced 90,000 of 100,000 cells was graded
 * over the 90,000 it produced. A warning beside a number is not a refusal.
 */

import { describe, it, expect } from 'vitest';
import { gridErrorStats } from '../src/validation/terrainMetrics';
import { scoreScene } from '../src/validation/classifierCorpus';
import { buildDsm, heightAboveGround } from '../src/terrain/surface/buildDsm';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { classifyGroundSmrf } from '../src/terrain/ground/groundFilter';
import { writeAsciiGrid } from '../src/terrain/export/demAsciiGrid';

const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }];

describe('evaluation kernels refuse unequal arrays', () => {
  it('gridErrorStats does not score the shorter of two grids', () => {
    expect(() => gridErrorStats(new Float32Array(9), new Float32Array(10))).toThrow(/length mismatch/);
    // Equal lengths still score.
    expect(gridErrorStats(new Float32Array(4), new Float32Array(4)).n).toBe(4);
  });

  it('scoreScene does not score the labelled prefix of a scene', () => {
    expect(() => scoreScene('s', new Uint8Array([2, 2, 5]), new Uint8Array([2, 2]))).toThrow(/length mismatch/);
  });
});

describe('surface primitives refuse impossible specifications', () => {
  it('buildDsm refuses a non-positive cell size instead of substituting 1', () => {
    expect(() => buildDsm(pts, { grid: { originH1: 0, originH2: 0, cols: 2, rows: 2, cellSizeM: 0 } } as never))
      .toThrow(/cellSizeM/);
  });

  it('heightAboveGround refuses a DTM of a different size', () => {
    const dsm = { z: new Float32Array(4), coverage: new Uint8Array(4).fill(1), cols: 2, rows: 2 } as never;
    expect(() => heightAboveGround(dsm, new Float32Array(3), new Uint8Array(4)))
      .toThrow(/length mismatch/);
  });

  it('rasterizeDtm refuses a bad cell size and an out-of-range percentile', () => {
    const grid = { originH1: 0, originH2: 0, cols: 2, rows: 2, cellSizeM: -1 };
    expect(() => rasterizeDtm(pts, new Uint8Array(4).fill(1), { grid, aggregation: 'mean' } as never))
      .toThrow(/cellSizeM/);
    expect(() => rasterizeDtm(pts, new Uint8Array(4).fill(1), {
      grid: { ...grid, cellSizeM: 1 }, aggregation: 'percentile', percentile: 1.5,
    } as never)).toThrow(/percentile/);
  });

  it('classifyGroundSmrf refuses a malformed parameter instead of substituting a default', () => {
    const base = { cellSizeM: 1, maxWindowCells: 4, slope: 0.15, elevationThresholdM: 0.5 };
    expect(() => classifyGroundSmrf(pts, { ...base, slope: Number.NaN } as never)).toThrow(/slope/);
    expect(() => classifyGroundSmrf(pts, { ...base, floorPercentile: 80 } as never)).toThrow(/floorPercentile/);
    expect(() => classifyGroundSmrf(pts, { ...base, openingMode: 'other' } as never)).toThrow(/openingMode/);
  });
});

describe('writeAsciiGrid validates the raster it is about to emit', () => {
  const ok = {
    values: new Float32Array([1, 2, 3, 4]), coverage: new Uint8Array([1, 1, 1, 1]),
    cols: 2, rows: 2, cellSize: 1, xllCorner: 0, yllCorner: 0,
  };
  it('emits a valid grid', () => {
    expect(writeAsciiGrid(ok as never)).toMatch(/^ncols 2\n/);
  });
  it('refuses a cols x rows that does not match the arrays', () => {
    expect(() => writeAsciiGrid({ ...ok, cols: 3 } as never)).toThrow(/3 x 2 cells/);
  });
  it('refuses a non-finite origin, a bad cell size and a bad precision', () => {
    expect(() => writeAsciiGrid({ ...ok, xllCorner: Number.NaN } as never)).toThrow(/origin/);
    expect(() => writeAsciiGrid({ ...ok, cellSize: 0 } as never)).toThrow(/cellSize/);
    expect(() => writeAsciiGrid({ ...ok, precision: -1 } as never)).toThrow(/precision/);
  });
});
