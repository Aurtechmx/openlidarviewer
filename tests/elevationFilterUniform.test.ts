/**
 * elevationFilterUniform.test.ts
 *
 * Pins the pure core of the v0.5.6 GPU elevation filter: the world -> attribute
 * space conversion (subtract the origin shift along the up-axis), range
 * normalisation and the disabled-identity path, and the CPU mirror of the shader
 * test (inclusive both ends; disabled passes everything). The shader multiply is
 * device-verified separately; this fixes the contract it must honour.
 */

import { describe, it, expect } from 'vitest';
import {
  ELEVATION_FILTER_OFF,
  elevationFilterUniform,
  elevationPasses,
} from '../src/render/elevationFilterUniform';

describe('elevationFilterUniform', () => {
  it('returns the identity payload when the range is absent or unusable', () => {
    expect(elevationFilterUniform(undefined, 2, 0)).toEqual({ enabled: 0, axis: 2, min: 0, max: 0 });
    expect(elevationFilterUniform([Number.NaN, Number.NaN], 1, 5)).toEqual({
      enabled: 0,
      axis: 1,
      min: 0,
      max: 0,
    });
  });

  it('converts a world window to attribute space by subtracting the origin shift', () => {
    // world [100, 150] with a 40 m origin shift -> attribute [60, 110].
    expect(elevationFilterUniform([100, 150], 2, 40)).toEqual({
      enabled: 1,
      axis: 2,
      min: 60,
      max: 110,
    });
  });

  it('orders reversed bounds before converting', () => {
    expect(elevationFilterUniform([150, 100], 2, 0)).toEqual({
      enabled: 1,
      axis: 2,
      min: 100,
      max: 150,
    });
  });

  it('collapses a single finite bound to a point window', () => {
    expect(elevationFilterUniform([12, Number.NaN], 2, 2)).toEqual({
      enabled: 1,
      axis: 2,
      min: 10,
      max: 10,
    });
  });

  it('carries the up-axis through unchanged (1 = Y-up, 2 = Z-up)', () => {
    expect(elevationFilterUniform([0, 1], 1, 0).axis).toBe(1);
    expect(elevationFilterUniform([0, 1], 2, 0).axis).toBe(2);
  });

  it('treats a non-finite origin shift as zero', () => {
    expect(elevationFilterUniform([5, 9], 2, Number.NaN)).toEqual({
      enabled: 1,
      axis: 2,
      min: 5,
      max: 9,
    });
  });
});

describe('elevationPasses (CPU mirror of the shader multiply)', () => {
  it('passes everything when disabled, even non-finite input', () => {
    expect(elevationPasses(ELEVATION_FILTER_OFF, 999)).toBe(true);
    expect(elevationPasses(ELEVATION_FILTER_OFF, Number.NaN)).toBe(true);
  });

  it('is inclusive at both ends', () => {
    const u = elevationFilterUniform([2, 10], 2, 0);
    expect(elevationPasses(u, 2)).toBe(true);
    expect(elevationPasses(u, 10)).toBe(true);
    expect(elevationPasses(u, 1.999)).toBe(false);
    expect(elevationPasses(u, 10.001)).toBe(false);
  });

  it('fails a non-finite elevation against an active window', () => {
    const u = elevationFilterUniform([0, 100], 2, 0);
    expect(elevationPasses(u, Number.NaN)).toBe(false);
    expect(elevationPasses(u, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('compares in attribute space, matching the converted window', () => {
    // world [100, 150], shift 40 -> attr [60, 110]. A point stored at attr 60
    // (world 100) passes; attr 59 (world 99) does not.
    const u = elevationFilterUniform([100, 150], 2, 40);
    expect(elevationPasses(u, 60)).toBe(true);
    expect(elevationPasses(u, 110)).toBe(true);
    expect(elevationPasses(u, 59)).toBe(false);
  });
});

describe('ELEVATION_FILTER_OFF', () => {
  it('is the disabled identity', () => {
    expect(ELEVATION_FILTER_OFF.enabled).toBe(0);
  });
});
