/**
 * changeNetVolumeRaw.test.ts
 *
 * Proves the raw-net vs thresholded-net distinction added to `detectChange`.
 * Per Anderson (USGS, pubs.usgs.gov/publication/70202166), thresholding at the
 * Level-of-Detection is correct for GROSS erosion/deposition (noise inflates
 * both sides), but applying the same threshold to the NET is a bias: it zeros
 * out sub-LoD cells before opposite-sign error can cancel, instead of letting
 * it cancel in a raw sum.
 */

import { describe, it, expect } from 'vitest';
import { detectChange, type ChangeGrid } from '../src/terrain/change/changeDetection';

function grid(width: number, height: number, cellSizeM: number, fill: number | number[]): ChangeGrid {
  const values = new Float32Array(width * height);
  if (Array.isArray(fill)) values.set(fill);
  else values.fill(fill);
  return { width, height, cellSizeM, values };
}

describe('detectChange — raw net vs thresholded net', () => {
  it('mixed-sign sub-LoD cells: the OLD thresholded net reads ~0 while rawNetVolumeM3 recovers the true non-zero net', () => {
    const lod = 0.1;
    // 4 cells, 1 m² each. Sub-LoD diffs of mixed sign: +0.05, +0.05, -0.03, -0.03.
    // True net over all 4 cells = (0.05+0.05-0.03-0.03) * 1 m² = 0.04 m³ — real,
    // non-zero, but every cell individually is below the 0.1 m LoD.
    const a = grid(2, 2, 1, [0, 0, 0, 0]);
    const b = grid(2, 2, 1, [0.05, 0.05, -0.03, -0.03]);
    const r = detectChange(a, b, { levelOfDetectionM: lod });

    // Every cell is sub-LoD: nothing is classified as gain or loss.
    expect(r.stats.gained).toBe(0);
    expect(r.stats.lost).toBe(0);
    expect(r.stats.unchanged).toBe(4);

    // The OLD (thresholded) net is exactly zero — the bug this fixes.
    expect(r.stats.netVolumeM3).toBe(0);
    expect(r.stats.detectableNetVolumeM3).toBe(0);
    expect(r.stats.gainVolumeM3).toBe(0);
    expect(r.stats.lossVolumeM3).toBe(0);

    // The raw net recovers the true non-zero net over all comparable cells.
    expect(r.stats.rawNetVolumeM3).toBeCloseTo(0.04, 6);
    expect(r.stats.rawNetVolumeM3).not.toBe(r.stats.netVolumeM3);
  });

  it('real gains+losses: detectable gross (above-LoD) volumes differ from the raw net total', () => {
    const lod = 0.1;
    // Cell areas 1 m² each (cellSizeM=1). Mix of above-LoD and sub-LoD cells.
    const a = grid(2, 3, 1, [0, 0, 0, 0, 0, 0]);
    const b = grid(2, 3, 1, [
      1.0, -1.0, // strong gain, strong loss (above LoD)
      0.05, -0.02, // sub-LoD gain, sub-LoD loss
      0.2, -0.3, // above-LoD gain, above-LoD loss
    ]);
    const r = detectChange(a, b, { levelOfDetectionM: lod });

    // Above-LoD classification: 1.0, 0.2 gain; -1.0, -0.3 loss; 0.05/-0.02 unchanged.
    expect(r.stats.gained).toBe(2);
    expect(r.stats.lost).toBe(2);
    expect(r.stats.unchanged).toBe(2);

    const expectedDetectableGain = 1.0 + 0.2;
    const expectedDetectableLoss = 1.0 + 0.3;
    expect(r.stats.detectableGainVolumeM3).toBeCloseTo(expectedDetectableGain, 6);
    expect(r.stats.detectableLossVolumeM3).toBeCloseTo(expectedDetectableLoss, 6);
    expect(r.stats.detectableNetVolumeM3).toBeCloseTo(expectedDetectableGain - expectedDetectableLoss, 6);

    // Raw net includes the sub-LoD cells too, so it differs from the
    // detectable (thresholded) net by exactly the sub-LoD contribution.
    const expectedRawNet = 1.0 - 1.0 + 0.05 - 0.02 + 0.2 - 0.3;
    expect(r.stats.rawNetVolumeM3).toBeCloseTo(expectedRawNet, 6);
    expect(r.stats.rawNetVolumeM3).not.toBeCloseTo(r.stats.detectableNetVolumeM3, 6);

    // Both families are reported and reconcile: gross gain/loss plus the
    // area-above-LoD fraction fully account for the classification counts.
    expect(r.stats.areaAboveLoDFraction).toBeCloseTo(4 / 6, 6);
    expect(r.stats.areaAboveLoDFraction).toBe(r.stats.significantFraction);
    expect(r.stats.gainVolumeM3).toBe(r.stats.detectableGainVolumeM3);
    expect(r.stats.lossVolumeM3).toBe(r.stats.detectableLossVolumeM3);
    expect(r.stats.netVolumeM3).toBe(r.stats.detectableNetVolumeM3);
  });

  it('legacy @1 fields (gainVolumeM3/lossVolumeM3/netVolumeM3) are unchanged in meaning — still thresholded', () => {
    const r = detectChange(grid(3, 3, 2, 0), grid(3, 3, 2, 1));
    // Same assertions as the pre-existing "uniform +1 m gain" pin, proving @1's
    // outputs were not mutated by adding the @2 fields.
    expect(r.stats.gainVolumeM3).toBe(36);
    expect(r.stats.netVolumeM3).toBe(36);
    expect(r.stats.rawNetVolumeM3).toBe(36); // no sub-LoD cells here, so raw == thresholded
  });
});
