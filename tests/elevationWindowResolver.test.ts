import { describe, it, expect } from 'vitest';

import {
  elevWindowFor,
  elevWindowForMaterial,
  type ElevLayer,
} from '../src/render/elevationWindowResolver';

/**
 * These pin the decision that Gate 2 Stage B introduced: a world-space elevation
 * window is converted into EACH cloud's own attribute space, using that cloud's
 * origin and up-axis, rather than one shared conversion for the whole scene.
 *
 * The bug this prevents is silent: positions are stored origin-shifted, so a
 * window converted with cloud A's origin clips cloud B (recentred elsewhere) at
 * the wrong true height. The resolver is the seam the Viewer installs, so a
 * regression here would put every layer back on one origin without any type
 * error. Materials are plain strings; the resolver is generic over the material
 * type and never inspects it beyond identity, so no GPU or Viewer is needed.
 */

describe('elevWindowFor', () => {
  it('subtracts the cloud origin along the up-axis (attr = world - origin)', () => {
    // Cloud A from the gate2 fixtures: Z origin 195, world window [198, 202].
    expect(elevWindowFor([198, 202], 195, 2)).toEqual({ min: 3, max: 7, axisIsZ: 1 });
  });

  it('maps the up-axis to the shader flag: Z-up (2) is 1, Y-up (1) is 0', () => {
    expect(elevWindowFor([10, 20], 0, 2).axisIsZ).toBe(1);
    expect(elevWindowFor([10, 20], 0, 1).axisIsZ).toBe(0);
  });

  it('still returns a window when the filter is off (undefined range)', () => {
    // The shader reads the uniforms unconditionally and gates on `enabled`, so a
    // resolver that threw or returned null on the off state would break the graph.
    const w = elevWindowFor(undefined, 195, 2);
    expect(Number.isFinite(w.min)).toBe(true);
    expect(Number.isFinite(w.max)).toBe(true);
  });
});

describe('elevWindowForMaterial', () => {
  it('gives two clouds at different origins two different windows from one world range', () => {
    // The core Stage B guarantee. gate2-origin-a: Z origin 195; gate2-origin-b:
    // Z origin 150. The same world window [198, 202] must land at different
    // attribute bounds, or B clips 45 m off.
    const layers: ElevLayer<string>[] = [
      { material: 'A', originAlongAxis: 195, axis: 2 },
      { material: 'B', originAlongAxis: 150, axis: 2 },
    ];
    const fallback = { originAlongAxis: 0, axis: 2 as const };
    const a = elevWindowForMaterial([198, 202], layers, 'A', fallback);
    const b = elevWindowForMaterial([198, 202], layers, 'B', fallback);
    expect(a).toEqual({ min: 3, max: 7, axisIsZ: 1 });
    expect(b).toEqual({ min: 48, max: 52, axisIsZ: 1 });
    expect(a.min).not.toBe(b.min);
  });

  it('reads the correct position component for a Z-up cloud beside a Y-up cloud', () => {
    const layers: ElevLayer<string>[] = [
      { material: 'survey', originAlongAxis: 10, axis: 2 },
      { material: 'phone', originAlongAxis: 10, axis: 1 },
    ];
    const fallback = { originAlongAxis: 0, axis: 2 as const };
    expect(elevWindowForMaterial([12, 17], layers, 'survey', fallback).axisIsZ).toBe(1);
    expect(elevWindowForMaterial([12, 17], layers, 'phone', fallback).axisIsZ).toBe(0);
  });

  it('falls back to the scene origin for a material with no matching layer', () => {
    // An orphaned or not-yet-registered mesh must still get a window (the old
    // shared-origin behaviour), never throw inside a node-graph build.
    const layers: ElevLayer<string>[] = [{ material: 'A', originAlongAxis: 195, axis: 2 }];
    const fallback = { originAlongAxis: 150, axis: 1 as const };
    const w = elevWindowForMaterial([198, 202], layers, 'orphan', fallback);
    expect(w).toEqual({ min: 48, max: 52, axisIsZ: 0 });
  });
});
