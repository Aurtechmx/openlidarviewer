/**
 * layerSpatialState.test.ts
 *
 * Pins the on-ramp scaffold for roadmap item P1 #2 (the Float64 project frame).
 * LayerSpatialState holds source-local vertices beside a Float64 translation
 * into the shared project frame, and the accessor applies that translation at
 * read time rather than baking it into the Float32 buffer.
 *
 * The two properties the migration will lean on:
 *   - IDENTITY when there is no offset — moving a consumer onto the accessor is
 *     a provable no-op in the single-layer build that ships today.
 *   - EXACT Float64 round trip source ↔ world at survey scale — the precision
 *     the current in-Float32 rebase gives up, which is the reason P1 #2 exists.
 */

import { describe, test, expect } from 'vitest';
import {
  LayerSpatialState,
  layerWorldPosition,
  layerSourcePosition,
} from '../src/model/LayerSpatialState';

type Vec3 = readonly [number, number, number];

describe('LayerSpatialState construction', () => {
  test('derives projectToSource as the exact negation of sourceToProject', () => {
    const state = new LayerSpatialState({
      sourceLocal: new Float32Array([1, 2, 3]),
      sourceToProject: [500000, 4100000, 200],
    });
    expect(state.sourceToProject).toEqual([500000, 4100000, 200]);
    expect(state.projectToSource).toEqual([-500000, -4100000, -200]);
  });

  test('reports pointCount as one point per x,y,z triple', () => {
    const state = new LayerSpatialState({
      sourceLocal: new Float32Array(9),
      sourceToProject: [0, 0, 0],
    });
    expect(state.pointCount).toBe(3);
  });

  test('rejects a buffer whose length is not a multiple of 3', () => {
    expect(
      () => new LayerSpatialState({ sourceLocal: new Float32Array(7), sourceToProject: [0, 0, 0] }),
    ).toThrow(/divisible by 3/);
  });

  test('rejects a non-finite translation', () => {
    expect(
      () => new LayerSpatialState({ sourceLocal: new Float32Array(3), sourceToProject: [0, Infinity, 0] }),
    ).toThrow(/finite/);
    expect(
      () => new LayerSpatialState({ sourceLocal: new Float32Array(3), sourceToProject: [NaN, 0, 0] }),
    ).toThrow(/finite/);
  });

  test('does not alias the caller\'s translation array', () => {
    const off: [number, number, number] = [10, 20, 30];
    const state = new LayerSpatialState({ sourceLocal: new Float32Array(3), sourceToProject: off });
    off[0] = 999;
    expect(state.sourceToProject[0]).toBe(10);
  });
});

describe('layerWorldPosition — identity when there is no offset', () => {
  test('returns the raw source-local value bit-identically under a zero translation', () => {
    // Values that are NOT exactly representable in Float32, to prove the
    // accessor returns what the buffer actually stores, not a re-rounded copy.
    const sourceLocal = new Float32Array([0.1, 0.2, 0.3, -12.3456789, 987.654321, 0.000123]);
    const state = new LayerSpatialState({ sourceLocal, sourceToProject: [0, 0, 0] });
    for (let i = 0; i < state.pointCount; i++) {
      const w = layerWorldPosition(state, i);
      expect(Object.is(w[0], sourceLocal[i * 3])).toBe(true);
      expect(Object.is(w[1], sourceLocal[i * 3 + 1])).toBe(true);
      expect(Object.is(w[2], sourceLocal[i * 3 + 2])).toBe(true);
    }
  });
});

describe('layerWorldPosition / layerSourcePosition — exact Float64 round trip', () => {
  test('source → world → source recovers every component exactly at survey scale', () => {
    const sourceLocal = new Float32Array([4.25, 9.5, 1.75, 800.5, 620.25, 47.125]);
    // A survey-scale (integer) translation, as chooseProjectOrigin produces.
    const state = new LayerSpatialState({
      sourceLocal,
      sourceToProject: [500000, 4100000, 200],
    });
    const world: [number, number, number] = [0, 0, 0];
    const back: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < state.pointCount; i++) {
      layerWorldPosition(state, i, world);
      // world carries the offset — it is NOT a small residual.
      expect(world[0]).toBeGreaterThan(499999);
      layerSourcePosition(state, world, back);
      expect(Object.is(back[0], sourceLocal[i * 3])).toBe(true);
      expect(Object.is(back[1], sourceLocal[i * 3 + 1])).toBe(true);
      expect(Object.is(back[2], sourceLocal[i * 3 + 2])).toBe(true);
    }
  });

  test('Float64 application preserves a residual a Float32 bake would lose', () => {
    // The point of P1 #2 in one assertion. A source-local residual, a
    // survey-scale offset, recovered two ways.
    const v = Math.fround(0.1); // exactly what a Float32 buffer would store
    const offset = 500000;
    const state = new LayerSpatialState({
      sourceLocal: new Float32Array([v, 0, 0]),
      sourceToProject: [offset, 0, 0],
    });

    // Our path: apply the offset in Float64, then invert. Exact.
    const world = layerWorldPosition(state, 0);
    const recovered = layerSourcePosition(state, world)[0];
    expect(Object.is(recovered, v)).toBe(true);

    // The rejected path: bake the offset into Float32, then remove it. Lossy —
    // the residual comes back shifted by the Float32 step size at 5e5 (~2 cm),
    // which is exactly the precision the current in-place rebase gives up.
    const baked = Math.fround(v + offset) - offset;
    expect(baked).not.toBe(v);
    expect(Math.abs(baked - v)).toBeGreaterThan(1e-3);
  });
});

describe('accessor mechanics', () => {
  test('writes through the provided out tuple and returns the same reference', () => {
    const state = new LayerSpatialState({
      sourceLocal: new Float32Array([1, 2, 3]),
      sourceToProject: [10, 20, 30],
    });
    const out: [number, number, number] = [0, 0, 0];
    const result = layerWorldPosition(state, 0, out);
    expect(result).toBe(out);
    expect(out).toEqual([11, 22, 33]);
  });

  test('throws on an out-of-range index rather than reading past the buffer', () => {
    const state = new LayerSpatialState({
      sourceLocal: new Float32Array([1, 2, 3]),
      sourceToProject: [0, 0, 0],
    });
    expect(() => layerWorldPosition(state, 1)).toThrow(RangeError);
    expect(() => layerWorldPosition(state, -1)).toThrow(RangeError);
  });

  test('the world → source inverse composes back to the identity map with no offset', () => {
    const state = new LayerSpatialState({
      sourceLocal: new Float32Array([3, 6, 9]),
      sourceToProject: [0, 0, 0],
    });
    const world = layerWorldPosition(state, 0);
    const back = layerSourcePosition(state, world as Vec3);
    expect(back).toEqual([3, 6, 9]);
  });
});
