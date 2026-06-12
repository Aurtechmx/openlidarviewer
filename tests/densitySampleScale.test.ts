/**
 * densitySampleScale.test.ts — the strided-gather density honesty path.
 *
 * `gatherTerrainPositions` strides huge clouds before analysis, so per-cell
 * counts see only the subsample. `TerrainCoreParams.samplePointScale`
 * (totalPoints / sampledPoints) must scale the densities — and the USGS QL
 * graded from them — back to the SCAN. Magnitude test: a known-density
 * synthetic cloud pushed through the strided path must report (approximately)
 * its true density, and exactly N× the unscaled run.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';

/** Gently sloped plane sampled at exactly 4 pts/m² (0.5 m grid) over 30×30 m. */
function densePlane(): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < 30; x += 0.5) {
    for (let y = 0; y < 30; y += 0.5) {
      // Mild slope so the pipeline has real relief to work with; z stays
      // smooth so despike removes nothing and the surface is fully measured.
      pts.push(x, y, 0.02 * x + 0.01 * y);
    }
  }
  return Float32Array.from(pts);
}

/** Every `stride`-th point — the same uniform subsample the gather takes. */
function strided(full: Float32Array, stride: number): Float32Array {
  const n = full.length / 3;
  const out: number[] = [];
  for (let i = 0; i < n; i += stride) {
    out.push(full[i * 3], full[i * 3 + 1], full[i * 3 + 2]);
  }
  return Float32Array.from(out);
}

describe('samplePointScale through the terrain pipeline', () => {
  const full = densePlane(); // 3600 points, 4 pts/m² by construction
  const CELL = 2; // 2 m cells → 16 pts/cell when unstrided

  it('full-resolution run measures ≈ the constructed 4 pts/m²', () => {
    const r = analyseContours(full, { cellSizeM: CELL, crs: 'EPSG:32611' });
    expect(r.cellMetrics.meanDensity).toBeGreaterThan(3.4);
    expect(r.cellMetrics.meanDensity).toBeLessThan(4.4);
  });

  it('a stride-4 subsample with samplePointScale=4 reports the SCAN density', () => {
    const quarter = strided(full, 4); // 900 points reach the analysis
    const unscaled = analyseContours(quarter, { cellSizeM: CELL, crs: 'EPSG:32611' });
    const scaled = analyseContours(quarter, {
      cellSizeM: CELL,
      crs: 'EPSG:32611',
      samplePointScale: 4,
    });
    // Exactly 4× the unscaled figure (same cells, same counts, scaled once)…
    expect(scaled.cellMetrics.meanDensity).toBeCloseTo(unscaled.cellMetrics.meanDensity * 4, 6);
    // …which lands back at the constructed truth.
    expect(scaled.cellMetrics.meanDensity).toBeGreaterThan(3.4);
    expect(scaled.cellMetrics.meanDensity).toBeLessThan(4.4);
  });

  it('the USGS QL grade describes the scan, not the sample', () => {
    // At 4 pts/m² the cloud clears QL2's ≥ 2 pts/m² density bar; the stride-4
    // subsample alone (≈ 1 pt/m²) does not. With the scale the QL judgment
    // must match the full-resolution run's density basis.
    const quarter = strided(full, 4);
    const unscaled = analyseContours(quarter, { cellSizeM: CELL, crs: 'EPSG:32611' });
    const scaled = analyseContours(quarter, {
      cellSizeM: CELL,
      crs: 'EPSG:32611',
      samplePointScale: 4,
    });
    expect(unscaled.accuracyStandards.pointDensityPerM2).toBeLessThan(2);
    expect(scaled.accuracyStandards.pointDensityPerM2).toBeGreaterThan(2);
  });

  it('determinism: the same strided input + scale twice → identical summaries', () => {
    const quarter = strided(full, 4);
    const a = analyseContours(quarter, { cellSizeM: CELL, crs: 'EPSG:32611', samplePointScale: 4 });
    const b = analyseContours(quarter, { cellSizeM: CELL, crs: 'EPSG:32611', samplePointScale: 4 });
    expect(a.cellMetrics).toEqual(b.cellMetrics);
    expect(a.validation.rmse).toBe(b.validation.rmse);
  });
});
