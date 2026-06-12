/**
 * surfaceFromRaster.test.ts — the ONE shared raster→grid constructor.
 *
 * Both the live pipeline and the hold-out validation now build their surface
 * through `buildSurfaceFromRaster`, so these tests pin the construction
 * semantics once: blunder-only despike (with the 2 % cap), geodesic fill,
 * extrapolation guard, unit pass-through, determinism.
 */

import { describe, it, expect } from 'vitest';
import { buildSurfaceFromRaster } from '../src/terrain/ground/surfaceFromRaster';
import { holdoutValidateDtm } from '../src/terrain/validate/holdoutRmse';
import type { DemRaster } from '../src/terrain/ground/rasterizeDtm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** A cols×rows raster, every cell measured at `z`, with optional overrides. */
function flatRaster(cols: number, rows: number, z: number, spikes: Record<number, number> = {}): DemRaster {
  const n = cols * rows;
  const zz = new Float32Array(n).fill(z);
  const counts = new Uint32Array(n).fill(3);
  for (const [idx, v] of Object.entries(spikes)) zz[Number(idx)] = v;
  return {
    z: zz,
    counts,
    cols,
    rows,
    cellSizeM: 1,
    originH1: 0,
    originH2: 0,
    coverage: 'full',
    sourcePointCount: n * 3,
    analyzedPointCount: n * 3,
    filledCellCount: n,
    warnings: [],
  };
}

describe('buildSurfaceFromRaster', () => {
  it('removes a lone blunder cell and re-fills it near its neighbours', () => {
    // 12×12 flat plane at 10 m with one 60 m spike — a classic multipath
    // blunder. The despike must drop it; the fill brings it back ≈ 10 m.
    const idx = 5 * 12 + 5;
    const r = buildSurfaceFromRaster(flatRaster(12, 12, 10, { [idx]: 60 }));
    expect(r.despikedCellCount).toBe(1);
    expect(r.cappedOutlierCount).toBe(0);
    expect(r.raster.counts[idx]).toBe(0); // the cell lost its measured status
    expect(r.dtm.z[idx]).toBeGreaterThan(9);
    expect(r.dtm.z[idx]).toBeLessThan(11);
  });

  it('leaves a NOISY surface alone (the 2 % cap) instead of carving it up', () => {
    // 25 spikes on a 12×12 grid (≈17 % of cells) — way past the cap.
    const spikes: Record<number, number> = {};
    for (let i = 0; i < 25; i++) spikes[i * 5] = 60 + i;
    const input = flatRaster(12, 12, 10, spikes);
    const r = buildSurfaceFromRaster(input);
    expect(r.despikedCellCount).toBe(0);
    expect(r.cappedOutlierCount).toBeGreaterThan(0);
    expect(r.raster).toBe(input); // untouched input raster is passed through
    expect(r.dtm.z[0]).toBeCloseTo(60, 0); // the "spike" survived, honestly
  });

  it('is deterministic: identical inputs ⇒ identical grids', () => {
    const a = buildSurfaceFromRaster(flatRaster(8, 8, 5, { 27: 99 }));
    const b = buildSurfaceFromRaster(flatRaster(8, 8, 5, { 27: 99 }));
    expect(Array.from(a.dtm.z)).toEqual(Array.from(b.dtm.z));
    expect(Array.from(a.dtm.confidence)).toEqual(Array.from(b.dtm.confidence));
  });
});

describe('hold-out validation through the shared constructor', () => {
  // A 20×20 m flat field, 4 pts/m², z = 100, with one 80 m-low blunder point
  // dense enough to own its cell in the train split.
  function field(): { points: TerrainPoint[]; isGround: Uint8Array } {
    const points: TerrainPoint[] = [];
    for (let x = 0; x < 20; x += 0.5) {
      for (let y = 0; y < 20; y += 0.5) {
        points.push({ x, y, z: 100 });
      }
    }
    return { points, isGround: new Uint8Array(points.length).fill(1) };
  }

  it('stays deterministic for a fixed seed (calibration contract)', () => {
    const { points, isGround } = field();
    const a = holdoutValidateDtm(points, isGround, { cellSizeM: 1, seed: 7 });
    const b = holdoutValidateDtm(points, isGround, { cellSizeM: 1, seed: 7 });
    expect(a.rmse).toBe(b.rmse);
    expect(a.perBand).toEqual(b.perBand);
    expect(a.perSlopeBand).toEqual(b.perSlopeBand);
  });

  it('a flat field validates at ~zero RMSE through the unified path', () => {
    const { points, isGround } = field();
    const report = holdoutValidateDtm(points, isGround, { cellSizeM: 1, seed: 1 });
    expect(report.sampleSize).toBeGreaterThan(0);
    expect(report.rmse).toBeLessThan(0.01);
  });

  it('honours horizontalUnitToMetres (slope stratification in real metres)', () => {
    // Same geometry "in feet": with the unit scale the slope bands must still
    // classify the flat field as flat (every covered sample in the flat band).
    const { points, isGround } = field();
    const report = holdoutValidateDtm(points, isGround, {
      cellSizeM: 1,
      seed: 1,
      horizontalUnitToMetres: 0.3048,
      verticalUnitToMetres: 0.3048,
    });
    const flat = report.perSlopeBand?.find((b) => b.band === 'flat');
    expect(flat?.count).toBe(report.sampleSize);
  });
});
