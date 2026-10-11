/**
 * Scale-bar and graticule tick labels print the exact segment values: a 1 m
 * bar split into four reads 0 0.25 0.5 0.75 1, not a one-decimal rounding.
 */
import { describe, it, expect } from 'vitest';
import { formatScaleTick, scaleBar, tickDecimals } from '../src/terrain/contour/mapSheetLayout';

const ticks = (total: number): string[] => {
  const bar = scaleBar(100 / total, 100);
  expect(bar.totalGround).toBe(total);
  return Array.from({ length: bar.segments + 1 }, (_, i) => formatScaleTick(bar.segGround * i));
};

describe('scale-bar tick labels', () => {
  it('a 1-unit bar reads quarters exactly', () => {
    expect(ticks(1)).toEqual(['0', '0.25', '0.5', '0.75', '1']);
  });
  it('a 5-unit bar reads 1.25 and 3.75', () => {
    expect(ticks(5)).toEqual(['0', '1.25', '2.5', '3.75', '5']);
  });
  it('sub-unit and large bars stay exact', () => {
    expect(ticks(0.05)).toEqual(['0', '0.0125', '0.025', '0.0375', '0.05']);
    expect(ticks(500)).toEqual(['0', '125', '250', '375', '500']);
  });
  it('graticule decimals follow the step', () => {
    expect(tickDecimals(100)).toBe(0);
    expect(tickDecimals(0.5)).toBe(1);
    expect(tickDecimals(0.25)).toBe(2);
  });
});
