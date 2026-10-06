import { describe, it, expect } from 'vitest';
import {
  MAX_SAFE_INDEX,
  buildWorkplaneGeometry,
  fadeAlphas,
  patchFor,
  planeCoordsOf,
  FADE_ZERO_PX,
  MAX_HALF_MAJORS,
  type WorkplaneFadeCamera,
  type WorkplaneGeometry,
  type WorkplaneLineSet,
} from '../src/render/workplane/workplaneGeometry';
import { dot, planeFromThreePoints, principalPlane, sub, type Vec3 } from '../src/render/workplane/workplanePlane';
import { workplaneReadout, workplaneUnits } from '../src/render/workplane/workplaneReadout';

/** Every vertex as a source coordinate, rebuilt as the GPU sees it: Float32 vertex + Float64 anchor + datum. */
function sourceVertices(set: WorkplaneLineSet, g: WorkplaneGeometry, sceneOrigin: Vec3): Vec3[] {
  const out: Vec3[] = [];
  const b = set.vertices;
  for (let i = 0; i < b.length; i += 3) {
    out.push([b[i] + g.anchorScene[0] + sceneOrigin[0], b[i + 1] + g.anchorScene[1] + sceneOrigin[1], b[i + 2] + g.anchorScene[2] + sceneOrigin[2]]);
  }
  return out;
}

const ZERO: Vec3 = [0, 0, 0];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

describe('grid lines are anchored to the origin, not the camera', () => {
  const plane = principalPlane('horizontal', [3, 7, 100], 'z');
  const base = { plane, major: 5, minor: 1, showMinor: true, sceneOrigin: ZERO };
  const patch = { iMin: -4, iMax: 6, jMin: -10, jMax: 2 };

  it('every major line sits at a whole multiple of the spacing from the origin, on the plane', () => {
    const g = buildWorkplaneGeometry({ ...base, patch });
    const verts = sourceVertices(g.major, g, ZERO);
    expect(verts.length).toBeGreaterThan(0);
    for (let i = 0; i < verts.length; i += 2) {
      const [a, b] = [verts[i], verts[i + 1]];
      expect(a[2]).toBeCloseTo(100, 9);
      const constant = Math.abs(a[0] - b[0]) < 1e-9 ? (a[0] - 3) / 5 : (a[1] - 7) / 5;
      expect(Math.abs(constant - Math.round(constant))).toBeLessThan(1e-9);
    }
  });

  it('two patches draw the same line at the same place', () => {
    const keys = (p: typeof patch): Set<string> => {
      const g = buildWorkplaneGeometry({ ...base, patch: p });
      const v = sourceVertices(g.major, g, ZERO);
      const out = new Set<string>();
      for (let i = 0; i < v.length; i += 2) {
        out.add(Math.abs(v[i][0] - v[i + 1][0]) < 1e-9 ? `x=${v[i][0].toFixed(6)}` : `y=${v[i][1].toFixed(6)}`);
      }
      return out;
    };
    const a = keys(patch);
    const b = keys({ iMin: 0, iMax: 12, jMin: -6, jMax: 6 });
    expect([...a].filter((k) => b.has(k)).length).toBeGreaterThan(10);
  });

  it('draws the axes and origin marker only when the origin is in the patch', () => {
    expect(buildWorkplaneGeometry({ ...base, patch }).originInView).toBe(true);
    const far = buildWorkplaneGeometry({ ...base, patch: { iMin: 50, iMax: 60, jMin: 50, jMax: 60 } });
    expect(far.originInView).toBe(false);
    expect(far.axes.vertices.length).toBe(0);
  });

  it('minor lines are omitted on request and never sit on a major line', () => {
    expect(buildWorkplaneGeometry({ ...base, patch, showMinor: false }).minor.vertices.length).toBe(0);
    const g = buildWorkplaneGeometry({ ...base, patch });
    const v = sourceVertices(g.minor, g, ZERO);
    expect(v.length).toBeGreaterThan(0);
    for (let i = 0; i < v.length; i += 2) {
      const vertical = Math.abs(v[i][0] - v[i + 1][0]) < 1e-9;
      const off = vertical ? v[i][0] - 3 : v[i][1] - 7;
      expect(Math.abs(off / 5 - Math.round(off / 5))).toBeGreaterThan(1e-6);
    }
  });
});

describe('patch bounds', () => {
  it('covers the scan plus one scan size on each side, snapped to the lattice', () => {
    expect(patchFor([0, 30, 0, 20], 30, [15, 10], 5)!).toEqual({ iMin: -6, iMax: 12, jMin: -6, jMax: 10 });
  });

  it('caps the patch around the focus for a scan far larger than the spacing', () => {
    const p = patchFor([0, 1e6, 0, 1e6], 1e6, [5000, 5000], 1)!;
    expect(p.iMax - p.iMin).toBe(2 * MAX_HALF_MAJORS);
    expect(p.iMin).toBe(5000 - MAX_HALF_MAJORS);
  });
});

describe('fade', () => {
  const plane = principalPlane('horizontal', [0, 0, 0], 'z');
  const patch = patchFor([-50, 50, -50, 50], 100, [0, 0], 5)!;
  const g = buildWorkplaneGeometry({ plane, patch, major: 5, minor: 1, showMinor: true, sceneOrigin: ZERO });
  const v = sourceVertices(g.major, g, ZERO);
  const edge = (p: Vec3): boolean => Math.max(Math.abs(p[0]), Math.abs(p[1])) >= 149.999;

  const cam = (position: Vec3, target: Vec3, orthographic = false): WorkplaneFadeCamera => {
    const d = sub(target, position);
    const l = len(d);
    return { position, forward: [d[0] / l, d[1] / l, d[2] / l], orthographic, fovDeg: 60, orbitDistance: l, canvasCssHeight: 900 };
  };

  it('top down (Plan): interior lines are at full strength, the patch edge fades to zero', () => {
    const a = fadeAlphas(g.major, g, plane, cam([0, 0, 200], [0, 0, 0], true));
    v.forEach((p, i) => {
      if (Math.max(Math.abs(p[0]), Math.abs(p[1])) <= 60) expect(a[i]).toBe(1);
      if (edge(p)) expect(a[i]).toBe(0);
    });
  });

  it('a grazing perspective view drops lines closer than the fade limit and ends without a cut', () => {
    // Eye 2 m above the plane, looking 140 m along it: under one degree of grazing.
    const c = cam([0, -140, 2], [0, 0, 0]);
    const a = fadeAlphas(g.major, g, plane, c);
    const k = (2 * Math.tan(Math.PI / 6)) / 900;
    let checked = 0;
    for (let i = 0; i < v.length; i++) {
      if (g.major.across[i] !== 1) continue; // lines across the view: the ones that stripe
      const d = sub(v[i], c.position);
      const depth = len(d);
      const along = dot([d[0] / depth, d[1] / depth, d[2] / depth], plane.v);
      const px = (5 * Math.sqrt(1 - along * along)) / (k * depth);
      if (px < FADE_ZERO_PX) {
        expect(a[i]).toBe(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100); // the far field really was dropped
    let nearest = -1;
    v.forEach((p, i) => { if (g.major.across[i] === 1 && dot(sub(p, c.position), c.forward) > 0 && (nearest < 0 || len(sub(p, c.position)) < len(sub(v[nearest], c.position)))) nearest = i; });
    expect(a[nearest]).toBeGreaterThan(0);
    v.forEach((p, i) => { if (edge(p)) expect(a[i]).toBe(0); });
  });

  it('nothing behind the camera is drawn', () => {
    const a = fadeAlphas(g.major, g, plane, cam([0, 0, 5], [0, 100, 5]));
    v.forEach((p, i) => { if (p[1] < -1) expect(a[i]).toBe(0); });
  });
});

describe('recentring at UTM-sized coordinates', () => {
  const datum: Vec3 = [499_000, 4_099_000, 1_000];
  const origin: Vec3 = [500_120, 4_100_880, 1_234.567];

  it('line positions are exact to well under a millimetre at 1e6 m, where absolute Float32 is centimetres off', () => {
    const plane = principalPlane('horizontal', origin, 'z');
    const g = buildWorkplaneGeometry({ plane, patch: { iMin: -100, iMax: 100, jMin: -100, jMax: 100 }, major: 5, minor: 1, showMinor: false, sceneOrigin: datum });
    // Each line is checked on the axis it is constant along: a line spaced
    // along u (across = 0) has constant x; one spaced along v, constant y.
    let worst = 0;
    const v = sourceVertices(g.major, g, datum);
    v.forEach((p, i) => {
      const k = g.major.across[i] === 0 ? 0 : 1;
      const f = (p[k] - origin[k]) / 5;
      worst = Math.max(worst, Math.abs(f - Math.round(f)) * 5, Math.abs(p[2] - origin[2]));
    });
    expect(v.length).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(1e-4);
    expect(Math.abs(Math.fround(origin[1] + 0.123) - (origin[1] + 0.123))).toBeGreaterThan(0.01);
  });
});

describe('accuracy on a tilted synthetic cloud', () => {
  // A cloud on the plane z = 0.08 (x - E0) - 0.05 (y - N0) + 1200 at UTM offsets.
  const E0 = 512_000;
  const N0 = 4_123_000;
  const zOf = (x: number, y: number): number => 0.08 * (x - E0) - 0.05 * (y - N0) + 1200;
  const cloud: Vec3[] = [];
  for (let i = 0; i <= 20; i++) for (let j = 0; j <= 20; j++) cloud.push([E0 + i * 5, N0 + j * 5, zOf(E0 + i * 5, N0 + j * 5)]);
  // Three picks taken from the cloud, well apart.
  const picks: [Vec3, Vec3, Vec3] = [cloud[1 * 21 + 1], cloud[18 * 21 + 3], cloud[8 * 21 + 17]];
  const datum: Vec3 = [E0 - 3, N0 - 7, 1100];
  const r = planeFromThreePoints(...picks, 'z');
  if (!r.ok) throw new Error('refused');
  const plane = r.basis;
  const major = 10;
  const patch = patchFor([-60, 160, -60, 160], 100, [40, 40], major)!;
  const g = buildWorkplaneGeometry({ plane, patch, major, minor: 2, showMinor: true, sceneOrigin: datum });
  const scale = (patch.iMax - patch.iMin) * major; // the patch size

  it('every grid vertex lies on the plane through the three picks to within 1e-6 of the scale', () => {
    let n = 0;
    for (const set of [g.major, g.minor, g.axes]) {
      for (const p of sourceVertices(set, g, datum)) {
        expect(Math.abs(dot(sub(p, plane.origin), plane.normal)) / scale).toBeLessThan(1e-6);
        // The picks were exact, so the grid is also on the synthetic surface.
        expect(Math.abs(p[2] - zOf(p[0], p[1])) / scale).toBeLessThan(1e-6);
        n++;
      }
    }
    expect(n).toBeGreaterThan(1000);
  });

  it('the readout origin and spacing match the drawn lines', () => {
    const lines = workplaneReadout({
      orientation: 'three-point', dipDeg: r.dipDeg, axisNames: ['X', 'Y'],
      originH: [plane.origin[0], plane.origin[1]], elevation: plane.origin[2], elevationSource: 'plane',
      spacing: { major, minor: 2, showMinor: true, fixed: false }, units: workplaneUnits(null), datumKnown: true,
    });
    expect(lines[1]).toBe(`Origin: X ${plane.origin[0].toFixed(3)} units, Y ${plane.origin[1].toFixed(3)} units`);
    expect(lines[2]).toContain(plane.origin[2].toFixed(3));
    expect(lines[3]).toMatch(/^Grid 10 units, minor 2 units/);
    // The two axis lines cross at the stated origin.
    const axisSt = sourceVertices(g.axes, g, datum).map((p) => planeCoordsOf(p, plane));
    expect(axisSt.some(([s]) => Math.abs(s) < 1e-6)).toBe(true);
    expect(axisSt.some(([, t]) => Math.abs(t) < 1e-6)).toBe(true);
    // Neighbouring parallel major lines are exactly the stated spacing apart
    // (20 across the origin, where the axis line stands in for the major line).
    const s = [...new Set(sourceVertices(g.major, g, datum).map((p) => planeCoordsOf(p, plane)).filter((_, i) => g.major.across[i] === 0).map((p) => Math.round(p[0] * 1e3) / 1e3))].sort((a, b) => a - b);
    expect(s.length).toBeGreaterThan(5);
    for (let i = 1; i < s.length; i++) {
      const gap = s[i] - s[i - 1];
      const acrossOrigin = s[i - 1] < 0 && s[i] > 0;
      expect(gap).toBeCloseTo(acrossOrigin ? 2 * major : major, 2);
    }
  });

  it('a vertical plane on a Y-up scan lies along the right axes', () => {
    const p6 = { iMin: -3, iMax: 3, jMin: -3, jMax: 3 };
    const gx = buildWorkplaneGeometry({ plane: principalPlane('vertical-x', [5, 300, -7], 'y'), patch: p6, major: 2, minor: 1, showMinor: false, sceneOrigin: ZERO });
    const gn = buildWorkplaneGeometry({ plane: principalPlane('vertical-north', [5, 300, -7], 'y'), patch: p6, major: 2, minor: 1, showMinor: false, sceneOrigin: ZERO });
    // Along X: constant Z, spans X and up (Y).
    for (const p of sourceVertices(gx.major, gx, ZERO)) expect(p[2]).toBeCloseTo(-7, 9);
    // Along north (-Z on a Y-up scan): constant X, spans Z and up (Y).
    for (const p of sourceVertices(gn.major, gn, ZERO)) expect(p[0]).toBeCloseTo(5, 9);
    const ys = sourceVertices(gn.major, gn, ZERO).map((p) => p[1]);
    const zs = sourceVertices(gn.major, gn, ZERO).map((p) => p[2]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(12, 9);
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(12, 9);
  });
});

describe('unsafe inputs cannot hang the tab', () => {
  it('an origin 1e17 away with major 10 gives no patch, and building finishes at once', () => {
    // Plane coordinates of the scan around -1e17: lattice indices near -1e16, past 2^53 / 10.
    const p = patchFor([-1e17, -1e17 + 30, -1e17, -1e17 + 30], 30, [-1e17, -1e17], 10);
    expect(p).toBeNull();
    const t0 = performance.now();
    const g = buildWorkplaneGeometry({
      plane: principalPlane('horizontal', [1e17, 1e17, 0], 'z'),
      patch: { iMin: -1e16 - 4, iMax: -1e16 + 4, jMin: -1e16 - 4, jMax: -1e16 + 4 },
      major: 10, minor: 2, showMinor: true, sceneOrigin: ZERO,
    });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(g.major.vertices.length + g.minor.vertices.length).toBe(0);
  });

  it('a fixed spacing of 1e-20 with the focus 100 m away gives no patch', () => {
    expect(patchFor([0, 30, 0, 30], 30, [100, 100], 1e-20)).toBeNull();
  });

  it('indices up to 2^50 are still drawn; beyond it they are not', () => {
    expect(patchFor([0, 1, 0, 1], 1, [0, 0], 1 / 2 ** 46)).not.toBeNull();
    expect(patchFor([0, 1, 0, 1], 1, [0, 0], 1 / 2 ** 51)).toBeNull();
    expect(MAX_SAFE_INDEX).toBe(2 ** 50);
  });

  it('the fallback patch for a far focus is capped around the scan centre', () => {
    // 5 km scan, 0.1 spacing, focus 1e6 away: about 50,000 lines a side uncapped.
    const p = patchFor([0, 5000, 0, 5000], 5000, [1e6, 1e6], 0.1)!;
    expect(p.iMax - p.iMin).toBeLessThanOrEqual(2 * MAX_HALF_MAJORS);
    expect(p.jMax - p.jMin).toBeLessThanOrEqual(2 * MAX_HALF_MAJORS);
    expect(Math.abs((p.iMin + p.iMax) / 2 - 25_000)).toBeLessThanOrEqual(1);
    const g = buildWorkplaneGeometry({ plane: principalPlane('horizontal', [0, 0, 0], 'z'), patch: p, major: 0.1, minor: 0.02, showMinor: false, sceneOrigin: ZERO });
    expect(g.major.vertices.length / 3).toBeLessThan(30_000);
  });
});

describe('minor subdivision near the index limit', () => {
  it('a minor step of a tenth of the major is not subdivided, so the minor index stays exact', () => {
    // Indices near 2^50: ten minors per major would reach 10 x 2^50 > 2^53.
    const big = 2 ** 50 - 10;
    const t0 = performance.now();
    const g = buildWorkplaneGeometry({
      plane: principalPlane('horizontal', [0, 0, 0], 'z'),
      patch: { iMin: big - 4, iMax: big, jMin: big - 4, jMax: big },
      major: 1, minor: 0.1, showMinor: true, sceneOrigin: ZERO,
    });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(g.minor.vertices.length).toBe(0);
    expect(g.major.vertices.length).toBeGreaterThan(0);
  });

  it('fifths are still drawn there', () => {
    const big = 2 ** 50 - 10;
    const g = buildWorkplaneGeometry({
      plane: principalPlane('horizontal', [0, 0, 0], 'z'),
      patch: { iMin: big - 4, iMax: big, jMin: big - 4, jMax: big },
      major: 1, minor: 0.2, showMinor: true, sceneOrigin: ZERO,
    });
    expect(g.minor.vertices.length).toBeGreaterThan(0);
  });
});
