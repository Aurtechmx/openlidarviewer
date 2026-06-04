import { describe, it, expect } from 'vitest';
import { sampleTerrain, type SampleableTerrain } from '../src/terrain/contour/sampleTerrain';

// A 2×2 grid. Cell layout (row-major): index = row*cols + col.
//   (0,0)=idx0  (1,0)=idx1
//   (0,1)=idx2  (1,1)=idx3
function fixture(): SampleableTerrain {
  return {
    dtm: {
      cols: 2,
      rows: 2,
      z: [100, 110, 120, 130],
      coverage: [2, 2, 0, 1], // idx2 is empty
    },
    surface: {
      relief: { slope: [0, Math.tan((45 * Math.PI) / 180), 0, 0] }, // idx1 = 45°
      canopy: { heightM: [0, 5, NaN, 2] },
    },
  };
}

describe('sampleTerrain', () => {
  it('reads elevation, slope (deg) and canopy at a covered cell', () => {
    const s = sampleTerrain(fixture(), 1, 0); // idx1
    expect(s).not.toBeNull();
    expect(s!.covered).toBe(true);
    expect(s!.elevationM).toBe(110);
    expect(s!.slopeDeg).toBeCloseTo(45, 4);
    expect(s!.canopyM).toBe(5);
  });

  it('reports an uncovered cell with NaN elevation/slope', () => {
    const s = sampleTerrain(fixture(), 0, 1); // idx2, coverage 0
    expect(s).not.toBeNull();
    expect(s!.covered).toBe(false);
    expect(Number.isNaN(s!.elevationM)).toBe(true);
    expect(Number.isNaN(s!.slopeDeg)).toBe(true);
  });

  it('returns flat (0°) slope and zero canopy correctly', () => {
    const s = sampleTerrain(fixture(), 0, 0); // idx0
    expect(s!.elevationM).toBe(100);
    expect(s!.slopeDeg).toBeCloseTo(0, 6);
    expect(s!.canopyM).toBe(0);
  });

  it('returns null outside the grid bounds', () => {
    const t = fixture();
    expect(sampleTerrain(t, -1, 0)).toBeNull();
    expect(sampleTerrain(t, 2, 0)).toBeNull();
    expect(sampleTerrain(t, 0, 2)).toBeNull();
  });
});
