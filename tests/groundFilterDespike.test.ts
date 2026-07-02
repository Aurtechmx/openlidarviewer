/**
 * groundFilterDespike.test.ts — the floorPercentile despike must stop a
 * gross below-ground blunder from seeding a false low ground surface.
 */

import { describe, it, expect } from 'vitest';
import { classifyGroundSmrf, type GroundFilterParams } from '../src/terrain/ground/groundFilter';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

// 25 clean ground returns at z=0 plus one z=-50 blunder, all inside a
// single large cell.
function scene(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) pts.push({ x, y, z: 0 });
  pts.push({ x: 2, y: 2, z: -50 }); // blunder
  return pts;
}

const base: GroundFilterParams = {
  cellSizeM: 10, // one cell
  maxWindowCells: 1,
  slope: 0.2,
  elevationThresholdM: 0.5,
};

describe('floorPercentile despike', () => {
  it('strict min (floorPercentile 0) is dragged down by the blunder', () => {
    const r = classifyGroundSmrf(scene(), { ...base, floorPercentile: 0 });
    expect(r.groundSurface[0]).toBe(-50);
  });

  it('a low-percentile floor ignores the lone blunder', () => {
    const r = classifyGroundSmrf(scene(), { ...base, floorPercentile: 10 });
    expect(r.groundSurface[0]).toBeGreaterThan(-1);
    expect(r.groundSurface[0]).toBeLessThan(1); // ~0, the real ground
  });

  it('fires even for small cells (n = 20, q = 5%): the lone blunder is skipped', () => {
    // 19 clean returns at z=0 plus one −50 blunder in ONE cell. Nearest rank
    // alone: ceil(0.05·20)−1 = 0 → the blunder wins (the audit's inert-despike
    // finding). The documented guarantee — skip at least the single lowest
    // return once n ≥ 3 — takes sorted[1] = 0, the real ground.
    const pts: TerrainPoint[] = [];
    for (let i = 0; i < 19; i++) pts.push({ x: (i % 5) + 0.1, y: Math.floor(i / 5) + 0.1, z: 0 });
    pts.push({ x: 2, y: 2, z: -50 });
    const r = classifyGroundSmrf(pts, { ...base, floorPercentile: 5 });
    expect(r.groundSurface[0]).toBe(0);
  });

  it('keeps the strict minimum for 2-return cells (no evidence to reject either)', () => {
    // Two returns in one cell: n < 3, so the despike floor must NOT skip the
    // lower one — with only two samples neither can be called a blunder.
    const pts: TerrainPoint[] = [
      { x: 1, y: 1, z: 5 },
      { x: 2, y: 2, z: 7 },
    ];
    const r = classifyGroundSmrf(pts, { ...base, floorPercentile: 5 });
    expect(r.groundSurface[0]).toBe(5);
  });

  it('does not change single-return cells (percentile of one value = that value)', () => {
    const pts: TerrainPoint[] = [
      { x: 0, y: 0, z: 3 },
      { x: 5, y: 5, z: 7 },
    ];
    const r = classifyGroundSmrf(pts, { ...base, cellSizeM: 1, floorPercentile: 10 });
    // Both returns are ground (each alone in its cell).
    expect(r.groundPointCount).toBe(2);
  });
});
