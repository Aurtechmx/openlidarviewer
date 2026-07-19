import {
  desiredVelocity,
  smoothVelocity,
  speedForSize,
  easeInOutCubic,
  orbitOffset,
  nearestPointAlongRay,
  formatDistance,
} from '../src/render/navMath';
import type { MoveKeys, Vec3 } from '../src/render/navMath';

const NO_KEYS: MoveKeys = {
  forward: false, backward: false, left: false, right: false, up: false, down: false,
};
const FWD: Vec3 = [0, 0, -1];
const RIGHT: Vec3 = [1, 0, 0];
const UP: Vec3 = [0, 1, 0];

function mag(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

describe('desiredVelocity', () => {
  test('no keys held → zero velocity', () => {
    expect(desiredVelocity(NO_KEYS, FWD, RIGHT, UP, 10)).toEqual([0, 0, 0]);
  });

  test('forward only → full speed along the forward vector', () => {
    const v = desiredVelocity({ ...NO_KEYS, forward: true }, FWD, RIGHT, UP, 10);
    expect(v).toEqual([0, 0, -10]);
  });

  test('opposite keys cancel out', () => {
    const v = desiredVelocity({ ...NO_KEYS, forward: true, backward: true }, FWD, RIGHT, UP, 10);
    expect(v).toEqual([0, 0, 0]);
  });

  test('diagonal movement is not faster than straight movement', () => {
    const diagonal = desiredVelocity(
      { ...NO_KEYS, forward: true, right: true }, FWD, RIGHT, UP, 10,
    );
    expect(mag(diagonal)).toBeCloseTo(10, 6);
  });

  test('up key moves along the up vector', () => {
    const v = desiredVelocity({ ...NO_KEYS, up: true }, FWD, RIGHT, UP, 7);
    expect(v).toEqual([0, 7, 0]);
  });
});

describe('smoothVelocity', () => {
  test('dt of 0 leaves the velocity unchanged', () => {
    expect(smoothVelocity([1, 2, 3], [9, 9, 9], 0)).toEqual([1, 2, 3]);
  });

  test('moves the current velocity toward the target', () => {
    const next = smoothVelocity([0, 0, 0], [10, 0, 0], 0.05);
    expect(next[0]).toBeGreaterThan(0);
    expect(next[0]).toBeLessThan(10);
  });

  test('a long step converges close to the target', () => {
    const next = smoothVelocity([0, 0, 0], [10, 0, 0], 5);
    expect(next[0]).toBeCloseTo(10, 3);
  });

  test('is frame-rate independent — two half steps ≈ one full step', () => {
    const full = smoothVelocity([0, 0, 0], [10, 0, 0], 0.1);
    const half = smoothVelocity(smoothVelocity([0, 0, 0], [10, 0, 0], 0.05), [10, 0, 0], 0.05);
    expect(half[0]).toBeCloseTo(full[0], 6);
  });
});

describe('speedForSize', () => {
  test('scales with the cloud size', () => {
    expect(speedForSize(1000)).toBeGreaterThan(speedForSize(10));
  });

  test('a tiny cloud still gets a usable floor speed', () => {
    expect(speedForSize(0)).toBeGreaterThan(0);
  });
});

describe('easeInOutCubic', () => {
  test('fixed points at 0, 0.5 and 1', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 6);
    expect(easeInOutCubic(1)).toBe(1);
  });

  test('clamps out-of-range input', () => {
    expect(easeInOutCubic(-1)).toBe(0);
    expect(easeInOutCubic(2)).toBe(1);
  });
});

describe('formatDistance', () => {
  test('shows centimetres below one metre', () => {
    expect(formatDistance(0.5)).toBe('50.0 cm');
  });
  test('shows metres up to a kilometre', () => {
    expect(formatDistance(12.484)).toBe('12.48 m');
  });
  test('shows kilometres beyond', () => {
    expect(formatDistance(2500)).toBe('2.500 km');
  });
  test('the band is chosen by magnitude, so a negative reads in the same unit', () => {
    // A signed value (a profile elevation below the render origin) used to
    // pass `meters < 1` and print as centimetres — -411.865 m surfaced as
    // "-41186.5 cm". The band belongs to how big the number is, not which
    // side of zero it sits on.
    expect(formatDistance(-411.865)).toBe('-411.87 m');
    expect(formatDistance(-12.484)).toBe('-12.48 m');
    expect(formatDistance(-0.5)).toBe('-50.0 cm');
    expect(formatDistance(-2500)).toBe('-2.500 km');
    expect(formatDistance(-5000)).toBe('-5.000 km');
  });
});

describe('nearestPointAlongRay', () => {
  const origin: Vec3 = [0, 0, 0];
  const dir: Vec3 = [0, 0, -1]; // looking down -Z

  test('returns null for an empty cloud', () => {
    expect(nearestPointAlongRay(new Float32Array(0), origin, dir)).toBeNull();
  });

  test('picks the point sitting on the ray', () => {
    // Three points: one on the ray, two off to the side.
    const pts = new Float32Array([5, 0, -10, 0, 0, -20, 5, 5, -15]);
    const hit = nearestPointAlongRay(pts, origin, dir);
    expect(hit?.index).toBe(1); // (0,0,-20) lies exactly on the ray
    expect(hit?.offset).toBeCloseTo(0, 6);
  });

  test('ignores points behind the origin', () => {
    // The only candidate is behind the camera (+Z) → no hit.
    const pts = new Float32Array([0, 0, 10]);
    expect(nearestPointAlongRay(pts, origin, dir)).toBeNull();
  });

  test('reports the picked point coordinates', () => {
    const pts = new Float32Array([0, 0, -8]);
    const hit = nearestPointAlongRay(pts, origin, dir);
    expect(hit?.point).toEqual([0, 0, -8]);
    expect(hit?.along).toBeCloseTo(8, 6);
  });

  test('an accept predicate that admits everything is identical to no predicate', () => {
    const pts = new Float32Array([5, 0, -10, 0, 0, -20, 5, 5, -15]);
    const withoutPred = nearestPointAlongRay(pts, origin, dir);
    const withTrue = nearestPointAlongRay(pts, origin, dir, () => true);
    expect(withTrue).toEqual(withoutPred);
    expect(withTrue?.index).toBe(1);
  });

  test('rejecting the true-nearest returns the next-nearest accepted point', () => {
    // Index 1 (0,0,-20) sits on the ray and would win; reject it and the
    // runner-up — the nearest-by-angle of the remaining points — is surfaced
    // rather than "nothing".
    const pts = new Float32Array([5, 0, -10, 0, 0, -20, 5, 5, -15]);
    const hit = nearestPointAlongRay(pts, origin, dir, (i) => i !== 1);
    expect(hit).not.toBeNull();
    expect(hit?.index).not.toBe(1);
    // It must be one of the remaining (accepted) candidates.
    expect([0, 2]).toContain(hit?.index);
  });

  test('rejecting every point returns the same no-hit sentinel as before', () => {
    const pts = new Float32Array([5, 0, -10, 0, 0, -20, 5, 5, -15]);
    expect(nearestPointAlongRay(pts, origin, dir, () => false)).toBeNull();
  });
});

describe('orbitOffset', () => {
  const Z_UP: Vec3 = [0, 0, 1];

  test('zero yaw and pitch leaves the offset unchanged', () => {
    const out = orbitOffset([10, 0, 0], Z_UP, 0, 0);
    expect(out[0]).toBeCloseTo(10, 6);
    expect(out[1]).toBeCloseTo(0, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });

  test('yaw rotates the offset around the up axis', () => {
    // A quarter turn around Z takes +X to +Y.
    const out = orbitOffset([10, 0, 0], Z_UP, Math.PI / 2, 0);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(10, 6);
    expect(out[2]).toBeCloseTo(0, 6);
  });

  test('positive pitch raises the viewpoint toward the up pole', () => {
    const out = orbitOffset([10, 0, 0], Z_UP, 0, Math.PI / 4);
    expect(out[2]).toBeGreaterThan(0); // lifted along +Z
    expect(mag(out)).toBeCloseTo(10, 6); // distance preserved
  });

  test('distance from the target is always preserved', () => {
    const out = orbitOffset([3, -4, 12], Z_UP, 1.1, -0.6);
    expect(mag(out)).toBeCloseTo(13, 6);
  });

  test('a huge pitch is clamped clear of the pole — the view never flips', () => {
    // From the equator, an enormous up-pitch must stop just shy of the pole,
    // not swing past it (which would invert the view).
    const out = orbitOffset([10, 0, 0], Z_UP, 0, 100);
    expect(out[2]).toBeGreaterThan(9.9); // almost straight above
    expect(out[2]).toBeLessThan(10); // but never exactly at the pole
  });

  test('a degenerate zero-length offset is returned unchanged', () => {
    expect(orbitOffset([0, 0, 0], Z_UP, 1, 1)).toEqual([0, 0, 0]);
  });

  test('yaw at a pole still preserves distance (seeded horizontal axis)', () => {
    const out = orbitOffset([0, 0, 10], Z_UP, Math.PI / 3, 0);
    expect(mag(out)).toBeCloseTo(10, 6);
  });
});
