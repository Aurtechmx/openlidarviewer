/**
 * The fitness "Classification" row and the QA "Terrain readiness" check must
 * agree on whether ground (ASPRS class 2) was provided by the file.
 */
import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { providedGroundClass } from '../src/ui/AnalysePanel';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

function plane(): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 30; x += 1) for (let y = 0; y <= 30; y += 1) pts.push({ x, y, z: 0.1 * x });
  return pts;
}

describe('providedGroundClass', () => {
  it('reports class 2 present on a file tile with classes 1 and 2 and no vegetation, buildings or noise', () => {
    const pts = plane();
    const cls = new Uint8Array(pts.length).map((_, i) => (i % 3 === 0 ? 1 : 2));
    const r = analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', classification: cls });
    expect(r.excludedByClassification).toBe(0);
    expect(r.groundClassPresent).toBe(true);
    expect(providedGroundClass(r, 'source')).toBe(true);
  });

  it('does not call derived class 2 provided', () => {
    const pts = plane();
    const cls = new Uint8Array(pts.length).fill(2);
    const r = analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', classification: cls });
    expect(providedGroundClass(r, 'derived')).toBe(false);
  });

  it('reports no ground class when the file has codes but no class 2', () => {
    const pts = plane();
    const cls = new Uint8Array(pts.length).map((_, i) => (i % 10 === 0 ? 7 : 1));
    const r = analyseContours(pts, { cellSizeM: 2, crs: 'EPSG:32610', classification: cls });
    expect(r.excludedByClassification).toBeGreaterThan(0);
    expect(r.groundClassPresent).toBe(false);
    expect(providedGroundClass(r, 'source')).toBe(false);
  });
});
