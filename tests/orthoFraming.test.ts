/**
 * orthoFraming.test.ts — the camera-frustum → world-rectangle math behind
 * the georeferenced Studio export (v0.4.5, workplan C4), as hand-computed
 * fixtures. The contract under test: the extent handed to the world file
 * is EXACTLY the rectangle the planned orthographic camera frames, the
 * raster keeps square pixels, and degenerate footprints refuse to plan
 * (the host falls back to the plain view capture).
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FRAMED_EXPORT_WIDTH_PX,
  frameTopDownOrtho,
  orthoFrustumWorldRect,
} from '../src/render/export/orthoFraming';
import { buildWorldFileText } from '../src/render/export/pngWorldFile';

describe('frameTopDownOrtho — hand-computed framing', () => {
  // Footprint 100 × 50 m centred at (60, 45), depth 5..15 m.
  const aabb = [10, 20, 5, 110, 70, 15] as const;

  it('plans the camera + frustum exactly over the footprint', () => {
    const f = frameTopDownOrtho(aabb, 2048)!;
    // Centre: ((10+110)/2, (20+70)/2) = (60, 45). dz = 10 → z = 15 + 10 = 25.
    expect(f.camera).toEqual({ x: 60, y: 45, z: 25, lookZ: 10 });
    // Half-extents: ±50 in X, ±25 in Y. far = 4·10 + 1 = 41.
    expect(f.frustum).toEqual({ left: -50, right: 50, top: 25, bottom: -25, near: 0.01, far: 41 });
  });

  it('frustum → world rectangle: extent is the camera pose plus the frustum planes', () => {
    const f = frameTopDownOrtho(aabb, 2048)!;
    // 60 − 50 = 10, 60 + 50 = 110, 45 − 25 = 20, 45 + 25 = 70 — the AABB
    // footprint back again, but DERIVED from the camera, not copied.
    expect(f.extent).toEqual({ minX: 10, maxX: 110, minY: 20, maxY: 70 });
    expect(orthoFrustumWorldRect(f.camera, f.frustum)).toEqual(f.extent);
  });

  it('keeps pixels square: height = width × footprint aspect', () => {
    const f = frameTopDownOrtho(aabb, 2048)!;
    // Aspect 50/100 = 0.5 → 2048 × 0.5 = 1024.
    expect(f.widthPx).toBe(2048);
    expect(f.heightPx).toBe(1024);
    // Per-pixel scale agrees on both axes: 100 m / 2048 px = 50 m / 1024 px.
    expect((f.extent.maxX - f.extent.minX) / f.widthPx).toBeCloseTo(
      (f.extent.maxY - f.extent.minY) / f.heightPx,
      12,
    );
  });

  it('rounds the non-integer aspect height and clamps slivers to ≥ 2 px', () => {
    // 10 × 3.3 footprint at width 100 → 100 × 0.33 = 33 px exactly after round.
    const f = frameTopDownOrtho([0, 0, 0, 10, 3.3, 1], 100)!;
    expect(f.heightPx).toBe(33);
    // A 1000:1 sliver at width 100 → 0.1 px → clamped to the 2 px floor.
    const sliver = frameTopDownOrtho([0, 0, 0, 1000, 1, 1], 100)!;
    expect(sliver.heightPx).toBe(2);
  });

  it('defaults the width and never returns a flat clip volume', () => {
    const f = frameTopDownOrtho([0, 0, 2, 4, 4, 2], undefined)!;
    expect(f.widthPx).toBe(DEFAULT_FRAMED_EXPORT_WIDTH_PX);
    // Zero Z-extent clamps dz to 1e-6 — far stays > near.
    expect(f.frustum.far).toBeGreaterThan(f.frustum.near);
    expect(f.camera.z).toBeGreaterThan(2);
  });

  it('refuses degenerate or malformed footprints', () => {
    expect(frameTopDownOrtho([0, 0, 0, 0, 10, 1], 100)).toBeNull(); // zero X span
    expect(frameTopDownOrtho([0, 0, 0, 10, 0, 1], 100)).toBeNull(); // zero Y span
    expect(frameTopDownOrtho([5, 5, 0, 4, 10, 1], 100)).toBeNull(); // inverted
    expect(frameTopDownOrtho([NaN, 0, 0, 10, 10, 1], 100)).toBeNull(); // NaN
  });
});

describe('framing + world file describe the delivered raster', () => {
  // A 1 km USGS tile in its local frame: data spans 999.99 m, origin
  // (261000, 3195000). The world file must divide the framed width by the
  // width of the PNG actually delivered.
  const aabb = [0.0, 0.01, 0, 999.99, 1000, 40] as const;
  const origin = { x: 261000, y: 3195000 };

  it.each([2048, 3072])('pixel x %i px = framed width; corners land on the frustum', (deliveredW) => {
    const f = frameTopDownOrtho(aabb, 2048)!;
    const frustumW = f.frustum.right - f.frustum.left;
    const deliveredH = Math.round(f.heightPx * (deliveredW / f.widthPx));
    const pgw = buildWorldFileText({ extent: f.extent, widthPx: deliveredW, heightPx: deliveredH, worldOrigin: origin })!
      .trim().split('\n').map(Number);
    const [a, , , e, c, ff] = pgw as [number, number, number, number, number, number];
    expect(a * deliveredW).toBeCloseTo(frustumW, 9);
    expect(a).toBeCloseTo(999.99 / deliveredW, 9);
    // Upper-left corner = frustum left/top; lower-right = frustum right/bottom.
    expect(c - a / 2).toBeCloseTo(origin.x + f.camera.x + f.frustum.left, 6);
    expect(ff - e / 2).toBeCloseTo(origin.y + f.camera.y + f.frustum.top, 6);
    expect(c - a / 2 + a * deliveredW).toBeCloseTo(origin.x + 999.99, 6);
    expect(ff - e / 2 + e * deliveredH).toBeCloseTo(origin.y + f.extent.minY, 1);
  });
});
