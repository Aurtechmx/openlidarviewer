/**
 * buildingFootprints.test.ts — footprint extraction on synthetic known buildings.
 */

import { describe, it, expect } from 'vitest';
import { extractBuildingFootprints, type BuildingPoint, type FootprintGrid } from '../src/features/buildingFootprints';

const GRID: FootprintGrid = { originX: 0, originY: 0, cellSizeM: 1, minPointsPerCell: 1, minAreaM2: 4 };

/** Fill an axis-aligned rectangle [x0,x1)×[y0,y1) with points at ~0.4 m spacing. */
function rect(x0: number, y0: number, x1: number, y1: number): BuildingPoint[] {
  const pts: BuildingPoint[] = [];
  for (let x = x0; x < x1; x += 0.4) for (let y = y0; y < y1; y += 0.4) pts.push({ x, y });
  return pts;
}

describe('extractBuildingFootprints', () => {
  it('finds three separated buildings with the right count, area and location', () => {
    const a = rect(0, 0, 10, 6);   // 60 m²
    const b = rect(30, 30, 40, 40); // 100 m²
    const c = rect(0, 50, 5, 55);   // 25 m²
    const fps = extractBuildingFootprints([...a, ...b, ...c], GRID);
    expect(fps.length).toBe(3);
    // Largest first (deterministic order).
    expect(fps[0].areaM2).toBeGreaterThan(fps[1].areaM2);
    // The 10×10 building's area and centroid.
    const big = fps[0];
    expect(big.areaM2).toBeGreaterThan(90);
    expect(big.areaM2).toBeLessThan(115);
    expect(big.centroidX).toBeCloseTo(35, 0);
    expect(big.centroidY).toBeCloseTo(35, 0);
  });

  it('merges an L-shaped building into one footprint (8-connectivity)', () => {
    const l = [...rect(0, 0, 12, 4), ...rect(0, 4, 4, 12)];
    const fps = extractBuildingFootprints(l, GRID);
    expect(fps.length).toBe(1);
  });

  it('drops sub-threshold noise clusters (honest: a stray point is not a building)', () => {
    const building = rect(0, 0, 10, 10);
    const noise: BuildingPoint[] = [{ x: 50, y: 50 }, { x: 51, y: 51 }]; // < minAreaM2
    const fps = extractBuildingFootprints([...building, ...noise], GRID);
    expect(fps.length).toBe(1); // only the real building survives
  });

  it('empty input and non-positive cell size yield no footprints', () => {
    expect(extractBuildingFootprints([], GRID)).toEqual([]);
    expect(extractBuildingFootprints(rect(0, 0, 5, 5), { ...GRID, cellSizeM: 0 })).toEqual([]);
  });

  it('a higher minPointsPerCell suppresses sparse (tree-like) occupancy', () => {
    // Sparse scatter: ~1 point per few cells → with minPointsPerCell 3, nothing occupies.
    const sparse: BuildingPoint[] = [];
    for (let i = 0; i < 40; i++) sparse.push({ x: i * 2, y: (i % 5) * 2 });
    expect(extractBuildingFootprints(sparse, { ...GRID, minPointsPerCell: 3 }).length).toBe(0);
  });
});
