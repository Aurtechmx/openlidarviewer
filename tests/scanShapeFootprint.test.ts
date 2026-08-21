/**
 * scanShapeFootprint.test.ts: the horizontal size `aspect` divides by.
 *
 * `classifyScanShape` compares `aspect` (vertical extent / horizontal footprint
 * size) against ASPECT_OBJECT (0.65) and ASPECT_SOLID (0.45). The denominator
 * used to be the larger side of the AXIS-ALIGNED horizontal bounding box, which
 * is a property of the source CRS axes and not of the scan, so the same scan
 * measured a different aspect depending on how it happened to be oriented on
 * disk. It is now the longer side of the minimum-area rectangle around the
 * horizontal outline.
 *
 * These tests pin three things: the new value does not move under rotation
 * about the vertical axis, translation or input order; the axis-aligned value
 * it replaced DOES move, by enough to cross a routing threshold; and the two
 * agree on the footprint shapes the thresholds were tuned against, so the
 * thresholds keep their meaning.
 *
 * `extent` still reports the axis-aligned box, which is what lets these tests
 * recompute the old value from a returned ScanShape.
 *
 * The last block covers the hull vertex cap. The rectangle scan is quadratic in
 * the hull vertex count, and a densely sampled convex outline puts nearly every
 * sampled point in convex position, so the scan measures at most 512 hull
 * vertices spaced by arc position. These tests pin what that costs (the
 * inscribed 512-gon's 1.9e-5) and that the retained vertices still span the
 * whole outline.
 */

import { describe, it, expect } from 'vitest';
import { classifyScanShape, footprintRect, type ScanShape } from '../src/terrain/scanShape';

/** `Math.random()` is banned in this repo; mulberry32 at a fixed seed gives the
 *  same scene on every run and on every machine. */
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

const f32 = (t: Array<[number, number, number]>): Float32Array => {
  const a = new Float32Array(t.length * 3);
  t.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
};

/** The routing verdict, i.e. everything a caller acts on. */
const verdict = (s: ScanShape) => ({
  kind: s.kind,
  spaceKind: s.spaceKind,
  nonTerrain: s.nonTerrain,
  up: s.up,
  confidence: s.confidence,
});

/** The pre-change denominator: the larger horizontal side of the AABB. */
const axisAlignedAspect = (s: ScanShape): number =>
  s.extent[2] / Math.max(s.extent[0], s.extent[1]);

const relative = (a: number, b: number): number => Math.abs(a - b) / b;

function rotatedZ(p: Float32Array, cos: number, sin: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] * cos - p[i + 1] * sin;
    out[i + 1] = p[i] * sin + p[i + 1] * cos;
    out[i + 2] = p[i + 2];
  }
  return out;
}

const turned = (p: Float32Array, deg: number): Float32Array => {
  const rad = (deg * Math.PI) / 180;
  return rotatedZ(p, Math.cos(rad), Math.sin(rad));
};

function translated(p: Float32Array, dx: number, dy: number, dz: number): Float32Array {
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = p[i] + dx;
    out[i + 1] = p[i + 1] + dy;
    out[i + 2] = p[i + 2] + dz;
  }
  return out;
}

function permuted(p: Float32Array, seed: number): Float32Array {
  const n = p.length / 3;
  const rnd = mulberry32(seed);
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out = new Float32Array(p.length);
  for (let k = 0; k < n; k++) {
    out[k * 3] = p[order[k] * 3];
    out[k * 3 + 1] = p[order[k] * 3 + 1];
    out[k * 3 + 2] = p[order[k] * 3 + 2];
  }
  return out;
}

/** Rough bare earth over an ELONGATED 40 x 24 footprint. Elongated on purpose:
 *  a rotation grows the axis-aligned box of a 40 x 24 rectangle to 45.3 at 45
 *  degrees, so the value under test has something to move by. */
function roughField(): Float32Array {
  const rnd = mulberry32(0x5ca7);
  const t: Array<[number, number, number]> = [];
  for (let i = 0; i <= 80; i++)
    for (let j = 0; j <= 48; j++) {
      const x = i * 0.5, y = j * 0.5;
      t.push([x, y, 0.02 * x + 0.0011 * (x - 20) * (x - 20) - 0.0008 * (y - 12) * (y - 12) + (rnd() - 0.5) * 0.05]);
    }
  return f32(t);
}

/** Floor + ceiling + full-height perimeter walls over a 14 x 29 footprint. */
function roomBox(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { t.push([x, y, 0]); t.push([x, y, H]); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { t.push([x, 0, z]); t.push([x, D, z]); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { t.push([0, y, z]); t.push([W, y, z]); }
  return f32(t);
}

/**
 * A single-surface pyramid over a SQUARE 20 x 20 footprint, 13.6 tall, so the
 * footprint size puts aspect at 0.68, just over ASPECT_OBJECT (0.65) and well
 * clear of ASPECT_SOLID (0.45). This is the scan the finding was about: a
 * quarter of the way round, its axis-aligned box grows to 28.3 and the old
 * aspect falls to 0.48, taking the `kind` verdict with it.
 */
function thresholdPyramid(): Float32Array {
  const t: Array<[number, number, number]> = [];
  const R = 10, H = 13.6;
  for (let x = -R; x <= R; x += 0.25)
    for (let y = -R; y <= R; y += 0.25)
      t.push([x, y, H * (1 - Math.max(Math.abs(x), Math.abs(y)) / R)]);
  return f32(t);
}

/**
 * A densely sampled CONVEX outline: a circle of radius 50 sampled at `nRim`
 * distinct angles with a small vertical spread, over a sparse interior floor so
 * the up-axis detector has a height field to score. Nearly every sampled point
 * is in convex position, so the hull vertex count tracks the sample. This is a
 * silo wall, a tunnel bore, a terrestrial scanner's outer ring.
 */
function convexOutline(nRim: number): Float32Array {
  const rnd = mulberry32(0x51101);
  const nFloor = Math.max(200, Math.floor(nRim * 0.1));
  const p = new Float32Array((nRim + nFloor) * 3);
  for (let i = 0; i < nRim; i++) {
    const a = (2 * Math.PI * i) / nRim;
    p[i * 3] = 50 * Math.cos(a);
    p[i * 3 + 1] = 50 * Math.sin(a);
    p[i * 3 + 2] = rnd() * 3;
  }
  for (let i = 0; i < nFloor; i++) {
    const a = 2 * Math.PI * rnd(), r = 50 * Math.sqrt(rnd()), b = (nRim + i) * 3;
    p[b] = r * Math.cos(a);
    p[b + 1] = r * Math.sin(a);
    p[b + 2] = rnd() * 0.05;
  }
  return p;
}

/** A cone over a disc of radius 10, its rim sampled at `nRim` angles, 13.013
 *  tall so `aspect` lands 0.1 per cent above ASPECT_OBJECT (0.65). The rim is
 *  the hull, so `nRim` decides whether the cap engages. */
function rimmedCone(nRim: number): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = -10; x <= 10; x += 0.25)
    for (let y = -10; y <= 10; y += 0.25)
      if (Math.hypot(x, y) <= 10) t.push([x, y, 13.013 * (1 - Math.hypot(x, y) / 10)]);
  for (let i = 0; i < nRim; i++) {
    const a = (2 * Math.PI * i) / nRim;
    t.push([10 * Math.cos(a), 10 * Math.sin(a), 0]);
  }
  return f32(t);
}

/** A dense circular outline of radius 1 at the origin plus a sparse tail out to
 *  x = 200. Its hull is thousands of crowded arc vertices and a handful of far
 *  ones, so the outline's size lives entirely in the vertices an index-ordered
 *  truncation would discard. */
function lollipop(nArc: number): Float32Array {
  const rnd = mulberry32(0x10771);
  const t: Array<[number, number, number]> = [];
  for (let i = 0; i < nArc; i++) {
    const a = (2 * Math.PI * i) / nArc;
    t.push([Math.cos(a), Math.sin(a), rnd() * 0.02]);
  }
  for (let x = 1; x <= 200; x += 0.5) t.push([x, (rnd() - 0.5) * 0.02, rnd() * 0.02]);
  return f32(t);
}

const SWEEP = [0, 7.3, 15, 31, 45, 60, 73.7, 90, 118, 137.5, 165];

const SCENES: ReadonlyArray<readonly [string, Float32Array]> = [
  ['rough field 40 x 24', roughField()],
  ['room box 14 x 29', roomBox()],
  ['threshold pyramid 20 x 20', thresholdPyramid()],
];

describe('scan-shape footprint size', () => {
  describe('rotation about the vertical axis', () => {
    it.each(SCENES)('holds `aspect` through a sweep of angles: %s', (_name, scene) => {
      const base = classifyScanShape(scene);
      for (const deg of SWEEP) {
        const s = classifyScanShape(turned(scene, deg));
        expect(relative(s.aspect, base.aspect)).toBeLessThan(1e-6);
      }
    });

    it.each(SCENES)('holds the routing verdict through the same sweep: %s', (_name, scene) => {
      const base = classifyScanShape(scene);
      for (const deg of SWEEP) {
        expect(verdict(classifyScanShape(turned(scene, deg)))).toEqual(verdict(base));
      }
    });

    it('is exact on the four quarter turns, which carry no trig rounding', () => {
      for (const [, scene] of SCENES) {
        const base = classifyScanShape(scene).aspect;
        for (const [cos, sin] of [[0, 1], [-1, 0], [0, -1]] as const) {
          expect(classifyScanShape(rotatedZ(scene, cos, sin)).aspect).toBe(base);
        }
      }
    });

    // Negative control. Without it, an `aspect` frozen to a constant would pass
    // every invariance test above. The bar is 5 per cent because that is what
    // the narrowest scene here can reach: a 14 x 29 box can never grow by more
    // than sqrt(14^2 + 29^2) / 29, so 9.9 per cent is its ceiling. The square
    // pyramid moves 29 per cent, which is the case the next block picks up.
    it('moves the axis-aligned footprint it replaced by more than 5 per cent', () => {
      for (const [, scene] of SCENES) {
        const base = axisAlignedAspect(classifyScanShape(scene));
        const worst = Math.max(
          ...SWEEP.map((deg) => relative(axisAlignedAspect(classifyScanShape(turned(scene, deg))), base)),
        );
        expect(worst).toBeGreaterThan(0.05);
      }
    });
  });

  describe('the routing consequence', () => {
    it('keeps a scan straddling ASPECT_OBJECT on the same side at every angle', () => {
      // The pyramid sits at 0.68 against a 0.65 bar. The axis-aligned measure
      // drops it under the bar partway round the sweep and changes `kind` with
      // it; the footprint size does not move and the verdict does not either.
      const scene = thresholdPyramid();
      const base = classifyScanShape(scene);
      expect(base.aspect).toBeGreaterThan(0.65);
      expect(base.kind).toBe('ambiguous');

      const oldValues = SWEEP.map((deg) => axisAlignedAspect(classifyScanShape(turned(scene, deg))));
      expect(Math.min(...oldValues)).toBeLessThan(0.65);
      expect(Math.max(...oldValues)).toBeGreaterThan(0.65);

      for (const deg of SWEEP) {
        const s = classifyScanShape(turned(scene, deg));
        expect(s.aspect).toBeGreaterThan(0.65);
        expect(verdict(s)).toEqual(verdict(base));
      }
    });
  });

  describe('translation', () => {
    it.each(SCENES)('holds `aspect` and the verdict when the scan moves: %s', (_name, scene) => {
      const base = classifyScanShape(scene);
      for (const [dx, dy, dz] of [[10, 0, 0], [0, -250, 0], [1000, 1000, 0], [0, 0, 500]] as const) {
        const s = classifyScanShape(translated(scene, dx, dy, dz));
        expect(relative(s.aspect, base.aspect)).toBeLessThan(1e-5);
        expect(verdict(s)).toEqual(verdict(base));
      }
    });
  });

  describe('input order', () => {
    it.each(SCENES)('holds `aspect` exactly under a shuffle: %s', (_name, scene) => {
      const base = classifyScanShape(scene);
      for (const seed of [0x1234, 0x9e37]) {
        const s = classifyScanShape(permuted(scene, seed));
        expect(s.aspect).toBe(base.aspect);
        expect(verdict(s)).toEqual(verdict(base));
      }
    });
  });

  describe('scale, so ASPECT_OBJECT and ASPECT_SOLID keep their meaning', () => {
    it('reproduces the axis-aligned max extent on an axis-aligned footprint', () => {
      for (const scene of [roughField(), roomBox(), thresholdPyramid()]) {
        const s = classifyScanShape(scene);
        expect(relative(s.aspect, axisAlignedAspect(s))).toBeLessThan(1e-6);
      }
    });

    it('reproduces the diameter on a round footprint', () => {
      // A disc of radius r has the same 2r x 2r bounding rectangle at every
      // orientation, so the two measures agree there too. The residual is the
      // lattice: a square-lattice sample of a disc supports a slightly tighter
      // rectangle off-axis than the axis-aligned box.
      const t: Array<[number, number, number]> = [];
      for (let x = -10; x <= 10; x += 0.25)
        for (let y = -10; y <= 10; y += 0.25)
          if (Math.hypot(x, y) <= 10) t.push([x, y, 15 * (1 - Math.hypot(x, y) / 10)]);
      const s = classifyScanShape(f32(t));
      expect(relative(s.aspect, axisAlignedAspect(s))).toBeLessThan(0.03);
    });

    it('measures a footprint that is elongated on the diagonal, not its box', () => {
      // A 30 x 4 slab laid at 45 degrees. Its axis-aligned box is 24 x 24, so
      // the old measure called the footprint 24 wide; the rectangle around the
      // outline calls it 30, which is its actual length.
      const t: Array<[number, number, number]> = [];
      const c = Math.SQRT1_2;
      for (let u = -15; u <= 15; u += 0.1)
        for (let v = -2; v <= 2; v += 0.1) t.push([(u - v) * c, (u + v) * c, 0.5 * Math.sin(u)]);
      const s = classifyScanShape(f32(t));
      const footprint = s.extent[2] / s.aspect;
      expect(footprint).toBeGreaterThan(29.5);
      expect(footprint).toBeLessThan(30.5);
      expect(Math.max(s.extent[0], s.extent[1])).toBeLessThan(25);
    });
  });

  describe('degenerate footprints', () => {
    it('falls back to the axis-aligned box when the outline has no area', () => {
      // Every point on one horizontal line: the hull is a segment, and its
      // length is the footprint.
      const t: Array<[number, number, number]> = [];
      for (let x = 0; x <= 20; x += 0.5) t.push([x, 3, x * 0.1]);
      const s = classifyScanShape(f32(t));
      expect(s.extent[2] / s.aspect).toBeCloseTo(20, 6);
    });

    it('survives a single repeated horizontal position', () => {
      // A footprint of one point hulls to nothing, so the axis-aligned box is
      // the fallback and the 1e-9 floor in it makes the scan read as extremely
      // compact. The up axis is forced because a zero-area footprint gives the
      // detector nothing to score, which is a separate matter from the
      // footprint size under test here.
      const t: Array<[number, number, number]> = [];
      for (let k = 0; k < 40; k++) t.push([2, 2, k * 0.25]);
      const s = classifyScanShape(f32(t), { verticalAxis: 'z' });
      expect(Number.isFinite(s.aspect)).toBe(true);
      expect(s.aspect).toBeGreaterThan(0.65);
      expect(s.nonTerrain).toBe(true);
    });
  });

  describe('densely sampled convex outlines', () => {
    // The rectangle scan is quadratic in the hull vertex count. An area-filling
    // footprint hulls to a handful of vertices, but a convex outline hulls to
    // its whole sample: 27016 vertices on an 80000-point ring, which measured
    // 5075 ms before the cap. At most HULL_SCAN_CAP = 512 vertices are measured,
    // chosen by arc position around the hull.

    it('measures the outline diameter to within the inscribed 512-gon', () => {
      // 512 vertices spaced around a circle inscribe a regular 512-gon, whose
      // width is cos(pi/512) of the circle's, so the measured size is at most
      // 1 - cos(pi/512) = 1.9e-5 short and never long.
      const s = classifyScanShape(convexOutline(72000));
      const footprint = s.extent[2] / s.aspect;
      expect(footprint).toBeLessThanOrEqual(100 * (1 + 1e-6));
      expect(relative(footprint, 100)).toBeLessThan(5e-5);
    });

    it('holds the verdict and `aspect` across the cap on a scan sitting on a bar', () => {
      // Same cone at 0.6507, 0.1 per cent above ASPECT_OBJECT (0.65). A 400-vertex
      // rim is under the cap and measured whole; a 72000-vertex rim is 140 times
      // over it. The two agree to 1e-4, which is a sixth of the distance to the
      // bar, and land on the same side of it.
      const under = classifyScanShape(rimmedCone(400));
      const over = classifyScanShape(rimmedCone(72000));
      expect(verdict(over)).toEqual(verdict(under));
      expect(Math.abs(over.aspect - under.aspect)).toBeLessThan(1e-4);
      expect(under.aspect).toBeGreaterThan(0.65);
      expect(over.aspect).toBeGreaterThan(0.65);
    });

    it('retains vertices spanning the whole outline, not one side of it', () => {
      // The lollipop's size is the 200-long tail. Keeping the first 512 hull
      // vertices in index order measures 0.16 of it, because the monotone chain
      // emits the crowded arc first. Arc position keeps the far vertices.
      const under = classifyScanShape(lollipop(200), { verticalAxis: 'z' });
      for (const nArc of [20000, 60000]) {
        const s = classifyScanShape(lollipop(nArc), { verticalAxis: 'z' });
        const footprint = s.extent[2] / s.aspect;
        expect(footprint).toBeGreaterThan(200);
        expect(relative(footprint, under.extent[2] / under.aspect)).toBeLessThan(1e-6);
      }
    });

    it('holds `aspect` through the rotation sweep above the cap', () => {
      // Above the cap the retained set is anchored at the hull's lexicographic
      // minimum, so it follows the frame and invariance is bounded by the same
      // 1.9e-5 rather than exact. The bar is 1e-4; the sweep measures 3.3e-7.
      const scene = convexOutline(72000);
      const base = classifyScanShape(scene);
      for (const deg of SWEEP) {
        const s = classifyScanShape(turned(scene, deg));
        expect(relative(s.aspect, base.aspect)).toBeLessThan(1e-4);
        expect(verdict(s)).toEqual(verdict(base));
      }
    });

    it('classifies a 79200-point convex outline without a multi-second stall', () => {
      // classifyScanShape runs synchronously on the main thread during load.
      // This scan took 5075 ms uncapped and takes about 22 ms capped; the bar is
      // 2000 ms, which is 90 times the capped cost and under half the uncapped.
      const scene = convexOutline(72000);
      classifyScanShape(scene);
      const t0 = performance.now();
      classifyScanShape(scene);
      expect(performance.now() - t0).toBeLessThan(2000);
    });
  });
});

/**
 * The same rectangle, exported for the space report.
 *
 * `aspect` divides by the long side; `SpaceMetrics.dims` prints both sides as a
 * space's L and W. The report used to derive its own pair from the covariance
 * eigenvectors of the horizontal projection, which measures a different
 * rectangle on any footprint whose covariance carries no direction.
 */
describe('footprintRect', () => {
  /** Horizontal coordinates of an interleaved xyz buffer. */
  const horizontals = (p: Float32Array): [number[], number[]] => {
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < p.length; i += 3) { xs.push(p[i]); ys.push(p[i + 1]); }
    return [xs, ys];
  };

  /** Widest distance between any two points, i.e. the footprint's diameter. */
  const diameter = (xs: readonly number[], ys: readonly number[]): number => {
    let best = 0;
    for (let i = 0; i < xs.length; i++)
      for (let j = i + 1; j < xs.length; j++) {
        const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j]);
        if (d > best) best = d;
      }
    return best;
  };

  /** A square room scanned point by point: walls, floor and ceiling, no lattice.
   *  Its covariance is isotropic, so the eigenvectors carry no direction. */
  function scannedSquareRoom(seed: number, side = 8, H = 2.6): Float32Array {
    const rnd = mulberry32(seed);
    const t: Array<[number, number, number]> = [];
    for (let i = 0; i < 12000; i++) {
      const s = rnd() * 4 * side;
      let x: number, y: number;
      if (s < side) { x = s; y = 0; }
      else if (s < 2 * side) { x = side; y = s - side; }
      else if (s < 3 * side) { x = 3 * side - s; y = side; }
      else { x = 0; y = 4 * side - s; }
      t.push([x, y, rnd() * H]);
    }
    for (let i = 0; i < 8000; i++) t.push([rnd() * side, rnd() * side, 0]);
    for (let i = 0; i < 8000; i++) t.push([rnd() * side, rnd() * side, H]);
    return f32(t);
  }

  it('reports the same long side `aspect` divides by', () => {
    // One definition for both consumers: the value the report prints as L is
    // the value the router compares against ASPECT_OBJECT. Sampled under the
    // 60000-point cap so `classifyScanShape` measures every point and the two
    // read the same footprint.
    for (const scene of [roomBox(), roughField(), thresholdPyramid()]) {
      const s = classifyScanShape(scene);
      const [xs, ys] = horizontals(scene);
      expect(xs.length).toBeLessThan(60000);
      expect(relative(footprintRect(xs, ys).longSide, s.extent[2] / s.aspect)).toBeLessThan(1e-12);
    }
  });

  it('measures the side of a square footprint, not its diagonal', () => {
    // The regression this replaced. A square's covariance is c*I, so the
    // principal direction was fixed by sampling noise and the enclosing
    // rectangle drifted toward the 11.31 m diagonal: the eigenvector estimator
    // returned 9.5351 to 11.3127 m across these ten samplings of one 8.00 m
    // room. The rectangle around the outline returns the side every time.
    for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
      const [xs, ys] = horizontals(scannedSquareRoom(seed));
      const rect = footprintRect(xs, ys);
      expect(rect.longSide).toBeCloseTo(8, 3);
      expect(rect.shortSide).toBeCloseTo(8, 3);
    }
  });

  it('holds both sides under rotation about the vertical axis', () => {
    const scene = roomBox();
    const [bx, by] = horizontals(scene);
    const base = footprintRect(bx, by);
    for (const deg of [7, 17, 31, 45, 90, 123]) {
      const [xs, ys] = horizontals(turned(scene, deg));
      const rect = footprintRect(xs, ys);
      expect(relative(rect.longSide, base.longSide)).toBeLessThan(1e-5);
      expect(relative(rect.shortSide, base.shortSide)).toBeLessThan(1e-5);
    }
  });

  it('returns a rectangle that encloses the footprint, long side first', () => {
    // Enclosure without recomputing the hull: every pair of points fits inside
    // the rectangle, so no distance can exceed its diagonal, and the widest
    // pair spans at least its long side. Point count kept small, since the
    // check is quadratic.
    const rnd = mulberry32(0xf007);
    const shapes: Array<[string, Array<[number, number]>]> = [
      ['disc', Array.from({ length: 300 }, () => {
        const a = 2 * Math.PI * rnd(), r = 6 * Math.sqrt(rnd());
        return [r * Math.cos(a), r * Math.sin(a)] as [number, number];
      })],
      ['diagonal slab', Array.from({ length: 300 }, () => {
        const u = rnd() * 30 - 15, v = rnd() * 4 - 2;
        return [(u - v) * Math.SQRT1_2, (u + v) * Math.SQRT1_2] as [number, number];
      })],
      ['L outline', Array.from({ length: 300 }, () => {
        let x = rnd() * 10, y = rnd() * 10;
        if (x > 4 && y > 4) { x -= 4; y -= 4; }
        return [x, y] as [number, number];
      })],
    ];
    for (const [, pairs] of shapes) {
      const xs = pairs.map((p) => p[0]), ys = pairs.map((p) => p[1]);
      const rect = footprintRect(xs, ys);
      const d = diameter(xs, ys);
      expect(rect.shortSide).toBeLessThanOrEqual(rect.longSide);
      expect(rect.longSide).toBeLessThanOrEqual(d * (1 + 1e-9));
      expect(Math.hypot(rect.longSide, rect.shortSide)).toBeGreaterThanOrEqual(d * (1 - 1e-9));
    }
  });

  it('measures a footprint with no area as a segment', () => {
    const xs: number[] = [], ys: number[] = [];
    for (let x = 0; x <= 20; x += 0.5) { xs.push(x); ys.push(3); }
    const rect = footprintRect(xs, ys);
    expect(rect.longSide).toBeCloseTo(20, 9);
    expect(rect.shortSide).toBe(0);
  });

  it('measures zero when there is no second distinct point', () => {
    expect(footprintRect([], [])).toEqual({ longSide: 0, shortSide: 0 });
    expect(footprintRect([2], [2])).toEqual({ longSide: 0, shortSide: 0 });
    // Repeats of one position hull to nothing measurable.
    expect(footprintRect([2, 2, 2], [2, 2, 2]).longSide).toBe(0);
  });

  it('drops non-finite coordinates instead of measuring them', () => {
    const xs = [0, 4, 4, 0], ys = [0, 0, 3, 3];
    const clean = footprintRect(xs, ys);
    const dirty = footprintRect(
      [...xs, Number.NaN, 7, Number.POSITIVE_INFINITY],
      [...ys, 9, Number.NaN, 9],
    );
    expect(dirty).toEqual(clean);
    expect(clean.longSide).toBeCloseTo(4, 9);
    expect(clean.shortSide).toBeCloseTo(3, 9);
  });
});
