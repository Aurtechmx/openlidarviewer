/**
 * The surface directions behind sun shading: what a point's direction is on
 * ground, roofs, canopy and walls, in each frame, and on the clouds that have
 * no surface to light.
 */
import { describe, it, expect } from 'vitest';
import {
  estimateCellSize, LEVEL_CODE, packNormal, SurfaceNormals, unpackComponent,
  type SurfaceFrame,
} from '../src/render/sunShading/surfaceNormals';

const Z_UP: SurfaceFrame = { upAxis: 2, verticalScale: 1 };

function rng(seed = 7): () => number {
  let s = seed;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

type P3 = [number, number, number];

function flat(points: readonly P3[]): Float32Array {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => out.set(p, i * 3));
  return out;
}

function run(positions: Float32Array, frame: SurfaceFrame = Z_UP, maxCells?: number, chunk = Infinity): { codes: Uint16Array; job: SurfaceNormals } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  for (let j = 0; j < positions.length; j++) if (positions[j] < min[j % 3]) min[j % 3] = positions[j];
  const cellSize = estimateCellSize(positions, positions.length / 3, frame);
  expect(cellSize).not.toBeNull();
  const job = new SurfaceNormals({ frame, min, cellSize: cellSize!, maxCells });
  const n = positions.length / 3;
  const step = Math.min(n, chunk);
  for (let i = 0; i < n; i += step) job.add(positions.subarray(i * 3, Math.min(n, i + step) * 3));
  job.fit();
  const codes = new Uint16Array(n);
  for (let i = 0; i < n; i += step) codes.set(job.encode(positions.slice(i * 3, Math.min(n, i + step) * 3)), i);
  return { codes, job };
}

/** East and north components of a code's unit normal. */
const dir = (code: number): [number, number] => [unpackComponent(code >> 8), unpackComponent(code & 255)];

function plane(n: number, size: number, z: (x: number, y: number) => number, noise = 0.01, seed = 7): P3[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const x = r() * size;
    const y = r() * size;
    return [x, y, z(x, y) + (r() - 0.5) * 2 * noise] as P3;
  });
}

const median = (v: number[]): number => [...v].sort((a, b) => a - b)[v.length >> 1];
const share = (codes: ArrayLike<number>, ok: (c: number) => boolean): number => Array.from(codes).filter(ok).length / codes.length;

describe('surface directions on one plane', () => {
  // 30 percent up to the east: the normal leans west by 0.3 / sqrt(1.09).
  const lean = -0.3 / Math.sqrt(1.09);

  it('recovers the slope, the edge of the scan included', () => {
    const pts = plane(8000, 40, (x) => 0.3 * x);
    const { codes } = run(flat(pts));
    expect(share(codes, (c) => Math.abs(dir(c)[0] - lean) < 0.04 && Math.abs(dir(c)[1]) < 0.06)).toBeGreaterThan(0.98);
    const edge = pts.flatMap((p, i) => (p[0] < 0.5 || p[0] > 39.5 ? [dir(codes[i])[0]] : []));
    expect(median(edge)).toBeCloseTo(lean, 1); // the empty side is not read as level
  });

  it('reads the same surface the same way in a Y-up file', () => {
    const pts = plane(8000, 40, (x, y) => 0.3 * x + 0.1 * y);
    const z = run(flat(pts)).codes;
    // canonical (e, n, u) = (x, -z, y), so the file's z is -n.
    const y = run(flat(pts.map(([e, n, u]) => [e, u, -n] as P3)), { upAxis: 1, verticalScale: 1 }).codes;
    expect(median(Array.from(y, (c, i) => Math.abs(dir(c)[0] - dir(z[i])[0])))).toBeLessThan(0.02);
    expect(median(Array.from(y, (c) => dir(c)[1]))).toBeCloseTo(median(Array.from(z, (c) => dir(c)[1])), 1);
  });

  it('turns heights into the horizontal unit before taking a slope', () => {
    const ft = 0.3048;
    const { codes } = run(flat(plane(8000, 40, (x) => (0.3 * x) / ft, 0.01 / ft)), { upAxis: 2, verticalScale: ft });
    expect(median(Array.from(codes, (c) => dir(c)[0]))).toBeCloseTo(lean, 1);
  });

  it('keeps the direction at large source coordinates', () => {
    const pts = plane(8000, 400, (x) => 0.3 * x).map(([x, y, z]) => [x + 500_000, y + 400_000, z] as P3);
    const { codes } = run(flat(pts));
    expect(median(Array.from(codes, (c) => dir(c)[0]))).toBeCloseTo(lean, 1);
  });

  it('gives the same codes whatever the chunking', () => {
    const p = flat(plane(5000, 30, (x) => 0.2 * x));
    expect(Array.from(run(p, Z_UP, undefined, 700).codes)).toEqual(Array.from(run(p).codes));
  });

  it('coarsens rather than exceed the cell cap, and still finds the slope', () => {
    const { codes, job } = run(flat(plane(8000, 40, (x) => 0.3 * x)), Z_UP, 300);
    expect(job.cellCount).toBeLessThanOrEqual(300);
    expect(median(Array.from(codes, (c) => dir(c)[0]))).toBeCloseTo(lean, 1);
  });

  it('a level floor noisier than its spacing is level', () => {
    const { codes } = run(flat(plane(20_000, 1, () => 0, 0.01)));
    expect(share(codes, (c) => Math.hypot(...dir(c)) < 0.12)).toBeGreaterThan(0.9);
  });
});

describe('surfaces that a mean height mixes', () => {
  it('lights the ground under a canopy by the ground, and leaves the canopy alone', () => {
    const r = rng(3);
    const ground = plane(9000, 40, (x) => 0.3 * x);
    const canopy: P3[] = Array.from({ length: 9000 }, () => {
      const x = 10 + r() * 20;
      const y = 10 + r() * 20;
      return [x, y, 0.3 * x + 4 + r() * 8];
    });
    const { codes } = run(flat([...ground, ...canopy]));
    const under = ground.flatMap((p, i) => (p[0] > 12 && p[0] < 28 && p[1] > 12 && p[1] < 28 ? [dir(codes[i])[0]] : []));
    expect(median(under)).toBeCloseTo(-0.3 / Math.sqrt(1.09), 1);
    const leaves = codes.slice(ground.length);
    expect(share(leaves, (c) => Math.hypot(...dir(c)) < 0.15)).toBeGreaterThan(0.85);
  });

  it('keeps level ground beside a building level, and both roof slopes apart', () => {
    const r = rng(5);
    const pts: P3[] = [];
    for (let i = 0; i < 16_000; i++) {
      const x = r() * 40;
      const y = r() * 40;
      const roof = x > 15 && x < 25 && y > 15 && y < 25;
      pts.push([x, y, (roof ? 6 + 2 - 0.4 * Math.abs(x - 20) : 0) + (r() - 0.5) * 0.02]);
    }
    const { codes } = run(flat(pts));
    const pick = (ok: (p: P3) => boolean): number[] => pts.flatMap((p, i) => (ok(p) ? [dir(codes[i])[0]] : []));
    // Within 1 m of the wall: the old height average tilted here by the whole roof.
    const beside = pick((p) => p[2] < 1 && p[0] > 14 && p[0] < 15 && p[1] > 16 && p[1] < 24);
    expect(beside.filter((v) => Math.abs(v) < 0.1).length / beside.length).toBeGreaterThan(0.95);
    expect(median(pick((p) => p[2] > 5 && p[0] > 16 && p[0] < 19))).toBeCloseTo(-0.37, 1);
    expect(median(pick((p) => p[2] > 5 && p[0] > 21 && p[0] < 24))).toBeCloseTo(0.37, 1);
  });

  it('leaves a vertical wall at its plain colour', () => {
    const r = rng(9);
    const { codes } = run(flat(Array.from({ length: 6000 }, () => [(r() - 0.5) * 0.01, r() * 20, r() * 20] as P3)));
    expect(share(codes, (c) => c === LEVEL_CODE)).toBeGreaterThan(0.95);
  });

  it('changes smoothly along a curved surface, with no steps at cell edges', () => {
    // Corrugations 6 m apart; neighbours 5 cm apart along x never jump by a cell's worth.
    const pts = plane(40_000, 40, (x) => 0.25 * Math.cos(x), 0.001);
    const row: P3[] = Array.from({ length: 700 }, (_, i) => [3 + i * 0.05, 20, 0.25 * Math.cos(3 + i * 0.05)]);
    const { codes } = run(flat([...pts, ...row]));
    const east = Array.from(codes.slice(pts.length), (c) => dir(c)[0]);
    const jump = Math.max(...east.slice(1).map((v, i) => Math.abs(v - east[i])));
    expect(jump).toBeLessThan(0.035);
    expect(Math.max(...east) - Math.min(...east)).toBeGreaterThan(0.3); // and it does vary
  });
});

describe('clouds with no surface', () => {
  it('have no cell size, so nothing is lit', () => {
    expect(estimateCellSize(new Float32Array(0), 0, Z_UP)).toBeNull();
    expect(estimateCellSize(flat([[1, 2, 3], [4, 5, 6]]), 2, Z_UP)).toBeNull();
    expect(estimateCellSize(flat([[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]]), 4, Z_UP)).toBeNull();
    expect(estimateCellSize(new Float32Array(30).fill(Number.NaN), 10, Z_UP)).toBeNull();
  });

  it('three points, or a line of points, read as level', () => {
    expect(new Set(run(flat([[0, 0, 0], [1, 0, 1], [0, 1, 2]])).codes)).toEqual(new Set([LEVEL_CODE]));
    const line = Array.from({ length: 200 }, (_, i) => [i * 0.1, 0, i * 0.05] as P3);
    expect(new Set(run(flat(line)).codes)).toEqual(new Set([LEVEL_CODE]));
  });

  it('a non-finite point reads as level and moves no other point', () => {
    const pts = plane(3000, 20, (x) => 0.3 * x);
    const clean = run(flat(pts)).codes;
    const dirty = run(flat([...pts, [Number.NaN, 1, 1], [1, Number.POSITIVE_INFINITY, 1]]));
    expect(Array.from(dirty.codes.slice(-2))).toEqual([LEVEL_CODE, LEVEL_CODE]);
    expect(median(Array.from(clean, (c, i) => Math.abs(dir(c)[0] - dir(dirty.codes[i])[0])))).toBeLessThan(0.02);
  });
});

describe('the direction code', () => {
  it('is exact for level and fine near it', () => {
    expect(packNormal(0, 0)).toBe(LEVEL_CODE);
    expect(dir(packNormal(-0.005, 0.005))[0]).toBeCloseTo(-0.005, 3);
    for (const v of [-1, -0.5, -0.1, 0.1, 0.5, 1]) expect(Math.abs(dir(packNormal(v, 0))[0] - v)).toBeLessThan(0.012);
  });
});
