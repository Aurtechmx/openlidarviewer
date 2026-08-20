import { describe, it, expect } from 'vitest';
import {
  sharedElevationWorldRange,
  localOverrideFor,
} from '../src/render/projectElevationScale';

describe('sharedElevationWorldRange', () => {
  it('unions two world-Z ranges', () => {
    expect(
      sharedElevationWorldRange([
        { min: 10, max: 20 },
        { min: 15, max: 30 },
      ]),
    ).toEqual({ min: 10, max: 30 });
  });

  it('returns null for fewer than two finite ranges', () => {
    expect(sharedElevationWorldRange([{ min: 10, max: 20 }])).toBeNull();
    expect(sharedElevationWorldRange([])).toBeNull();
  });

  it('ignores non-finite and disordered ranges', () => {
    expect(
      sharedElevationWorldRange([
        { min: 10, max: 20 },
        { min: Number.NaN, max: 30 },
        { min: 5, max: Number.POSITIVE_INFINITY },
        { min: 40, max: 5 },
        { min: 0, max: 8 },
      ]),
    ).toEqual({ min: 0, max: 20 });
  });

  it('returns null when only one finite range survives filtering', () => {
    expect(
      sharedElevationWorldRange([
        { min: 10, max: 20 },
        { min: Number.NaN, max: 30 },
      ]),
    ).toBeNull();
  });
});

describe('localOverrideFor', () => {
  it('subtracts the up-axis origin from both ends', () => {
    expect(localOverrideFor({ min: 100, max: 130 }, 100)).toEqual({
      min: 0,
      max: 30,
    });
  });

  it('maps the same world window to different local frames per origin', () => {
    const shared = { min: 100, max: 130 };
    expect(localOverrideFor(shared, 90)).toEqual({ min: 10, max: 40 });
    expect(localOverrideFor(shared, 110)).toEqual({ min: -10, max: 20 });
  });
});
