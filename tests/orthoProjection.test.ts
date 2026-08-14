import { describe, it, expect } from 'vitest';
import {
  orthoHalfExtents,
  orthoPointPixels,
  projectionFromLegacyFov,
} from '../src/render/camera/orthoProjection';

describe('orthoHalfExtents', () => {
  it('bounds the sphere on the shorter axis — landscape stretches the width', () => {
    const e = orthoHalfExtents(10, 2); // width : height = 2 : 1
    expect(e.halfH).toBeCloseTo(10);
    expect(e.halfW).toBeCloseTo(20);
  });

  it('swaps the tight axis in portrait', () => {
    const e = orthoHalfExtents(10, 0.5); // taller than wide
    expect(e.halfW).toBeCloseTo(10);
    expect(e.halfH).toBeCloseTo(20);
  });

  it('is square at aspect 1', () => {
    const e = orthoHalfExtents(7, 1);
    expect(e.halfW).toBeCloseTo(7);
    expect(e.halfH).toBeCloseTo(7);
  });

  it('applies padding so the sphere clears the frame edge', () => {
    const e = orthoHalfExtents(10, 1, 1.2);
    expect(e.halfH).toBeCloseTo(12);
  });

  it('never collapses on a degenerate radius or aspect', () => {
    const e = orthoHalfExtents(0, 0);
    expect(e.halfW).toBeGreaterThan(0);
    expect(e.halfH).toBeGreaterThan(0);
    const nan = orthoHalfExtents(5, NaN);
    expect(nan.halfW).toBeCloseTo(5); // aspect falls back to 1
    expect(nan.halfH).toBeCloseTo(5);
  });
});

describe('orthoPointPixels', () => {
  it('renders points at the base size when the scene is framed', () => {
    expect(orthoPointPixels(3, 100, 100, 1, 30)).toBeCloseTo(3);
  });

  it('grows points as you zoom in (frustum shrinks below the fit)', () => {
    // Half-height halved → 2x zoom → points twice as large.
    expect(orthoPointPixels(3, 100, 50, 1, 30)).toBeCloseTo(6);
  });

  it('shrinks points as you zoom out', () => {
    expect(orthoPointPixels(4, 100, 200, 1, 30)).toBeCloseTo(2);
  });

  it('clamps to the max band on a hard zoom-in', () => {
    expect(orthoPointPixels(3, 100, 1, 1, 30)).toBe(30);
  });

  it('clamps to the min band on a hard zoom-out', () => {
    expect(orthoPointPixels(3, 100, 100000, 1, 30)).toBe(1);
  });

  it('does not divide by zero on a collapsed frustum', () => {
    expect(Number.isFinite(orthoPointPixels(3, 100, 0, 1, 30))).toBe(true);
  });
});

describe('projectionFromLegacyFov', () => {
  const ORTHO_FOV = 2;

  it('reads a legacy 2° near-ortho view as orthographic', () => {
    expect(projectionFromLegacyFov(2, ORTHO_FOV)).toBe('orthographic');
    expect(projectionFromLegacyFov(2.3, ORTHO_FOV)).toBe('orthographic'); // within tolerance
  });

  it('reads a normal fov as perspective', () => {
    expect(projectionFromLegacyFov(60, ORTHO_FOV)).toBe('perspective');
    expect(projectionFromLegacyFov(35, ORTHO_FOV)).toBe('perspective');
  });

  it('treats an absent or non-finite fov as perspective', () => {
    expect(projectionFromLegacyFov(undefined, ORTHO_FOV)).toBe('perspective');
    expect(projectionFromLegacyFov(NaN, ORTHO_FOV)).toBe('perspective');
  });
});
