/**
 * drawPrecisionLod.test.ts: the single-node case of the per-draw controller
 * (science/drawPrecisionLod.ts).
 *
 * The parts are checked one at a time against brute force: the stretch bound,
 * the two-way distance H between a level and the stored points, the level's
 * extent and the cell count. Then the rule itself (the coarsest level whose
 * sigma * H + B fits tau), and finally the claim it certifies, end to end:
 * every stored point lies within tau of the Float32 eye position of its
 * drawn representative, with the shader's arithmetic emulated in binary32.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateDrawPrecision,
  tileFromLocalFloat32,
  type DrawPrecisionView,
} from '../src/science/drawPrecision';
import {
  LOD_BASE_CELL_METRES,
  levelH,
  levelTile,
  occupiedCells,
  selectCertifiedLevel,
  stretchBound,
} from '../src/science/drawPrecisionLod';
import { composeModelView64 } from '../src/vendor/spe-check/olv_preflight.mjs';

const METRES = { linearUnitKnown: true, linearUnitToMetres: 1 };
const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Points in a box at a local offset, as the Float32 buffer the viewer keeps. */
function cloud(n: number, size: [number, number, number], at: [number, number, number], seed = 7): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) out[3 * i + a] = at[a] + r() * size[a];
  return out;
}

/** A rigid camera (yaw 30 deg, pitch -35 deg) at a local position, column-major. */
function viewAt(eye: [number, number, number]): Float64Array {
  const cy = Math.cos(Math.PI / 6), sy = Math.sin(Math.PI / 6);
  const cp = Math.cos(-0.61), sp = Math.sin(-0.61);
  const R = [[cy, -sy * cp, sy * sp], [sy, cy * cp, -cy * sp], [0, sp, cp]];
  const v = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) v[4 * c + r] = R[c]![r]!;
    v[12 + r] = -(R[0]![r]! * eye[0] + R[1]![r]! * eye[1] + R[2]![r]! * eye[2]);
  }
  v[15] = 1;
  return v;
}

function view(eye: [number, number, number], path: DrawPrecisionView['path'] = 'instanced-quad-highp'): DrawPrecisionView {
  return { modelView64: composeModelView64(viewAt(eye), IDENTITY), backend: 'webgpu', path };
}

/** A level built by hand: each point's cell centre, narrowed to Float32. */
function representativeOf(x: number, q: number): number {
  return Math.fround((Math.floor(x / q) + 0.5) * q);
}

describe('the stretch bound', () => {
  it('is 1 for a rigid view, up to rounding, and bounds every stretch', () => {
    const m = composeModelView64(viewAt([300, -400, 250]), IDENTITY);
    const s = stretchBound(m);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s).toBeLessThan(1 + 1e-9);
    expect(stretchBound(IDENTITY)).toBeLessThan(1 + 1e-9);
  });

  it('bounds a view that scales', () => {
    const scaled = Float64Array.from(IDENTITY);
    scaled[0] = 2; scaled[5] = 0.5; scaled[10] = 3;
    const s = stretchBound(scaled);
    const r = rng(3);
    for (let i = 0; i < 200; i++) {
      const v = [r() - 0.5, r() - 0.5, r() - 0.5];
      const Av = [2 * v[0]!, 0.5 * v[1]!, 3 * v[2]!];
      expect(Math.hypot(...Av)).toBeLessThanOrEqual(s * Math.hypot(...v));
    }
    expect(s).toBeGreaterThanOrEqual(3);
  });
});

describe('a level against the stored points', () => {
  const pts = cloud(5000, [40, 40, 6], [350, 420, 60]);
  const base = tileFromLocalFloat32(pts);

  for (const q of [0.064, 0.512, 4.096]) {
    it(`q = ${q}: every point is within H of its representative, which sits inside the level's extent`, () => {
      const tile = levelTile(base, q);
      const H = levelH(tile, q);
      let worst = 0;
      for (let i = 0; i < pts.length; i += 3) {
        const d = Math.hypot(
          pts[i]! - representativeOf(pts[i]!, q),
          pts[i + 1]! - representativeOf(pts[i + 1]!, q),
          pts[i + 2]! - representativeOf(pts[i + 2]!, q),
        );
        worst = Math.max(worst, d);
        for (let a = 0; a < 3; a++) expect(Math.abs(representativeOf(pts[i + a]!, q))).toBeLessThanOrEqual(tile.r[a]!);
      }
      expect(worst).toBeLessThanOrEqual(H);
    });
  }

  it('counts occupied cells exactly', () => {
    for (const q of [0.032, 0.5, 3]) {
      const seen = new Set<string>();
      for (let i = 0; i < pts.length; i += 3) seen.add(`${Math.floor(pts[i]! / q)},${Math.floor(pts[i + 1]! / q)},${Math.floor(pts[i + 2]! / q)}`);
      expect(occupiedCells(pts, q)).toBe(seen.size);
    }
  });

  it('declines to count a grid too large to key exactly', () => {
    const wide = new Float32Array([0, 0, 0, 1e7, 1e7, 1e7]);
    expect(occupiedCells(wide, 1e-3)).toBeNull();
  });

  it('never has a smaller draw bound than the stored points at the same view', () => {
    for (const eye of [[300, -400, 250], [5000, 5000, 900], [-20000, 300, 50]] as [number, number, number][]) {
      const v = view(eye);
      const b0 = evaluateDrawPrecision(base, v, METRES, 1, 'faithful').boundMetres!;
      for (const q of [0.001, 0.1, 10]) {
        expect(evaluateDrawPrecision(levelTile(base, q), v, METRES, 1, 'faithful').boundMetres!).toBeGreaterThanOrEqual(b0);
      }
    }
  });
});

describe('the selection rule', () => {
  const dense = cloud(6000, [4, 4, 2], [350, 420, 60]);
  const sparse = cloud(6000, [200, 200, 20], [350, 420, 60]); // about 2.6 m apart
  const v = view([300, -400, 250]);

  it('picks the coarsest level that fits, and the next coarser one does not', () => {
    const tau = 0.5;
    const s = selectCertifiedLevel(dense, tileFromLocalFloat32(dense), v, METRES, tau, { count: true });
    expect(s.state).toBe('CERTIFIED');
    expect(s.level).toBeGreaterThan(0);
    expect(s.hMetres! + s.bMetres!).toBeLessThanOrEqual(tau);
    const q1 = LOD_BASE_CELL_METRES * 2 ** (s.level + 1);
    const t1 = levelTile(tileFromLocalFloat32(dense), q1);
    const next = s.stretch * levelH(t1, q1) + evaluateDrawPrecision(t1, v, METRES, tau, 'faithful').boundMetres!;
    expect(next).toBeGreaterThan(tau);
    expect(s.pointsKept).toBe(occupiedCells(dense, s.cellSizeMetres!));
    expect(s.pointsKept!).toBeLessThan(s.pointsFull);
    expect(s.bytesKept).toBe(s.pointsKept! * 12);
  });

  it('keeps full resolution when the points are further apart than the limit allows', () => {
    const s = selectCertifiedLevel(sparse, tileFromLocalFloat32(sparse), v, METRES, 0.001, { count: true });
    expect(s.state).toBe('CERTIFIED');
    expect(s.level).toBe(0);
    expect(s.hMetres).toBe(0);
    expect(s.pointsKept).toBe(s.pointsFull);
  });

  it('certifies nothing when the stored points already exceed the limit', () => {
    const s = selectCertifiedLevel(dense, tileFromLocalFloat32(dense), v, METRES, 1e-12);
    expect(s.state).toBe('NONE');
    expect(s.bMetres!).toBeGreaterThan(1e-12);
  });

  it('grades nothing without a linear unit, and checks nothing off the verified path', () => {
    const tile = tileFromLocalFloat32(dense);
    expect(selectCertifiedLevel(dense, tile, v, { linearUnitKnown: false, linearUnitToMetres: 1 }, 0.01).state).toBe('UNGRADED');
    expect(selectCertifiedLevel(dense, tile, view([300, -400, 250], 'unverified'), METRES, 0.01).state).toBe('NOT_TESTED');
  });

  it('selects without a pass over the points unless asked to count, and reuses a count once made', () => {
    const pts = cloud(3000, [4, 4, 2], [350, 420, 60], 23);
    const tile = tileFromLocalFloat32(pts);
    const s = selectCertifiedLevel(pts, tile, v, METRES, 0.5);
    expect(s.level).toBeGreaterThan(0);
    expect(s.pointsKept).toBeNull();
    expect(selectCertifiedLevel(pts, tile, v, METRES, 0.5, { count: 'cached' }).pointsKept).toBeNull();
    const counted = selectCertifiedLevel(pts, tile, v, METRES, 0.5, { count: true }).pointsKept;
    expect(counted).toBeGreaterThan(0);
    expect(selectCertifiedLevel(pts, tile, v, METRES, 0.5, { count: 'cached' }).pointsKept).toBe(counted);
  });
});

describe('the certified claim, end to end', () => {
  // The shader path: the model-view composed in binary64, narrowed to binary32
  // once, then modelView * vec4(p, 1) evaluated in binary32, one rounding per
  // operation. Faithful rounding allows any of these orders and more.
  const fr = Math.fround;
  function eye32(m32: Float32Array, p: [number, number, number]): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      out[i] = fr(fr(fr(fr(m32[i]! * p[0]) + fr(m32[4 + i]! * p[1])) + fr(m32[8 + i]! * p[2])) + m32[12 + i]!);
    }
    return out;
  }
  function eye64(m: ArrayLike<number>, p: [number, number, number]): [number, number, number] {
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) out[i] = m[i]! * p[0] + m[4 + i]! * p[1] + m[8 + i]! * p[2] + m[12 + i]!;
    return out;
  }

  for (const [label, eye, tau] of [
    ['near', [352, 418, 70], 0.05],
    ['far', [-30000, 25000, 4000], 0.5],
  ] as const) {
    it(`every stored point is within tau of its drawn representative (${label} camera)`, () => {
      const pts = cloud(4000, [4, 4, 2], [350, 420, 60], 11);
      const v = view(eye as [number, number, number]);
      const s = selectCertifiedLevel(pts, tileFromLocalFloat32(pts), v, METRES, tau);
      expect(s.state).toBe('CERTIFIED');
      expect(s.level).toBeGreaterThan(0);
      const q = s.cellSizeMetres!;
      const m32 = Float32Array.from(v.modelView64);
      let worst = 0;
      for (let i = 0; i < pts.length; i += 3) {
        const p: [number, number, number] = [pts[i]!, pts[i + 1]!, pts[i + 2]!];
        const rep: [number, number, number] = [representativeOf(p[0], q), representativeOf(p[1], q), representativeOf(p[2], q)];
        const a = eye32(m32, rep), b = eye64(v.modelView64, p);
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
      expect(worst).toBeLessThanOrEqual(s.hMetres! + s.bMetres!);
      expect(s.hMetres! + s.bMetres!).toBeLessThanOrEqual(tau);
    });
  }
});
