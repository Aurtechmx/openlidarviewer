/**
 * tests/densityColors.test.ts
 *
 * Coverage for the density-heatmap colour mode. Pins the cell-counting
 * pass, the perceptual ramp boundaries, and the cell-size heuristic.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  densityForChunk,
  defaultCellSizeForSpacing,
} from '../src/render/densityColors';

function pack(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    out[i * 3] = points[i][0];
    out[i * 3 + 1] = points[i][1];
    out[i * 3 + 2] = points[i][2];
  }
  return out;
}

describe('densityForChunk — voxel-grid heatmap colours', () => {
  it('returns a 3·N byte buffer matching the input point count', () => {
    const positions = pack([
      [0, 0, 0],
      [1, 1, 0],
      [2, 2, 0],
      [3, 3, 0],
    ]);
    const out = densityForChunk({ positions, cellSize: 1 });
    expect(out.colors).toBeInstanceOf(Uint8Array);
    expect(out.colors.length).toBe(4 * 3);
  });

  it('reports zero mean density on an empty chunk', () => {
    const out = densityForChunk({ positions: new Float32Array(0), cellSize: 1 });
    expect(out.colors.length).toBe(0);
    expect(out.meanDensity).toBe(0);
    expect(out.maxObservedDensity).toBe(0);
  });

  it('colours every point in the same cell identically', () => {
    // Five points crammed into the same 1m² cell — colour must be uniform.
    const positions = pack([
      [0.1, 0.1, 0],
      [0.2, 0.3, 0],
      [0.4, 0.2, 0],
      [0.5, 0.5, 0],
      [0.7, 0.7, 0],
    ]);
    const out = densityForChunk({ positions, cellSize: 1 });
    const first = [out.colors[0], out.colors[1], out.colors[2]];
    for (let i = 1; i < 5; i++) {
      expect(out.colors[i * 3]).toBe(first[0]);
      expect(out.colors[i * 3 + 1]).toBe(first[1]);
      expect(out.colors[i * 3 + 2]).toBe(first[2]);
    }
  });

  it('maps higher-density cells to hotter (brighter) colours', () => {
    // Cell A: 10 points in 1m². Cell B: 1 point in a separate 1m².
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 10; i++) pts.push([0.5, 0.5, 0]);
    pts.push([50.5, 50.5, 0]);
    const out = densityForChunk({ positions: pack(pts), cellSize: 1 });
    // First 10 points are the dense cell; last is the sparse cell.
    const denseLum = out.colors[0] + out.colors[1] + out.colors[2];
    const sparseLum = out.colors[30] + out.colors[31] + out.colors[32];
    expect(denseLum).toBeGreaterThan(sparseLum);
  });

  it('reports a maxObservedDensity equal to the densest cell', () => {
    // 8 points in one 0.5m cell (area 0.25 m² → 32 pts/m²).
    const pts: [number, number, number][] = [];
    for (let i = 0; i < 8; i++) pts.push([0, 0, 0]);
    const out = densityForChunk({ positions: pack(pts), cellSize: 0.5 });
    expect(out.maxObservedDensity).toBeCloseTo(8 / 0.25, 5);
  });

  it('honours an explicit maxDensity saturation anchor', () => {
    // With a custom hot anchor far above the data, all points should
    // map to a dim colour at the cold end of the ramp.
    const positions = pack([
      [0, 0, 0],
      [10, 10, 0],
    ]);
    const cold = densityForChunk({
      positions,
      cellSize: 1,
      maxDensity: 1e6,
    });
    // First sample of the ramp is black (R,G,B ≈ 0,0,8).
    expect(cold.colors[0]).toBeLessThan(20);
    expect(cold.colors[1]).toBeLessThan(20);
  });

  it('does not emit NaN colours when minDensity exceeds the auto saturation', () => {
    // Regression for the v0.3.7 validation finding: if the caller pushes
    // minDensity above whatever the 95th-percentile auto-anchor lands
    // on, `log1p(hot − cold)` would have been negative → NaN propagated
    // into the RGB output. The clamp to ≥ 0 keeps the output valid; the
    // visible result is the entire cloud reading as a uniform "cold" colour.
    // The swap announcement on console.warn is the fixture's expected
    // behaviour — silenced so a green run stays clean (finiteness of the
    // output is what's asserted, not the console).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const positions = pack([
      [0, 0, 0],
      [0.1, 0.1, 0],
      [0.2, 0.2, 0],
    ]);
    const out = densityForChunk({
      positions,
      cellSize: 1,
      minDensity: 1e6, // far above any plausible 95th percentile
    });
    for (let i = 0; i < out.colors.length; i++) {
      expect(Number.isFinite(out.colors[i])).toBe(true);
    }
    warnSpy.mockRestore();
  });
});

describe('defaultCellSizeForSpacing', () => {
  it('returns ~5× the spacing when finite and positive', () => {
    expect(defaultCellSizeForSpacing(0.2)).toBeCloseTo(1, 5);
    expect(defaultCellSizeForSpacing(1)).toBe(5);
  });

  it('clamps to a 5 cm floor for absurdly small spacings', () => {
    expect(defaultCellSizeForSpacing(0.0001)).toBeGreaterThanOrEqual(0.05);
  });

  it('falls back to 1 m for zero / NaN / negative inputs', () => {
    expect(defaultCellSizeForSpacing(0)).toBe(1);
    expect(defaultCellSizeForSpacing(-1)).toBe(1);
    expect(defaultCellSizeForSpacing(NaN)).toBe(1);
  });
});
