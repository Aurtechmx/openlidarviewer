/**
 * The placement fold helpers (float64-transform.md step 3). Two properties
 * carry the whole design: the identity returns the SAME object — the wiring
 * into bounds/picking/accumulators is then a provable no-op while mounting
 * stays disabled — and a real translation folds in Float64 and round-trips
 * exactly, because nothing is re-quantised.
 */
import { describe, it, expect } from 'vitest';
import {
  isIdentityPlacement,
  placeAabb,
  placePoint,
  rayOriginToLayer,
  accumulatorOffset,
} from '../src/render/layerPlacement';
import {
  createProjectFrame,
  layerTransform,
} from '../src/geo/ProjectSpatialFrame';

const FRAME = createProjectFrame([516_000, 4_644_000, 70]);
const IDENTITY = layerTransform(FRAME, [516_000, 4_644_000, 70]);
const OFFSET = layerTransform(FRAME, [516_100, 4_644_050, 71]);

describe('identity placement', () => {
  it('recognises null, undefined, and the zero transform', () => {
    expect(isIdentityPlacement(null)).toBe(true);
    expect(isIdentityPlacement(undefined)).toBe(true);
    expect(isIdentityPlacement(IDENTITY)).toBe(true);
    expect(isIdentityPlacement(OFFSET)).toBe(false);
  });

  it('returns the SAME objects, bit-identical', () => {
    const aabb = { min: [0, 0, 0] as [number, number, number], max: [1, 2, 3] as [number, number, number] };
    const p: readonly [number, number, number] = [4, 5, 6];
    expect(placeAabb(aabb, null)).toBe(aabb);
    expect(placeAabb(aabb, IDENTITY)).toBe(aabb);
    expect(placePoint(p, IDENTITY)).toBe(p);
    expect(rayOriginToLayer(p, IDENTITY)).toBe(p);
    expect(accumulatorOffset(IDENTITY)).toEqual([0, 0, 0]);
  });
});

describe('a real translation', () => {
  it('places an AABB by the sourceToProject delta', () => {
    const aabb = { min: [0, 0, 0] as [number, number, number], max: [10, 10, 5] as [number, number, number] };
    const placed = placeAabb(aabb, OFFSET);
    expect(placed.min).toEqual([100, 50, 1]);
    expect(placed.max).toEqual([110, 60, 6]);
    // The input is untouched — placement is data about the layer.
    expect(aabb.min).toEqual([0, 0, 0]);
  });

  it('ray-down then point-up round-trips exactly', () => {
    const rayOrigin: readonly [number, number, number] = [107.5, 53.25, 4.125];
    const down = rayOriginToLayer(rayOrigin, OFFSET);
    // In the layer frame the ray sits at project − delta…
    expect(down).toEqual([7.5, 3.25, 3.125]);
    // …and a hit found there lifts back to exactly where the ray was.
    expect(placePoint(down, OFFSET)).toEqual([107.5, 53.25, 4.125]);
  });

  it('accumulator offset is the concrete delta tuple', () => {
    expect(accumulatorOffset(OFFSET)).toEqual([100, 50, 1]);
  });

  it('agrees with the frame maths it composes with', () => {
    // placePoint must be sourceLocalToProjectLocal by another name — one
    // fold, written once. Divergence here would mean two definitions of
    // "where a layer sits".
    const p: readonly [number, number, number] = [1.5, 2.5, 3.5];
    const viaPlacement = placePoint(p, OFFSET);
    expect(viaPlacement).toEqual([
      p[0] + OFFSET.sourceToProject[0],
      p[1] + OFFSET.sourceToProject[1],
      p[2] + OFFSET.sourceToProject[2],
    ]);
  });
});
