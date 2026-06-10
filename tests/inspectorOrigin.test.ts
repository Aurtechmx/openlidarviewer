/**
 * Regression tests for the v0.4.3 inspector double-origin bug.
 *
 * `makePointInfo` adds the load-time origin back, so `PointInfo.x/y/z` ARE
 * world coordinates. The inspector card must therefore render the World
 * group straight from `info.x/y/z` and derive Local as `info − origin` —
 * adding the origin a second time doubled every easting/northing and fed
 * the doubled values into the WGS-84 projection.
 */
import { makePointInfo, splitPointCoords } from '../src/render/pointInfo';
import type { RawPointInfo } from '../src/render/pointInfo';

/** A georeferenced pick: large UTM origin, small local residual. */
function georefRaw(): RawPointInfo {
  return {
    layer: 'survey.laz',
    index: 7,
    local: [0.789, 0.105, 0.34],
    origin: [412345, 4587234, 118],
    distance: 25.5,
    intensity: null,
    classification: null,
    rgb: null,
  };
}

test('makePointInfo with a non-zero origin yields WORLD coordinates', () => {
  const info = makePointInfo(georefRaw());
  // info.x/y/z are local + origin — the absolute survey position.
  expect(info.x).toBe(412345.789);
  expect(info.y).toBe(4587234.105);
  expect(info.z).toBe(118.34);
});

test('splitPointCoords: world is info verbatim, local is info minus origin', () => {
  const info = makePointInfo(georefRaw());
  const split = splitPointCoords(info, [412345, 4587234, 118]);
  // World comes straight from info — NOT info + origin (the v0.4.3 bug
  // would have produced x ≈ 824690.789 here).
  expect(split.world).toEqual({ x: 412345.789, y: 4587234.105, z: 118.34 });
  // Local recovers the recentred render-buffer position. Precision 8:
  // subtracting a ~4.6e6 origin from a double leaves up to ~5e-10 of
  // representation error, right at the 9-digit tolerance boundary.
  expect(split.local).not.toBeNull();
  expect(split.local!.x).toBeCloseTo(0.789, 8);
  expect(split.local!.y).toBeCloseTo(0.105, 8);
  expect(split.local!.z).toBeCloseTo(0.34, 8);
});

test('splitPointCoords: no origin → single frame (local is null)', () => {
  const info = makePointInfo({ ...georefRaw(), local: [1, 2, 3], origin: [0, 0, 0] });
  const split = splitPointCoords(info, undefined);
  expect(split.world).toEqual({ x: 1, y: 2, z: 3 });
  // local == world when no origin shift exists; the card shows one group.
  expect(split.local).toBeNull();
});

test('splitPointCoords never doubles the origin (world stays < 2x origin)', () => {
  const info = makePointInfo(georefRaw());
  const split = splitPointCoords(info, [412345, 4587234, 118]);
  // Guard against the exact failure mode: world must be near the origin
  // magnitude, not near twice it.
  expect(Math.abs(split.world.x - 412345)).toBeLessThan(10);
  expect(Math.abs(split.world.y - 4587234)).toBeLessThan(10);
});
