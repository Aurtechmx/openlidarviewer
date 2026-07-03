/**
 * splatShader.test.ts
 *
 * Unit tests for the soft-circular splat alpha curve + radius helpers.
 * These pin the canonical curve (centre = 1, half-radius ≈ 0.75, edge
 * = 0) the renderer's TSL node graph mirrors verbatim. A typo in the
 * GPU side surfaces here as a unit-test failure before it ships.
 */

import { describe, it, expect } from 'vitest';
import {
  SOFT_SPLAT_DEFAULTS,
  INSPECTION_SPLAT_DEFAULTS,
  splatAlpha,
  splatRadiusPx,
  splatRadiusWithDensity,
  splatRadiusMultiplier,
  splatForcesAlphaToCoverage,
  gaussianSplatAlpha,
  GAUSSIAN_SPLAT_SHARPNESS,
  type SplatMode,
} from '../src/render/splatShader';

describe('gaussianSplatAlpha — P13 windowed Gaussian point kernel', () => {
  it('is exactly 1 at the sprite centre', () => {
    expect(gaussianSplatAlpha(0)).toBe(1);
  });

  it('is exactly 0 at the sprite boundary (no hard ring)', () => {
    expect(gaussianSplatAlpha(1)).toBe(0);
  });

  it('clamps out-of-range distance', () => {
    expect(gaussianSplatAlpha(-0.5)).toBe(1);
    expect(gaussianSplatAlpha(2)).toBe(0);
  });

  it('decreases monotonically from centre to edge', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let i = 0; i <= 20; i++) {
      const a = gaussianSplatAlpha(i / 20);
      expect(a).toBeLessThanOrEqual(prev + 1e-12);
      prev = a;
    }
  });

  it('stays finite and in [0, 1] across a distance × sharpness sweep', () => {
    for (const k of [1e-3, 0.5, 1, GAUSSIAN_SPLAT_SHARPNESS, 10, 100, 1000]) {
      for (let i = 0; i <= 50; i++) {
        const a = gaussianSplatAlpha(i / 50, k);
        expect(Number.isFinite(a)).toBe(true);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('handles a non-positive sharpness via the floor without NaN', () => {
    expect(Number.isFinite(gaussianSplatAlpha(0.5, 0))).toBe(true);
    expect(Number.isFinite(gaussianSplatAlpha(0.5, -5))).toBe(true);
  });

  it('uses the default sharpness when omitted', () => {
    expect(gaussianSplatAlpha(0.5)).toBe(gaussianSplatAlpha(0.5, GAUSSIAN_SPLAT_SHARPNESS));
  });
});

describe('splatAlpha — canonical curve at feather = 1', () => {
  it('returns 1 at the sprite centre', () => {
    expect(splatAlpha(0, 1)).toBe(1);
  });

  it('returns ≈ 0.75 at the half-radius', () => {
    // 1 - 0.5² = 0.75 — the canonical "looks soft" reading.
    expect(splatAlpha(0.5, 1)).toBeCloseTo(0.75, 6);
  });

  it('returns 0 at the outer edge', () => {
    expect(splatAlpha(1, 1)).toBe(0);
  });

  it('is monotone non-increasing from centre to edge', () => {
    let prev = splatAlpha(0, 1);
    for (let i = 1; i <= 100; i++) {
      const d = i / 100;
      const a = splatAlpha(d, 1);
      expect(a).toBeLessThanOrEqual(prev + 1e-9);
      prev = a;
    }
  });
});

describe('splatAlpha — feather behaviour', () => {
  it('feather = 0 is a hard disc', () => {
    expect(splatAlpha(0, 0)).toBe(1);
    expect(splatAlpha(0.99, 0)).toBe(1);
    expect(splatAlpha(1, 0)).toBe(0);
  });

  it('feather = 0.5 — plateau inside, falloff outside', () => {
    // Inside the start-of-falloff (1 - 0.5 = 0.5) → full alpha.
    expect(splatAlpha(0, 0.5)).toBe(1);
    expect(splatAlpha(0.4, 0.5)).toBe(1);
    expect(splatAlpha(0.5, 0.5)).toBe(1);
    // At d = 0.75: t = (0.75 - 0.5) / 0.5 = 0.5 → alpha = 1 - 0.25 = 0.75.
    expect(splatAlpha(0.75, 0.5)).toBeCloseTo(0.75, 6);
    // At the edge.
    expect(splatAlpha(1, 0.5)).toBe(0);
  });

  it('clamps out-of-range distance', () => {
    expect(splatAlpha(-0.5, 1)).toBe(1);
    expect(splatAlpha(2, 1)).toBe(0);
  });

  it('clamps out-of-range feather', () => {
    expect(splatAlpha(0.5, -1)).toBe(1); // collapses to hard disc; inside.
    expect(splatAlpha(0.5, 2)).toBeCloseTo(0.75, 6); // clamped to 1.
  });
});

describe('preset bundles', () => {
  it('SOFT_SPLAT_DEFAULTS uses feather = 1', () => {
    expect(SOFT_SPLAT_DEFAULTS.feather).toBe(1);
  });

  it('INSPECTION_SPLAT_DEFAULTS uses a smaller feather for sharper core', () => {
    expect(INSPECTION_SPLAT_DEFAULTS.feather).toBeLessThan(SOFT_SPLAT_DEFAULTS.feather);
    expect(INSPECTION_SPLAT_DEFAULTS.feather).toBeGreaterThan(0);
  });
});

describe('splatRadiusPx — distance falloff', () => {
  it('renders the base radius at the reference distance', () => {
    expect(splatRadiusPx(4, 10, 10, 1, 16)).toBe(4);
  });

  it('grows for near points until the max clamp', () => {
    // At eyeDist = 5 (half of reference), radius doubles → 8.
    expect(splatRadiusPx(4, 5, 10, 1, 16)).toBe(8);
    // At eyeDist = 1 (10× closer), radius would be 40 → clamped to 16.
    expect(splatRadiusPx(4, 1, 10, 1, 16)).toBe(16);
  });

  it('shrinks for far points down to the min clamp', () => {
    // At eyeDist = 100 (10× farther), radius would be 0.4 → clamped to 1.
    expect(splatRadiusPx(4, 100, 10, 1, 16)).toBe(1);
  });

  it('returns maxPx for degenerate distances', () => {
    expect(splatRadiusPx(4, 0, 10, 1, 16)).toBe(16);
    expect(splatRadiusPx(4, -1, 10, 1, 16)).toBe(16);
    expect(splatRadiusPx(4, 10, 0, 1, 16)).toBe(16);
  });
});

describe('splatRadiusWithDensity — combined falloff', () => {
  it('density = 1 reduces to the plain distance formula', () => {
    const a = splatRadiusPx(4, 10, 10, 1, 16);
    const b = splatRadiusWithDensity(4, 10, 10, 1, 1, 16);
    expect(a).toBe(b);
  });

  it('sparse density widens the sprite', () => {
    // density = 2 at reference distance → 4 × 1 × 2 = 8.
    expect(splatRadiusWithDensity(4, 10, 10, 2, 1, 16)).toBe(8);
  });

  it('dense density narrows the sprite', () => {
    // density = 0.5 at reference → 4 × 1 × 0.5 = 2.
    expect(splatRadiusWithDensity(4, 10, 10, 0.5, 1, 16)).toBe(2);
  });

  it('clamps combined value at maxPx', () => {
    // Near + sparse would blow past 16; clamped.
    expect(splatRadiusWithDensity(4, 1, 10, 2, 1, 16)).toBe(16);
  });

  it('clamps combined value at minPx', () => {
    // Far + dense would be sub-pixel; clamped to 1.
    expect(splatRadiusWithDensity(4, 100, 10, 0.5, 1, 16)).toBe(1);
  });

  it('treats negative density scale as 0 (then clamped to minPx)', () => {
    expect(splatRadiusWithDensity(4, 10, 10, -1, 1, 16)).toBe(1);
  });
});

describe('splatRadiusMultiplier — per-mode size scaling', () => {
  it('Classic mode preserves the user-set radius', () => {
    expect(splatRadiusMultiplier('classic')).toBe(1.0);
  });

  it('Soft mode widens 1.5× so neighbouring sprites kiss', () => {
    expect(splatRadiusMultiplier('soft')).toBe(1.5);
  });

  it('Inspection mode widens 2× for sparse measurement work', () => {
    expect(splatRadiusMultiplier('inspection')).toBe(2.0);
  });

  it('Soft and Inspection are larger than Classic; Inspection ≥ Soft', () => {
    const c = splatRadiusMultiplier('classic');
    const s = splatRadiusMultiplier('soft');
    const i = splatRadiusMultiplier('inspection');
    expect(s).toBeGreaterThan(c);
    expect(i).toBeGreaterThanOrEqual(s);
  });
});

describe('splatForcesAlphaToCoverage — per-mode AA forcing', () => {
  it('Classic mode respects the user antialiasing setting (returns false)', () => {
    expect(splatForcesAlphaToCoverage('classic')).toBe(false);
  });

  it('Soft mode forces alphaToCoverage on for the smooth rim', () => {
    expect(splatForcesAlphaToCoverage('soft')).toBe(true);
  });

  it('Inspection mode forces alphaToCoverage on', () => {
    expect(splatForcesAlphaToCoverage('inspection')).toBe(true);
  });

  it('covers every SplatMode without throwing', () => {
    const modes: SplatMode[] = ['classic', 'soft', 'inspection'];
    for (const m of modes) {
      expect(() => splatForcesAlphaToCoverage(m)).not.toThrow();
      expect(() => splatRadiusMultiplier(m)).not.toThrow();
    }
  });
});
