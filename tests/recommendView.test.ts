import { describe, it, expect } from 'vitest';
import {
  recommendCameraPreset,
  flatnessFromBounds,
} from '../src/render/camera/recommendView';

describe('recommendCameraPreset', () => {
  it('recommends a top-down plan view for a wide, classified surface', () => {
    const r = recommendCameraPreset({ hasRgb: false, hasClassification: true, flatness: 20 });
    expect(r.preset).toBe('top');
    expect(r.reason).toMatch(/plan view/);
  });

  it('recommends an oblique view for a colour scan that is not a flat surface', () => {
    const r = recommendCameraPreset({ hasRgb: true, hasClassification: false, flatness: 2 });
    expect(r.preset).toBe('oblique');
  });

  it('does not force top-down on a wide scan without classification', () => {
    const r = recommendCameraPreset({ hasRgb: true, hasClassification: false, flatness: 30 });
    expect(r.preset).toBe('oblique'); // colour wins over flatness when unclassified
  });

  it('defaults to the balanced isometric view', () => {
    const r = recommendCameraPreset({ hasRgb: false, hasClassification: false, flatness: 1.5 });
    expect(r.preset).toBe('iso');
  });

  it('never returns NaN-driven nonsense for a non-finite flatness', () => {
    const r = recommendCameraPreset({ hasRgb: false, hasClassification: true, flatness: Number.NaN });
    expect(['top', 'iso', 'oblique', 'planar']).toContain(r.preset);
  });
});

describe('flatnessFromBounds', () => {
  it('is large for a wide, shallow tile and ~1 for a cube', () => {
    expect(flatnessFromBounds([0, 0, 0], [1000, 1000, 50])).toBeCloseTo(20, 5);
    expect(flatnessFromBounds([0, 0, 0], [10, 10, 10])).toBeCloseTo(1, 5);
  });

  it('guards degenerate boxes (zero height → treated as flat; zero footprint → 1)', () => {
    expect(flatnessFromBounds([0, 0, 0], [100, 100, 0])).toBeGreaterThanOrEqual(6);
    expect(flatnessFromBounds([5, 5, 5], [5, 5, 5])).toBe(1);
  });
});
