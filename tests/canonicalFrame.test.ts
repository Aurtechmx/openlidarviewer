/**
 * The terrain pipeline's single vertical axis.
 *
 * Nine modules under `src/terrain` read a position buffer as "X/Y horizontal,
 * Z elevation". That holds for survey formats and the COPC/EPT streams built on
 * them, and fails for the phone-scan mesh formats, whose native frame is Y-up.
 * A Y-up height field — drone photogrammetry exported as OBJ or glTF, which
 * classifies as terrain — was analysed with a horizontal axis standing in for
 * elevation.
 *
 * These pin the rotation that normalises it, and in particular that it IS a
 * rotation: `(x, z, y)` is one character shorter, is a reflection, and would
 * mirror every aspect and azimuth while leaving elevations correct — wrong in a
 * way that survives inspection, because the terrain still looks like terrain.
 */

import { describe, it, expect } from 'vitest';
import { yUpToCanonicalZUp, yUpOriginToCanonicalZUp, canonicalZUpToYUp } from '../src/terrain/canonicalFrame';
import { sceneUpAxisPolicy } from '../src/io/sniffFormat';

describe('yUpToCanonicalZUp', () => {
  it('moves the Y-up elevation into the canonical Z slot', () => {
    // A point 7 units up in a Y-up frame is 7 units up in Z afterwards.
    const p = Float32Array.from([1, 7, 4]);
    yUpToCanonicalZUp(p);
    expect(p[2]).toBe(7);
  });

  it('maps north from the Y-up frame minus-Z', () => {
    expect([...yUpToCanonicalZUp(Float32Array.from([0, 0, -5]))]).toEqual([0, 5, 0]);
  });

  it('leaves east unchanged', () => {
    expect(yUpToCanonicalZUp(Float32Array.from([3, 0, 0]))[0]).toBe(3);
  });

  it('is a ROTATION, not a mirror — handedness survives', () => {
    // The decisive case. Take the right-handed basis of the Y-up frame and
    // rotate it; the result must still be right-handed, i.e. east × north = up.
    // The `(x, z, y)` swap passes every test above and fails this one.
    // `+ 0` normalises the signed zero a rotation legitimately produces: -0 and
    // 0 are equal under `===` but distinct under `toEqual`, and the difference
    // is not a property of the transform.
    const basis = (v: [number, number, number]) =>
      [...yUpToCanonicalZUp(Float32Array.from(v))].map((n) => n + 0);
    const east = basis([1, 0, 0]);
    const north = basis([0, 0, -1]);
    const up = basis([0, 1, 0]);
    const cross = [
      east[1] * north[2] - east[2] * north[1],
      east[2] * north[0] - east[0] * north[2],
      east[0] * north[1] - east[1] * north[0],
    ].map((n) => n + 0);
    expect(cross).toEqual(up);
  });

  it('rotates every point in a multi-point buffer', () => {
    const p = Float32Array.from([1, 2, 3, 4, 5, 6]);
    yUpToCanonicalZUp(p);
    expect([...p]).toEqual([1, -3, 2, 4, -6, 5]);
  });

  it('preserves distances, as a rigid motion must', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([4, 6, 8]);
    const d0 = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    yUpToCanonicalZUp(a);
    yUpToCanonicalZUp(b);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeCloseTo(d0, 6);
  });

  it('handles an empty buffer', () => {
    expect(yUpToCanonicalZUp(new Float32Array(0)).length).toBe(0);
  });

  it('ignores a trailing partial triple rather than reading past the end', () => {
    const p = Float32Array.from([1, 2, 3, 9, 9]);
    yUpToCanonicalZUp(p);
    expect([...p]).toEqual([1, -3, 2, 9, 9]);
  });
});

describe('yUpOriginToCanonicalZUp', () => {
  it('applies the SAME rotation the points get', () => {
    const origin: [number, number, number] = [500_000, 120, -4_400_000];
    const asPoint = [...yUpToCanonicalZUp(Float32Array.from(origin))];
    expect(yUpOriginToCanonicalZUp(origin)).toEqual(asPoint);
  });

  it('puts the northing where terrain reads it', () => {
    // Terrain takes the origin's second component as the northing driving the
    // geographic cos φ scale; leaving it in the source frame would georeference
    // a correctly-rotated surface to the wrong place.
    expect(yUpOriginToCanonicalZUp([0, 120, -4_400_000])[1]).toBe(4_400_000);
  });
});

describe('sceneUpAxisPolicy', () => {
  it('needs no detection for survey formats — Z-up by spec', () => {
    expect(sceneUpAxisPolicy(['las', 'laz', 'e57'], false)).toEqual({ kind: 'z' });
  });

  it('needs no detection for a streaming-only gather', () => {
    // COPC/EPT are LAS-family, Z-up by spec.
    expect(sceneUpAxisPolicy([], true)).toEqual({ kind: 'z' });
  });

  it('demands DETECTION for mesh formats instead of assuming an axis', () => {
    // PLY carries no mandated up-axis: photogrammetry writes Y-up, while
    // CloudCompare/PDAL-style tools write Z-up PLYs. An earlier revision
    // hard-classified PLY as Y-up and rotated genuinely Z-up output into a
    // vertical wall — which the analyse-panel e2e caught.
    expect(sceneUpAxisPolicy(['ply', 'glb'], false)).toEqual({ kind: 'detect', hasSpecZ: false });
  });

  it('flags a mesh + survey mix so a detected-Y-up mesh declines', () => {
    expect(sceneUpAxisPolicy(['las', 'ply'], false)).toEqual({ kind: 'detect', hasSpecZ: true });
    expect(sceneUpAxisPolicy(['ply'], true)).toEqual({ kind: 'detect', hasSpecZ: true });
  });

  it('reports nothing for an empty gather', () => {
    expect(sceneUpAxisPolicy([], false)).toBeNull();
  });
});

describe('canonicalZUpToYUp', () => {
  it('is the exact inverse of the forward rotation', () => {
    const p = Float32Array.from([3, 7, -5, 1.5, -2.25, 8]);
    const original = [...p];
    canonicalZUpToYUp(yUpToCanonicalZUp(p));
    expect([...p]).toEqual(original);
  });

  it('inverts in the other order too', () => {
    const p = Float32Array.from([500_000, 4_400_000, 120]);
    const original = [...p];
    yUpToCanonicalZUp(canonicalZUpToYUp(p));
    expect([...p]).toEqual(original);
  });

  it('is a rotation, not the elevation-only move the seam warns against', () => {
    // Northing 5 in canonical becomes scene −Z; the naive (x, z, y) swap would
    // put it at +Z and mirror the map.
    expect([...canonicalZUpToYUp(Float32Array.from([0, 5, 0]))]).toEqual([0, 0, -5]);
  });
});
