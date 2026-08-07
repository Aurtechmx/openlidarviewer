import { describe, it, expect } from 'vitest';
import { bandHigh, bandLow } from '../src/terrain/contour/terrainAssessment';

// These two helpers replaced the assessment's inline good/fair/poor ternaries.
// In the real flow every input is sanitised before it reaches them, so the NaN
// case is a safety net rather than a reachable path; this pins it directly so a
// later edit cannot drift the contract the ternaries had, where every NaN
// comparison is false and the value falls through to poor.
describe('terrainAssessment banding helpers', () => {
  it('bandHigh (higher is better) bands at the thresholds, inclusive at good/fair', () => {
    expect(bandHigh(70, 70, 45)).toBe('good');
    expect(bandHigh(69.9, 70, 45)).toBe('fair');
    expect(bandHigh(45, 70, 45)).toBe('fair');
    expect(bandHigh(44.9, 70, 45)).toBe('poor');
  });

  it('bandLow (lower is better) bands at the thresholds, inclusive at good/fair', () => {
    expect(bandLow(0.1, 0.1, 0.25)).toBe('good');
    expect(bandLow(0.11, 0.1, 0.25)).toBe('fair');
    expect(bandLow(0.25, 0.1, 0.25)).toBe('fair');
    expect(bandLow(0.26, 0.1, 0.25)).toBe('poor');
  });

  it('bands NaN as poor in both directions, never good or fair', () => {
    expect(bandHigh(Number.NaN, 70, 45)).toBe('poor');
    expect(bandLow(Number.NaN, 0.1, 0.25)).toBe('poor');
  });
});
