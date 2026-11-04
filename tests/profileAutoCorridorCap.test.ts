import { describe, it, expect } from 'vitest';
import { AUTO_CORRIDOR_MAX_HALF_WIDTH_M, autoCorridorWidth, profileSampleParams } from '../src/render/measure/profileSampler';

const UP: [number, number, number] = [0, 0, 1];
const KNOWN = { unitToMetres: 1, crsKnown: true, geographic: false };
const line = (len: number): [[number, number, number], [number, number, number]] => [[0, 0, 0], [len, 0, 0]];

describe('the automatic corridor of a new profile', () => {
  it('stays 5 % of the length on a short line', () => {
    const [a, b] = line(48);
    expect(profileSampleParams(null, a, b, UP, KNOWN).corridorWidth).toBeCloseTo(autoCorridorWidth(a, b, UP), 12);
    expect(profileSampleParams(null, a, b, UP, KNOWN).corridorWidth).toBeCloseTo(2.4, 12);
  });

  it('stops at 5 m on a long line', () => {
    const [a, b] = line(740);
    expect(profileSampleParams(null, a, b, UP, KNOWN).corridorWidth).toBe(AUTO_CORRIDOR_MAX_HALF_WIDTH_M);
  });

  it('reads the cap in the layer\'s unit', () => {
    const [a, b] = line(5000);
    expect(profileSampleParams(null, a, b, UP, { ...KNOWN, unitToMetres: 0.3048 }).corridorWidth).toBeCloseTo(5 / 0.3048, 9);
  });

  it('leaves a width someone chose alone, and keeps the other choices', () => {
    const [a, b] = line(740);
    const chosen = profileSampleParams({ corridorWidthM: 30, groundPercentile: 50, sampleCount: 128 }, a, b, UP, KNOWN);
    expect(chosen).toEqual({ corridorWidth: 30, groundPercentile: 50, sampleCount: 128 });
    const percentileOnly = profileSampleParams({ corridorWidthM: null, groundPercentile: 50, sampleCount: null }, a, b, UP, KNOWN);
    expect(percentileOnly).toEqual({ corridorWidth: 5, groundPercentile: 50, sampleCount: null });
  });

  it('keeps the share of the length where no metre scale resolved', () => {
    const [a, b] = line(10_000); // a scan with no CRS, possibly in millimetres
    expect(profileSampleParams(null, a, b, UP, { unitToMetres: 1, crsKnown: false, geographic: false }).corridorWidth).toBe(500);
    expect(profileSampleParams(null, a, b, UP, { unitToMetres: 1, crsKnown: true, geographic: true }).corridorWidth).toBe(500);
  });
});
