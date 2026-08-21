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

  test('offset is the perpendicular distance, along is the projection', () => {
    // (3,0,-4) sits 3 units off a ray running 4 units down -Z.
    const hit = nearestPointAlongRay(new Float32Array([3, 0, -4]), origin, dir);
    expect(hit?.offset).toBeCloseTo(3, 12);
    expect(hit?.along).toBeCloseTo(4, 12);
  });

  test('a zero-length direction returns null', () => {
    const pts = new Float32Array([5, 0, -10, 0, 0, -20, 5, 5, -15]);
    expect(nearestPointAlongRay(pts, origin, [0, 0, 0])).toBeNull();
  });

  test('a non-finite direction returns null', () => {
    const pts = new Float32Array([5, 0, -10, 0, 0, -20, 5, 5, -15]);
    expect(nearestPointAlongRay(pts, origin, [NaN, 0, 0])).toBeNull();
    expect(nearestPointAlongRay(pts, origin, [Infinity, 0, 0])).toBeNull();
  });

  test('scaling the direction leaves the hit unchanged', () => {
    const pts = new Float32Array([3, 0, -4, 5, 0, -10, 0, 1, -20]);
    const unit = nearestPointAlongRay(pts, origin, dir);
    for (const scale of [0.25, 2, 3, 10]) {
      const scaled = nearestPointAlongRay(pts, origin, [0, 0, -scale]);
      expect(scaled).toEqual(unit);
    }
  });

  test('a point on the ray scores zero for any direction length', () => {
    // Callers keep a hit only when offset / along clears an angular tolerance
    // (0.07 in the Viewer). Without the entry normalisation a direction of
    // length L put the closest point L² times as far along the axis, so a point
    // sitting exactly on the ray scored (L² − 1) / L: 0.0976 at L = 1.05, 1.5 at
    // L = 2, both above the tolerance, and the pick was dropped.
    const onRay = new Float32Array([0, 0, -4]);
    for (const scale of [1, 1.05, 2, 5]) {
      const hit = nearestPointAlongRay(onRay, origin, [0, 0, -scale]);
      expect(hit).not.toBeNull();
      expect(hit!.offset / hit!.along).toBeLessThan(0.07);
      expect(hit!.along).toBeCloseTo(4, 12);
    }
  });
});

/**
 * The scan before the square root was lifted out of the loop: it walked to the
 * closest point on the ray and took a `Math.hypot` per candidate. Kept here as
 * the oracle for {@link nearestPointAlongRay}, with the direction normalised so
 * it is also correct for a caller that passes a non-unit one.
 */
function referenceNearestPointAlongRay(
  positions: Float32Array,
  origin: Vec3,
  dir: Vec3,
  accept?: (index: number) => boolean,
): { index: number; offset: number; along: number } | null {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0)) return null;
  const d: Vec3 = [dir[0] / len, dir[1] / len, dir[2] / len];
  let bestScore = Infinity;
  let bestIndex = -1;
  let bestOffset = 0;
  let bestAlong = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (accept !== undefined && !accept(i / 3)) continue;
    const vx = positions[i] - origin[0];
    const vy = positions[i + 1] - origin[1];
    const vz = positions[i + 2] - origin[2];
    const along = vx * d[0] + vy * d[1] + vz * d[2];
    if (along <= 0) continue;
    const cx = origin[0] + d[0] * along;
    const cy = origin[1] + d[1] * along;
    const cz = origin[2] + d[2] * along;
    const offset = Math.hypot(
      positions[i] - cx,
      positions[i + 1] - cy,
      positions[i + 2] - cz,
    );
    const score = offset / along;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
      bestOffset = offset;
      bestAlong = along;
    }
  }
  if (bestIndex < 0) return null;
  return { index: bestIndex / 3, offset: bestOffset, along: bestAlong };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Any unit vector perpendicular to `d`, plus its perpendicular partner. */
function perpBasis(d: Vec3): [Vec3, Vec3] {
  const s: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = s[1] * d[2] - s[2] * d[1];
  let uy = s[2] * d[0] - s[0] * d[2];
  let uz = s[0] * d[1] - s[1] * d[0];
  const len = Math.hypot(ux, uy, uz);
  ux /= len; uy /= len; uz /= len;
  return [
    [ux, uy, uz],
    [d[1] * uz - d[2] * uy, d[2] * ux - d[0] * uz, d[0] * uy - d[1] * ux],
  ];
}

describe('nearestPointAlongRay matches the pre-optimisation scan', () => {
  test('same winner and same offset / along over randomised clouds', () => {
    const rnd = mulberry32(20260821);
    const span = (lo: number, hi: number) => lo + rnd() * (hi - lo);

    let worstOffset = 0;
    let worstAlong = 0;
    let checked = 0;
    let points = 0;

    for (let c = 0; c < 240; c++) {
      // Five scene scales, because the cancellation this scan has to survive
      // grows with the distance from the origin to the cloud.
      const scale = [1, 10, 100, 1000, 1e4][c % 5];
      const origin: Vec3 = [span(-1, 1) * scale, span(-1, 1) * scale, span(-1, 1) * scale];
      let dir: Vec3;
      if (c % 7 === 0) {
        dir = ([[0, 0, -1], [1, 0, 0], [0, 1, 0]] as Vec3[])[c % 3];
      } else {
        let dx = 0, dy = 0, dz = 0, len = 0;
        do {
          dx = span(-1, 1); dy = span(-1, 1); dz = span(-1, 1);
          len = Math.hypot(dx, dy, dz);
        } while (len < 1e-6 || len > 1);
        dir = [dx / len, dy / len, dz / len];
      }
      const [u, v] = perpBasis(dir);

      const n = 2000 + Math.floor(rnd() * 2000);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const kind = rnd();
        const t = span(0.05, 2) * scale;
        let x: number, y: number, z: number;
        if (kind < 0.3) {
          // Hugging the axis: the near-tie regime, where two candidates can
          // agree on angular miss to a few parts in 1e9.
          const r = span(0, 1e-3) * scale;
          const a = span(0, Math.PI * 2);
          x = origin[0] + dir[0] * t + (u[0] * Math.cos(a) + v[0] * Math.sin(a)) * r;
          y = origin[1] + dir[1] * t + (u[1] * Math.cos(a) + v[1] * Math.sin(a)) * r;
          z = origin[2] + dir[2] * t + (u[2] * Math.cos(a) + v[2] * Math.sin(a)) * r;
        } else if (kind < 0.4) {
          // Exactly on the ray.
          x = origin[0] + dir[0] * t;
          y = origin[1] + dir[1] * t;
          z = origin[2] + dir[2] * t;
        } else if (kind < 0.5 && i > 0) {
          // Exact duplicate of the previous point: a hard tie.
          x = pos[(i - 1) * 3]; y = pos[(i - 1) * 3 + 1]; z = pos[(i - 1) * 3 + 2];
        } else if (kind < 0.65) {
          // Behind the origin.
          x = origin[0] - dir[0] * t + span(-1, 1) * scale * 0.2;
          y = origin[1] - dir[1] * t + span(-1, 1) * scale * 0.2;
          z = origin[2] - dir[2] * t + span(-1, 1) * scale * 0.2;
        } else {
          x = origin[0] + dir[0] * t + span(-1, 1) * scale * 0.5;
          y = origin[1] + dir[1] * t + span(-1, 1) * scale * 0.5;
          z = origin[2] + dir[2] * t + span(-1, 1) * scale * 0.5;
        }
        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      }

      // Every fourth cloud runs an accept predicate that rejects most points.
      let accept: ((index: number) => boolean) | undefined;
      if (c % 4 === 3) {
        const keep = new Uint8Array(n);
        for (let i = 0; i < n; i++) keep[i] = rnd() < 0.08 ? 1 : 0;
        accept = (i) => keep[i] === 1;
      }

      const hit = nearestPointAlongRay(pos, origin, dir, accept);
      const ref = referenceNearestPointAlongRay(pos, origin, dir, accept);
      points += n;
      checked++;

      expect(hit === null).toBe(ref === null);
      if (hit === null || ref === null) continue;
      expect(hit.index).toBe(ref.index);
      const dOffset = Math.abs(hit.offset - ref.offset);
      const dAlong = Math.abs(hit.along - ref.along);
      expect(dOffset).toBeLessThanOrEqual(1e-10 * Math.max(1, ref.along));
      expect(dAlong).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(ref.along)));
      worstOffset = Math.max(worstOffset, dOffset / Math.max(1, ref.along));
      worstAlong = Math.max(worstAlong, dAlong / Math.max(1, Math.abs(ref.along)));
    }

    expect(checked).toBe(240);
    expect(points).toBeGreaterThan(240 * 2000);
    // Measured on the committed scan: 1.8e-16 of `along`, and `along` itself
    // matches the oracle bit for bit.
    expect(worstOffset).toBeLessThan(1e-12);
    expect(worstAlong).toBeLessThan(1e-12);
  });

  test('a non-unit direction reports the true perpendicular distance', () => {
    // (3,0,-4) against a ray down -Z: along = 4, offset = 3. Reading the same
    // point with a direction of length 3 and no normalisation walked to
    // (0,0,-36) and measured hypot(3, 0, 32) = 32.14 from 12 along the ray.
    const pts = new Float32Array([3, 0, -4]);
    const at: Vec3 = [0, 0, 0];
    const ref = referenceNearestPointAlongRay(pts, at, [0, 0, -3]);
    const hit = nearestPointAlongRay(pts, at, [0, 0, -3]);
    expect(hit?.offset).toBeCloseTo(ref!.offset, 12);
    expect(hit?.along).toBeCloseTo(ref!.along, 12);
    expect(hit?.offset).toBeCloseTo(3, 12);
    expect(hit?.along).toBeCloseTo(4, 12);
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
