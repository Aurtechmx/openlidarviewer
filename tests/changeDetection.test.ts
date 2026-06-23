/**
 * changeDetection.test.ts
 *
 * Pins the two-epoch DTM change engine: signed difference, Level-of-Detection
 * thresholding, thresholded cut/fill volumes, incomparable (empty) cells, and
 * the co-registration honesty flags.
 */

import { describe, it, expect } from 'vitest';
import { detectChange, type ChangeGrid } from '../src/terrain/change/changeDetection';

function grid(width: number, height: number, cellSizeM: number, fill: number | number[]): ChangeGrid {
  const values = new Float32Array(width * height);
  if (Array.isArray(fill)) values.set(fill);
  else values.fill(fill);
  return { width, height, cellSizeM, values };
}

describe('detectChange — basics', () => {
  it('uniform +1 m gain over a 3×3, 2 m grid', () => {
    const r = detectChange(grid(3, 3, 2, 0), grid(3, 3, 2, 1));
    expect(r.aligned).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(r.stats.comparable).toBe(9);
    expect(r.stats.gained).toBe(9);
    expect(r.stats.lost).toBe(0);
    expect(r.stats.significantFraction).toBe(1);
    // 9 cells × 1 m × (2 m)² = 36 m³.
    expect(r.stats.gainVolumeM3).toBe(36);
    expect(r.stats.netVolumeM3).toBe(36);
    expect(r.stats.maxGainM).toBe(1);
    expect(r.stats.meanAbsChangeM).toBe(1);
    expect(Array.from(r.classes)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('erosion (b < a) reports loss and a negative net', () => {
    const r = detectChange(grid(2, 2, 1, 5), grid(2, 2, 1, 3));
    expect(r.stats.lost).toBe(4);
    expect(r.stats.lossVolumeM3).toBe(8); // 4 cells × 2 m × 1 m²
    expect(r.stats.netVolumeM3).toBe(-8);
    expect(r.stats.maxLossM).toBe(-2);
  });

  it('mixed gain + loss → net = gain − loss', () => {
    // left column +2, right column −1, 2×1 grid, 1 m cells.
    const r = detectChange(grid(2, 1, 1, [0, 0]), grid(2, 1, 1, [2, -1]));
    expect(r.stats.gained).toBe(1);
    expect(r.stats.lost).toBe(1);
    expect(r.stats.gainVolumeM3).toBe(2);
    expect(r.stats.lossVolumeM3).toBe(1);
    expect(r.stats.netVolumeM3).toBe(1);
  });

  it('foot CRS: cut/fill is metres³ and Δz is metres, not source units', () => {
    // Same accretion as the basic test but the grid is in FEET: cellSizeM and
    // values are source units. Without the unit factor a foot scan over-reports
    // ~35.3× (0.3048³). With it, volume = (cells × Δz_m × cellArea_m²).
    const FT = 0.3048;
    const r = detectChange(grid(3, 3, 2, 0), grid(3, 3, 2, 1), {
      horizontalUnitToMetres: FT,
      verticalUnitToMetres: FT,
    });
    // 9 cells, Δz = 1 ft = 0.3048 m, cell area = (2 ft·0.3048)² = 0.6096² m².
    const expected = 9 * (1 * FT) * (2 * FT) * (2 * FT);
    expect(r.stats.gainVolumeM3).toBeCloseTo(expected, 6);
    expect(r.stats.maxGainM).toBeCloseTo(FT, 6); // largest gain in metres, not 1
    // The metre-factor (default 1) result is exactly 35.3× larger.
    const metric = detectChange(grid(3, 3, 2, 0), grid(3, 3, 2, 1));
    expect(metric.stats.gainVolumeM3 / r.stats.gainVolumeM3).toBeCloseTo(1 / (FT * FT * FT), 4);
  });

  it('defaults to metre behaviour when no unit factor is given (backward compatible)', () => {
    const r = detectChange(grid(2, 2, 1, 0), grid(2, 2, 1, 1));
    expect(r.stats.gainVolumeM3).toBe(4); // unchanged from before the unit-factor change
  });
});

describe('detectChange — Level of Detection', () => {
  it('sub-LoD differences are NO CHANGE and contribute no volume', () => {
    const r = detectChange(grid(2, 2, 1, 0), grid(2, 2, 1, 0.05), { levelOfDetectionM: 0.1 });
    expect(r.stats.gained).toBe(0);
    expect(r.stats.unchanged).toBe(4);
    expect(r.stats.gainVolumeM3).toBe(0); // thresholded out as noise
    expect(r.stats.significantFraction).toBe(0);
  });

  it('above-LoD differences are counted', () => {
    const r = detectChange(grid(1, 1, 1, 0), grid(1, 1, 1, 0.5), { levelOfDetectionM: 0.1 });
    expect(r.stats.gained).toBe(1);
    expect(r.stats.gainVolumeM3).toBe(0.5);
  });
});

describe('detectChange — incomparable cells', () => {
  it('a cell empty in either epoch is NaN diff, class 0, and not counted', () => {
    const a = grid(2, 1, 1, [0, NaN]);
    const b = grid(2, 1, 1, [1, 1]);
    const r = detectChange(a, b);
    expect(r.stats.comparable).toBe(1);
    expect(Number.isNaN(r.diff[1])).toBe(true);
    expect(r.classes[1]).toBe(0);
  });

  it('all-empty overlap warns and reports zero stats', () => {
    const r = detectChange(grid(1, 1, 1, NaN), grid(1, 1, 1, NaN));
    expect(r.stats.comparable).toBe(0);
    expect(r.warnings.some((w) => /nothing to compare/i.test(w))).toBe(true);
  });
});

describe('detectChange — co-registration honesty', () => {
  it('different cell sizes → aligned false + a loud warning', () => {
    const r = detectChange(grid(2, 2, 1, 0), grid(2, 2, 2, 1));
    expect(r.aligned).toBe(false);
    expect(r.warnings.some((w) => /cell size/i.test(w))).toBe(true);
  });

  it('different dimensions → aligned false, compared over the overlap', () => {
    const r = detectChange(grid(4, 4, 1, 0), grid(2, 2, 1, 1));
    expect(r.aligned).toBe(false);
    expect(r.warnings.some((w) => /dimensions/i.test(w))).toBe(true);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(r.stats.comparable).toBe(4); // the 2×2 overlap
  });

  it('matching raster → aligned true, no warnings', () => {
    expect(detectChange(grid(3, 3, 1, 0), grid(3, 3, 1, 1)).aligned).toBe(true);
  });
});
