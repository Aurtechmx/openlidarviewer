import { describe, test, expect } from 'vitest';
import {
  changeVolumeUncertainty,
  cellSigmaFromLoD,
} from '../src/terrain/change/changeUncertainty';

describe('cellSigmaFromLoD', () => {
  test('treats the LoD as a ~95% (1.96σ) threshold', () => {
    expect(cellSigmaFromLoD(0.196)).toBeCloseTo(0.1, 6);
    expect(cellSigmaFromLoD(0)).toBe(0);
  });
});

describe('changeVolumeUncertainty', () => {
  test('random error scales as cellArea·σ·√N', () => {
    const r = changeVolumeUncertainty({
      netVolumeM3: 1000,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
      registrationSigmaM: 0,
    });
    // 1 · 0.05 · √400 = 0.05 · 20 = 1.0
    expect(r.randomErrorM3).toBeCloseTo(1.0, 6);
    expect(r.systematicErrorM3).toBe(0);
    expect(r.sigmaM3).toBeCloseTo(1.0, 6);
  });

  test('a co-registration bias adds a systematic term in quadrature', () => {
    const base = changeVolumeUncertainty({
      netVolumeM3: 1000,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
    });
    const withReg = changeVolumeUncertainty({
      netVolumeM3: 1000,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
      registrationSigmaM: 0.02, // 400·1·0.02 = 8 m³ systematic
    });
    expect(withReg.systematicErrorM3).toBeCloseTo(8, 6);
    expect(withReg.sigmaM3).toBeCloseTo(Math.hypot(base.randomErrorM3, 8), 6);
    expect(withReg.sigmaM3).toBeGreaterThan(base.sigmaM3);
  });

  test('a change smaller than its band is flagged not detectable and graded low', () => {
    const r = changeVolumeUncertainty({
      netVolumeM3: 3,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05, // σ ≈ 1 m³, but include systematic to exceed |net|
      registrationSigmaM: 0.02,
    });
    expect(r.detectable).toBe(false);
    expect(r.confidence).toBe('low');
    expect(r.caveats.join(' ')).toMatch(/not distinguishable from survey noise/i);
    expect(r.caveats.join(' ')).toMatch(/~95% level of detection/);
  });

  test('a |net| between 1σ and 1.96σ is NOT detectable (the ~95% LoD convention)', () => {
    // Hand computation: random = 1 · 0.05 · √400 = 1 m³;
    // systematic = 400 · 1 · 0.02 = 8 m³; σ = √(1² + 8²) = √65 ≈ 8.0623 m³.
    // 1.96σ ≈ 15.80 m³. A net of 10 m³ exceeds σ (the OLD threshold would
    // have called it detectable) but is below the ~95% level of detection.
    const r = changeVolumeUncertainty({
      netVolumeM3: 10,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
      registrationSigmaM: 0.02,
    });
    expect(r.sigmaM3).toBeCloseTo(Math.sqrt(65), 4);
    expect(r.detectable).toBe(false);
    expect(r.confidence).toBe('low');
    // The caveat names the convention and the threshold (1.96σ ≈ 16 m³).
    expect(r.caveats.join(' ')).toMatch(/1\.96σ ≈ 16 m³/);
  });

  test('a clear, well-registered change grades high and is detectable', () => {
    const r = changeVolumeUncertainty({
      netVolumeM3: 1240,
      significantCells: 900,
      cellAreaM2: 1,
      cellSigmaM: 0.03,
      registrationSigmaM: 0.01,
    });
    expect(r.detectable).toBe(true);
    expect(r.relativeError).toBeLessThan(0.1);
    expect(r.confidence).toBe('high');
    expect(r.lowM3).toBeLessThan(1240);
    expect(r.highM3).toBeGreaterThan(1240);
  });

  test('missing registration is called out honestly', () => {
    const r = changeVolumeUncertainty({
      netVolumeM3: 1000,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
    });
    expect(r.caveats.join(' ')).toMatch(/co-registration error is not included/i);
  });

  test('net erosion keeps a signed (negative) band, never clamped to 0', () => {
    const r = changeVolumeUncertainty({
      netVolumeM3: -500,
      significantCells: 400,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
      registrationSigmaM: 0.01,
    });
    expect(r.lowM3).toBeLessThan(-500);
    expect(r.highM3).toBeGreaterThan(-500);
    expect(r.highM3).toBeLessThan(0);
  });

  test('zero net change yields relative error 0 (no divide-by-zero)', () => {
    const r = changeVolumeUncertainty({
      netVolumeM3: 0,
      significantCells: 0,
      cellAreaM2: 1,
      cellSigmaM: 0.05,
    });
    expect(r.relativeError).toBe(0);
    expect(Number.isFinite(r.sigmaM3)).toBe(true);
  });
});
