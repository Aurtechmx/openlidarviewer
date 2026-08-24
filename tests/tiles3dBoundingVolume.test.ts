import { describe, expect, it } from 'vitest';
import {
  aabbFromPoints,
  boxCorners,
  boxToAabb,
  ecefToGeodetic,
  geodeticToEcef,
  pointInBox,
  pointInRegion,
  pointInSphere,
  regionToAabb,
  sphereToAabb,
  WGS84_A,
  WGS84_B,
  type Aabb,
} from '../src/io/tiles3d/boundingVolume';

const DEG = Math.PI / 180;

/** Sort corners so a hand-written expected set can be compared order-free. */
function sortPoints(points: readonly (readonly number[])[]): number[][] {
  return points
    .map((p) => [p[0]!, p[1]!, p[2]!])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
}

function expectPointsClose(actual: readonly (readonly number[])[], expected: number[][], tol: number) {
  const a = sortPoints(actual);
  const e = sortPoints(expected);
  expect(a).toHaveLength(e.length);
  for (let i = 0; i < e.length; i++) {
    for (let k = 0; k < 3; k++) expect(a[i]![k]!).toBeCloseTo(e[i]![k]!, tol);
  }
}

function inside(aabb: Aabb, p: readonly number[], tol: number): boolean {
  for (let k = 0; k < 3; k++) {
    if (p[k]! < aabb.min[k]! - tol) return false;
    if (p[k]! > aabb.max[k]! + tol) return false;
  }
  return true;
}

describe('boxCorners', () => {
  it('gives the eight corners of an axis-aligned box', () => {
    // Centre (10, 20, 30), half-extents 1, 2, 3 written as axis-aligned half-axes.
    const box = [10, 20, 30, 1, 0, 0, 0, 2, 0, 0, 0, 3];
    const expected: number[][] = [];
    for (const x of [9, 11]) for (const y of [18, 22]) for (const z of [27, 33]) expected.push([x, y, z]);
    expectPointsClose(boxCorners(box), expected, 10);
  });

  it('gives the corners of a box rotated 45 degrees about z', () => {
    const c = Math.SQRT1_2; // cos(45deg) = sin(45deg)
    // Unit-length half-axes at +45 and +135 degrees, unit half-axis on z.
    const box = [0, 0, 0, c, c, 0, -c, c, 0, 0, 0, 1];
    // centre +- (c,c,0) +- (-c,c,0) gives (0, +-sqrt2, 0) and (+-sqrt2, 0, 0).
    const s = Math.SQRT2;
    const expected: number[][] = [];
    for (const [x, y] of [
      [s, 0],
      [-s, 0],
      [0, s],
      [0, -s],
    ]) {
      for (const z of [-1, 1]) expected.push([x!, y!, z]);
    }
    expectPointsClose(boxCorners(box), expected, 10);
  });

  it('gives the corners of a box with non-uniform half-axes', () => {
    const box = [1, 1, 1, 2, 0, 0, 0, 5, 0, 0, 0, 0.5];
    const expected: number[][] = [];
    for (const x of [-1, 3]) for (const y of [-4, 6]) for (const z of [0.5, 1.5]) expected.push([x, y, z]);
    expectPointsClose(boxCorners(box), expected, 10);
  });

  it('is not an axis-aligned reading of the twelve numbers', () => {
    const c = Math.SQRT1_2;
    const box = [0, 0, 0, c, c, 0, -c, c, 0, 0, 0, 1];
    // A naive centre +- (halfAxis components as extents) reading would return
    // x in [-c, c] = [-0.7071, 0.7071]; the real corners reach sqrt(2).
    const xs = boxCorners(box).map((p) => p[0]!);
    expect(Math.max(...xs)).toBeCloseTo(Math.SQRT2, 10);
    expect(Math.max(...xs)).toBeGreaterThan(c + 0.5);
  });
});

describe('aabbFromPoints', () => {
  it('bounds a hand-written point set', () => {
    const aabb = aabbFromPoints([
      [1, -2, 3],
      [-4, 5, 0],
      [0, 0, -6],
    ]);
    expect(aabb.min).toEqual([-4, -2, -6]);
    expect(aabb.max).toEqual([1, 5, 3]);
  });

  it('bounds a single point to itself', () => {
    const aabb = aabbFromPoints([[7, 8, 9]]);
    expect(aabb.min).toEqual([7, 8, 9]);
    expect(aabb.max).toEqual([7, 8, 9]);
  });

  it('refuses an empty set', () => {
    expect(() => aabbFromPoints([])).toThrow(/no points/i);
  });
});

describe('boxToAabb', () => {
  it('bounds an axis-aligned box exactly', () => {
    const aabb = boxToAabb([10, 20, 30, 1, 0, 0, 0, 2, 0, 0, 0, 3]);
    expect(aabb.min).toEqual([9, 18, 27]);
    expect(aabb.max).toEqual([11, 22, 33]);
  });

  it('grows to sqrt(2) for a box rotated 45 degrees', () => {
    const c = Math.SQRT1_2;
    const aabb = boxToAabb([0, 0, 0, c, c, 0, -c, c, 0, 0, 0, 1]);
    for (const k of [0, 1]) {
      expect(aabb.min[k]!).toBeCloseTo(-Math.SQRT2, 10);
      expect(aabb.max[k]!).toBeCloseTo(Math.SQRT2, 10);
    }
    expect(aabb.min[2]!).toBeCloseTo(-1, 10);
    expect(aabb.max[2]!).toBeCloseTo(1, 10);
  });

  it('bounds non-uniform half-axes', () => {
    const aabb = boxToAabb([1, 1, 1, 2, 0, 0, 0, 5, 0, 0, 0, 0.5]);
    expect(aabb.min).toEqual([-1, -4, 0.5]);
    expect(aabb.max).toEqual([3, 6, 1.5]);
  });
});

describe('sphereToAabb', () => {
  it('bounds a sphere by centre plus and minus radius', () => {
    const aabb = sphereToAabb([1, 2, 3, 4]);
    expect(aabb.min).toEqual([-3, -2, -1]);
    expect(aabb.max).toEqual([5, 6, 7]);
  });
});

describe('geodeticToEcef', () => {
  it('places the prime-meridian equator point at (a, 0, 0)', () => {
    const p = geodeticToEcef(0, 0, 0);
    expect(p[0]!).toBeCloseTo(WGS84_A, 6);
    expect(p[1]!).toBeCloseTo(0, 6);
    expect(p[2]!).toBeCloseTo(0, 6);
  });

  it('places the north pole at (0, 0, b)', () => {
    const p = geodeticToEcef(0, Math.PI / 2, 0);
    expect(Math.hypot(p[0]!, p[1]!)).toBeLessThan(1e-6);
    expect(p[2]!).toBeCloseTo(WGS84_B, 6);
  });

  it('adds height along the ellipsoid normal at the equator', () => {
    const p = geodeticToEcef(0, 0, 1000);
    expect(p[0]!).toBeCloseTo(WGS84_A + 1000, 6);
  });

  it('round-trips through ecefToGeodetic', () => {
    for (const lat of [-80, -30, 0, 17, 62, 89].map((d) => d * DEG)) {
      for (const lon of [-179, -90, 0, 45, 179].map((d) => d * DEG)) {
        for (const h of [-500, 0, 12000]) {
          const [rlon, rlat, rh] = ecefToGeodetic(geodeticToEcef(lon, lat, h));
          expect(rlon).toBeCloseTo(lon, 9);
          expect(rlat).toBeCloseTo(lat, 9);
          expect(rh).toBeCloseTo(h, 4);
        }
      }
    }
  });
});

/**
 * The dense-surface proof. Every sample of a region's two bounding height
 * surfaces must lie inside the returned AABB.
 */
const SURFACE_STEPS = 40; // 41 x 41 samples per height surface.
let totalSurfaceSamples = 0;

function assertContainsSurface(region: readonly number[], tol = 1e-6): number {
  const aabb = regionToAabb(region);
  const west = region[0]!;
  const south = region[1]!;
  let east = region[2]!;
  const north = region[3]!;
  if (east < west) east += Math.PI * 2;
  const lonSpan = east - west;
  const latSpan = north - south;
  let count = 0;
  for (let i = 0; i <= SURFACE_STEPS; i++) {
    const lon = west + (lonSpan * i) / SURFACE_STEPS;
    for (let j = 0; j <= SURFACE_STEPS; j++) {
      const lat = south + (latSpan * j) / SURFACE_STEPS;
      for (const h of [region[4]!, region[5]!]) {
        const p = geodeticToEcef(lon, lat, h);
        count++;
        if (!inside(aabb, p, tol)) {
          throw new Error(
            `sample lon=${lon} lat=${lat} h=${h} -> ${p.join(',')} outside ${JSON.stringify(aabb)}`,
          );
        }
      }
    }
  }
  totalSurfaceSamples += count;
  return count;
}

describe('regionToAabb dense-surface containment', () => {
  const cases: { name: string; region: number[] }[] = [
    { name: 'equator', region: [-5 * DEG, -5 * DEG, 5 * DEG, 5 * DEG, 0, 100] },
    { name: 'mid latitude', region: [8 * DEG, 40 * DEG, 12 * DEG, 44 * DEG, -50, 2500] },
    { name: 'high latitude', region: [20 * DEG, 78 * DEG, 30 * DEG, 84 * DEG, 0, 1000] },
    { name: 'antimeridian crossing', region: [175 * DEG, -20 * DEG, -175 * DEG, -10 * DEG, 0, 500] },
    { name: 'tall height range', region: [-70 * DEG, -20 * DEG, -68 * DEG, -18 * DEG, -400, 9000] },
    { name: 'large longitude span', region: [-45 * DEG, -10 * DEG, 45 * DEG, 10 * DEG, 0, 200] },
  ];

  for (const { name, region } of cases) {
    it(`contains every surface sample: ${name}`, () => {
      const n = assertContainsSurface(region);
      expect(n).toBe((SURFACE_STEPS + 1) * (SURFACE_STEPS + 1) * 2);
    });

    it(`stays a plausible size: ${name}`, () => {
      const aabb = regionToAabb(region);
      const limit = WGS84_A + Math.max(0, region[5]!) + 200000;
      for (let k = 0; k < 3; k++) {
        expect(aabb.max[k]! - aabb.min[k]!).toBeLessThanOrEqual(2 * limit);
        expect(Number.isFinite(aabb.min[k]!)).toBe(true);
        expect(Number.isFinite(aabb.max[k]!)).toBe(true);
      }
    });
  }

  it('verifies a known total number of surface samples', () => {
    // 6 regions x 41 x 41 x 2 height surfaces.
    expect(totalSurfaceSamples).toBe(cases.length * 41 * 41 * 2);
  });
});

describe('regionToAabb against a corner-only bound', () => {
  it('reaches the equatorial bulge that a corner-only AABB misses', () => {
    // 90 degrees of longitude at the equator, on the ellipsoid.
    const region = [-45 * DEG, 0, 45 * DEG, 0, 0, 0];
    // Hand-computed: the region's own x extreme is at lon = 0, x = a.
    // Its eight geographic corners only reach x = a * cos(45deg).
    const cornerMaxX = WGS84_A * Math.SQRT1_2;
    const cornerAabb = aabbFromPoints([
      geodeticToEcef(-45 * DEG, 0, 0),
      geodeticToEcef(45 * DEG, 0, 0),
    ]);
    expect(cornerAabb.max[0]!).toBeCloseTo(cornerMaxX, 6);

    const bulge = geodeticToEcef(0, 0, 0);
    expect(bulge[0]!).toBeCloseTo(WGS84_A, 6);

    // The corner-only bound EXCLUDES a real point of the region: this is why
    // the corner method was rejected.
    expect(inside(cornerAabb, bulge, 1e-6)).toBe(false);
    expect(WGS84_A - cornerAabb.max[0]!).toBeGreaterThan(1.8e6);

    // The sampled bound contains it.
    const aabb = regionToAabb(region);
    expect(inside(aabb, bulge, 0)).toBe(true);
    expect(aabb.max[0]!).toBeGreaterThanOrEqual(WGS84_A);
  });

  it('reaches the pole for a region whose north edge is the pole', () => {
    const region = [0, 85 * DEG, 90 * DEG, Math.PI / 2, 0, 0];
    const aabb = regionToAabb(region);
    // Hand-computed: the north pole on WGS84 sits at z = b.
    expect(aabb.max[2]!).toBeGreaterThanOrEqual(WGS84_B);
  });

  it('handles an antimeridian region by unwrapping, not by ignoring it', () => {
    const region = [179 * DEG, -1 * DEG, -179 * DEG, 1 * DEG, 0, 0];
    const aabb = regionToAabb(region);
    // Hand-computed: lon = 180deg, lat = 0, h = 0 gives x = -a, y = 0.
    const p = geodeticToEcef(Math.PI, 0, 0);
    expect(p[0]!).toBeCloseTo(-WGS84_A, 6);
    expect(inside(aabb, p, 0)).toBe(true);
    // A wrapped reading (west..east taken as -179..179) would span the far side
    // of the globe and reach x = +a. This bound does not.
    expect(aabb.max[0]!).toBeLessThan(0);
  });

  it('bounds a degenerate point region to that point', () => {
    const region = [0, 0, 0, 0, 0, 0];
    const aabb = regionToAabb(region);
    expect(aabb.min[0]!).toBeCloseTo(WGS84_A, 6);
    expect(aabb.max[0]!).toBeCloseTo(WGS84_A, 6);
    expect(aabb.min[1]!).toBeCloseTo(0, 6);
    expect(aabb.max[2]!).toBeCloseTo(0, 6);
  });
});

describe('pointInBox', () => {
  const c = Math.SQRT1_2;
  const rotated = [0, 0, 0, c, c, 0, -c, c, 0, 0, 0, 1];

  it('accepts the centre and rejects a far point', () => {
    expect(pointInBox(rotated, [0, 0, 0])).toBe(true);
    expect(pointInBox(rotated, [10, 0, 0])).toBe(false);
  });

  it('uses half-axis projection, not the AABB', () => {
    // The rotated box's AABB reaches x = sqrt(2) = 1.4142, but along +x the box
    // itself only reaches x = 1 (projection onto each unit half-axis is c*x,
    // and c * 1 = 0.7071 <= 1 while c * 1.2 = 0.8485 <= 1, c * 1.5 = 1.0607 > 1).
    expect(pointInBox(rotated, [1.2, 0, 0])).toBe(true);
    expect(pointInBox(rotated, [1.5, 0, 0])).toBe(false);
    // (1.3, 1.3, 0) is outside the box (projection onto the first half-axis is
    // c*1.3 + c*1.3 = 1.838 > 1) but inside its AABB, whose x and y both reach
    // sqrt(2) = 1.4142. An AABB test would wrongly accept it.
    expect(pointInBox(rotated, [1.3, 1.3, 0])).toBe(false);
    expect(inside(boxToAabb(rotated), [1.3, 1.3, 0], 0)).toBe(true);
  });

  it('accepts a corner and rejects just past it', () => {
    expect(pointInBox(rotated, [Math.SQRT2, 0, 1], 1e-12)).toBe(true);
    expect(pointInBox(rotated, [Math.SQRT2 + 1e-3, 0, 1])).toBe(false);
  });

  it('respects non-uniform half-axes per axis', () => {
    const box = [1, 1, 1, 2, 0, 0, 0, 5, 0, 0, 0, 0.5];
    expect(pointInBox(box, [2.9, 5.9, 1.4])).toBe(true);
    expect(pointInBox(box, [3.1, 0, 1])).toBe(false);
    expect(pointInBox(box, [1, 6.1, 1])).toBe(false);
    expect(pointInBox(box, [1, 1, 1.6])).toBe(false);
  });

  it('treats a zero-length half-axis as a flat slab', () => {
    const flat = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0];
    expect(pointInBox(flat, [0.5, 0.5, 0])).toBe(true);
    expect(pointInBox(flat, [0.5, 0.5, 0.1])).toBe(true); // z axis is degenerate: dot is 0.
  });
});

describe('pointInSphere', () => {
  it('accepts inside, boundary and rejects outside', () => {
    const sphere = [1, 2, 3, 5];
    expect(pointInSphere(sphere, [1, 2, 3])).toBe(true);
    expect(pointInSphere(sphere, [6, 2, 3])).toBe(true); // exactly r away
    expect(pointInSphere(sphere, [6.0001, 2, 3])).toBe(false);
    // 3-4-5: (4, 5, 3) is 5 from the centre in the xy plane.
    expect(pointInSphere(sphere, [4, 6, 3])).toBe(true);
    expect(pointInSphere(sphere, [5, 6, 3])).toBe(false);
  });
});

describe('pointInRegion', () => {
  const region = [8 * DEG, 40 * DEG, 12 * DEG, 44 * DEG, -50, 2500];

  it('accepts an interior ECEF point', () => {
    expect(pointInRegion(region, geodeticToEcef(10 * DEG, 42 * DEG, 500))).toBe(true);
  });

  it('rejects points above and below the height range', () => {
    expect(pointInRegion(region, geodeticToEcef(10 * DEG, 42 * DEG, 2600))).toBe(false);
    expect(pointInRegion(region, geodeticToEcef(10 * DEG, 42 * DEG, -60))).toBe(false);
  });

  it('rejects points outside the latitude range', () => {
    expect(pointInRegion(region, geodeticToEcef(10 * DEG, 45 * DEG, 0))).toBe(false);
    expect(pointInRegion(region, geodeticToEcef(10 * DEG, 39 * DEG, 0))).toBe(false);
  });

  it('rejects points outside the longitude range', () => {
    expect(pointInRegion(region, geodeticToEcef(13 * DEG, 42 * DEG, 0))).toBe(false);
    expect(pointInRegion(region, geodeticToEcef(7 * DEG, 42 * DEG, 0))).toBe(false);
  });

  it('accepts the corners within a small tolerance', () => {
    for (const lon of [8 * DEG, 12 * DEG]) {
      for (const lat of [40 * DEG, 44 * DEG]) {
        for (const h of [-50, 2500]) {
          expect(pointInRegion(region, geodeticToEcef(lon, lat, h), 1e-6)).toBe(true);
        }
      }
    }
  });

  it('handles an antimeridian region', () => {
    const crossing = [170 * DEG, -5 * DEG, -170 * DEG, 5 * DEG, 0, 1000];
    expect(pointInRegion(crossing, geodeticToEcef(Math.PI, 0, 100))).toBe(true);
    expect(pointInRegion(crossing, geodeticToEcef(175 * DEG, 0, 100))).toBe(true);
    expect(pointInRegion(crossing, geodeticToEcef(-175 * DEG, 0, 100))).toBe(true);
    expect(pointInRegion(crossing, geodeticToEcef(0, 0, 100))).toBe(false);
    expect(pointInRegion(crossing, geodeticToEcef(160 * DEG, 0, 100))).toBe(false);
    expect(pointInRegion(crossing, geodeticToEcef(-160 * DEG, 0, 100))).toBe(false);
  });

  it('agrees with the AABB on points it accepts', () => {
    const aabb = regionToAabb(region);
    for (const lon of [8.5, 10, 11.5]) {
      for (const lat of [40.5, 42, 43.5]) {
        const p = geodeticToEcef(lon * DEG, lat * DEG, 1000);
        expect(pointInRegion(region, p)).toBe(true);
        expect(inside(aabb, p, 0)).toBe(true);
      }
    }
  });
});
