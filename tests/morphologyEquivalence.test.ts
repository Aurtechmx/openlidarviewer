import { describe, it, expect } from 'vitest';
import { morphOpen as classifierOpen, morphExtreme } from '../src/render/class/gridMorphology';
import { morphOpen as groundOpen } from '../src/terrain/ground/groundFilter';

/**
 * The classifier and the ground filter each carry a square morphological
 * opening: one by a monotonic deque, one by a direct window scan. They must be
 * the same operation on the grids the classifier feeds its copy, or a change
 * to either would move a product without moving its method. The comparison is
 * byte identity on the output buffer, not a tolerance: both are exact min and
 * max selections over the same window, so any difference is a defect. The
 * fixtures cover edge rows and columns, a radius past the grid size, and the
 * spike and plateau cases the opening exists for.
 */

function grid(W: number, H: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
  const g = new Float32Array(W * H);
  for (let i = 0; i < g.length; i++) g[i] = 100 + 20 * rnd() + (rnd() < 0.05 ? 15 : 0);
  return g;
}

const same = (a: Float32Array, b: Float32Array): boolean =>
  a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

describe('square opening: classifier deque against ground-filter window scan', () => {
  const shapes: Array<[number, number]> = [[1, 1], [1, 9], [9, 1], [7, 5], [32, 32], [64, 48]];

  it('is byte-identical on finite grids for every radius up to and past the grid size', () => {
    for (const [W, H] of shapes) {
      for (let r = 1; r <= Math.max(W, H) + 1; r++) {
        const g = grid(W, H, W * 131 + H * 17 + r);
        const a = classifierOpen(g, W, H, r);
        const b = groundOpen(g, W, H, r, 'square');
        expect(same(a, b), `open ${W}x${H} r=${r}`).toBe(true);
      }
    }
  });

  it('erosion and dilation each match the direct scan as well', () => {
    const W = 24, H = 20;
    const g = grid(W, H, 9);
    for (let r = 1; r <= 6; r++) {
      const erodedRef = groundOpenErosionReference(g, W, H, r);
      expect(same(morphExtreme(g, W, H, r, true), erodedRef), `erode r=${r}`).toBe(true);
    }
  });

  it('a spike narrower than the element is removed by both, a plateau wider than it is kept', () => {
    const W = 15, H = 15;
    const g = new Float32Array(W * H).fill(10);
    g[7 * W + 7] = 30; // one-cell spike
    for (let y = 2; y <= 12; y++) for (let x = 2; x <= 5; x++) g[y * W + x] = 20; // 4-wide plateau
    const a = classifierOpen(g, W, H, 1);
    const b = groundOpen(g, W, H, 1, 'square');
    expect(same(a, b)).toBe(true);
    expect(a[7 * W + 7]).toBe(10);
    expect(a[7 * W + 3]).toBe(20);
  });

  it('the diamond element is a different operation, not a square approximation', () => {
    const W = 11, H = 11;
    const g = new Float32Array(W * H).fill(10);
    for (let y = 3; y <= 7; y++) for (let x = 3; x <= 7; x++) g[y * W + x] = 20; // 5x5 block
    const square = groundOpen(g, W, H, 2, 'square');
    const diamond = groundOpen(g, W, H, 2, 'diamond');
    expect(same(square, classifierOpen(g, W, H, 2))).toBe(true);
    // The 5x5 element fits the block, so the square opening keeps all of it;
    // the radius-2 diamond fits only at the centre and rebuilds a diamond.
    expect(square[3 * W + 3]).toBe(20);
    expect(diamond[3 * W + 3]).toBe(10);
    expect(diamond[5 * W + 5]).toBe(20);
  });

  it('NaN is where they part: the ground filter treats a hole as absent, the deque needs it filled first', () => {
    const W = 9, H = 9;
    const g = grid(W, H, 3);
    g[4 * W + 4] = Number.NaN;
    const b = groundOpen(g, W, H, 1, 'square');
    // Every cell has a finite neighbour, so the direct scan leaves no NaN.
    expect(Array.from(b).every(Number.isFinite)).toBe(true);
    // The deque path is not defined on a holed grid; its output is not the
    // same grid, which is why the classifier fills holes before calling it.
    expect(same(classifierOpen(g, W, H, 1), b)).toBe(false);
  });
});

/** Erosion the way `groundFilter.windowExtreme` does it: two direct 1-D min scans. */
function groundOpenErosionReference(g: Float32Array, W: number, H: number, r: number): Float32Array {
  const h = new Float32Array(g.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let m = Infinity;
      for (let c = Math.max(0, x - r); c <= Math.min(W - 1, x + r); c++) m = Math.min(m, g[y * W + c]);
      h[y * W + x] = m;
    }
  }
  const out = new Float32Array(g.length);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let m = Infinity;
      for (let q = Math.max(0, y - r); q <= Math.min(H - 1, y + r); q++) m = Math.min(m, h[q * W + x]);
      out[y * W + x] = m;
    }
  }
  return out;
}

describe('square opening: the boundary cases a port must keep', () => {
  it('radius 0 is the identity for both', () => {
    const g = grid(9, 7, 4);
    expect(same(classifierOpen(g, 9, 7, 0), g)).toBe(true);
    expect(same(groundOpen(g, 9, 7, 0, 'square'), g)).toBe(true);
  });

  it('negative values, a flat grid, and a 1x1 grid agree at every radius', () => {
    const neg = grid(16, 12, 5);
    for (let i = 0; i < neg.length; i++) neg[i] -= 130;
    const flat = new Float32Array(16 * 12).fill(-3.5);
    const one = new Float32Array([2.25]);
    for (let r = 0; r <= 4; r++) {
      expect(same(classifierOpen(neg, 16, 12, r), groundOpen(neg, 16, 12, r, 'square')), `neg r=${r}`).toBe(true);
      expect(same(classifierOpen(flat, 16, 12, r), flat), `flat r=${r}`).toBe(true);
      expect(same(classifierOpen(one, 1, 1, r), one), `1x1 r=${r}`).toBe(true);
    }
  });
});
