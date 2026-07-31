/**
 * projectElevationRange.test.ts
 *
 * Pins the shared project elevation range and — more importantly — its
 * refusals. A combined min/max is trivial arithmetic; the value of this reducer
 * is that it declines to do the arithmetic when the inputs do not describe the
 * same kind of height. Metres merged with feet, or with a layer that never said
 * what its heights are in, produces a number that reads like an elevation and
 * is not one, and that number would end up on a legend.
 */

import { describe, it, expect } from 'vitest';
import {
  combineElevationRanges,
  type LayerElevationRange,
} from '../src/geo/projectElevationRange';

const metres = (min: number, max: number, layerId?: string): LayerElevationRange => ({
  min,
  max,
  verticalUnit: 'metre',
  layerId,
});

describe('combineElevationRanges — a shared range', () => {
  it('spans every layer when the units agree', () => {
    const combined = combineElevationRanges([
      metres(12, 48, 'North scan'),
      metres(30, 61.5, 'South scan'),
      metres(-3, 20, 'Pit'),
    ]);
    expect(combined).toEqual({ mixed: false, min: -3, max: 61.5, verticalUnit: 'metre' });
  });

  it('passes a single range straight through', () => {
    const combined = combineElevationRanges([metres(12, 48, 'Only scan')]);
    expect(combined).toEqual({ mixed: false, min: 12, max: 48, verticalUnit: 'metre' });
  });

  it('keeps the agreed unit rather than normalising it', () => {
    const combined = combineElevationRanges([
      { min: 40, max: 160, verticalUnit: 'us-survey-foot' },
      { min: 55, max: 210, verticalUnit: 'us-survey-foot' },
    ]);
    expect(combined).toEqual({
      mixed: false,
      min: 40,
      max: 210,
      verticalUnit: 'us-survey-foot',
    });
  });

  it('accepts a flat range (every point at one height)', () => {
    expect(combineElevationRanges([metres(5, 5)])).toEqual({
      mixed: false,
      min: 5,
      max: 5,
      verticalUnit: 'metre',
    });
  });
});

describe('combineElevationRanges — refusals', () => {
  it('refuses mismatched vertical units instead of merging the numbers', () => {
    const combined = combineElevationRanges([
      metres(12, 48, 'North scan'),
      { min: 40, max: 160, verticalUnit: 'foot', layerId: 'Legacy survey' },
    ]);
    expect(combined.mixed).toBe(true);
    if (combined.mixed) {
      expect(combined.reason).toContain('metre');
      expect(combined.reason).toContain('foot');
      expect(combined.reason).toContain('Legacy survey');
    }
    // The tempting wrong answer — the numeric envelope — is not returned.
    expect(combined).not.toHaveProperty('min');
  });

  it('refuses an unknown vertical unit rather than borrowing a sibling’s', () => {
    const combined = combineElevationRanges([
      metres(12, 48, 'North scan'),
      { min: 14, max: 50, verticalUnit: 'unknown', layerId: 'Mesh' },
    ]);
    expect(combined.mixed).toBe(true);
    if (combined.mixed) expect(combined.reason).toContain('Mesh');
  });

  it('refuses when the FIRST range is the one with no declared unit', () => {
    const combined = combineElevationRanges([
      { min: 14, max: 50, verticalUnit: 'unknown', layerId: 'Mesh' },
      metres(12, 48, 'North scan'),
    ]);
    expect(combined.mixed).toBe(true);
    if (combined.mixed) expect(combined.reason).toContain('Mesh');
  });

  it('refuses a non-finite range', () => {
    const nan = combineElevationRanges([metres(12, 48), metres(Number.NaN, 50, 'Broken')]);
    expect(nan.mixed).toBe(true);
    if (nan.mixed) expect(nan.reason).toContain('Broken');

    const infinite = combineElevationRanges([metres(0, Number.POSITIVE_INFINITY)]);
    expect(infinite.mixed).toBe(true);
  });

  it('refuses an inverted range instead of widening the project by it', () => {
    const combined = combineElevationRanges([metres(48, 12, 'Upside-down')]);
    expect(combined.mixed).toBe(true);
    if (combined.mixed) expect(combined.reason).toContain('Upside-down');
  });

  it('refuses an empty project rather than returning an infinite envelope', () => {
    const combined = combineElevationRanges([]);
    expect(combined.mixed).toBe(true);
    if (combined.mixed) expect(combined.reason).toContain('No layer elevation ranges');
  });

  it('names an unlabelled range by position', () => {
    const combined = combineElevationRanges([metres(12, 48), metres(Number.NaN, 4)]);
    expect(combined.mixed).toBe(true);
    if (combined.mixed) expect(combined.reason).toContain('Layer 2');
  });
});
