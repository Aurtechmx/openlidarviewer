import {
  desiredVelocity,
  smoothVelocity,
  speedForSize,
  easeInOutCubic,
  nearestPointAlongRay,
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
});
