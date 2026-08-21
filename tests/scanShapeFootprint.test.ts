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
 */

import { describe, it, expect } from 'vitest';
import { classifyScanShape, type ScanShape } from '../src/terrain/scanShape';

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
});
