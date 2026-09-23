/**
 * groundFilterWindowExtremeLinear.test.ts
 *
 * `groundFilter.windowExtreme` was rewritten from a direct O(cols·b) /
 * O(rows·b) per-radius scan to a van Herk / Gil-Werman separable extremum
 * (O(cols) / O(rows) per radius). Min and max are exact selections, so the
 * two implementations must agree bit for bit, not just numerically close —
 * including which signed zero survives a `-0`/`+0` tie, which the direct
 * scan can produce because it folds through `Math.min`/`Math.max` and those
 * treat `-0` as strictly less than `+0` for min (and the reverse for max).
 *
 * `naiveWindowExtreme` below is the pre-rewrite implementation, copied
 * verbatim (mode/pick/NaN handling and all) from groundFilter.ts as the
 * reference oracle. It never runs in production, only here.
 *
 * PRNG is mulberry32 with a fixed seed, matching the generator already used
 * by tests/analyticVolumeOracle.test.ts and tests/decodeWorkerPoolFuzz.test.ts,
 * so every case below reproduces exactly.
 */

import { describe, it, expect } from 'vitest';
import { windowExtreme } from '../src/terrain/ground/groundFilter';

// ── deterministic PRNG (mulberry32, fixed seed) ────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── reference oracle: the pre-rewrite direct-scan windowExtreme, verbatim ──

/** Separable 1-D windowed min/max over a flat square radius-`b` window. */
function naiveWindowExtreme(
  grid: Float32Array,
  cols: number,
  rows: number,
  b: number,
  mode: 'min' | 'max',
): Float32Array {
  const pick = mode === 'min' ? Math.min : Math.max;
  const horizontal = new Float32Array(grid.length);
  // pass 1 — horizontal
  for (let row = 0; row < rows; row++) {
    const base = row * cols;
    for (let col = 0; col < cols; col++) {
      let acc = Number.NaN;
      const lo = Math.max(0, col - b);
      const hi = Math.min(cols - 1, col + b);
      for (let c = lo; c <= hi; c++) {
        const val = grid[base + c];
        if (!Number.isFinite(val)) continue;
        acc = Number.isNaN(acc) ? val : pick(acc, val);
      }
      horizontal[base + col] = acc;
    }
  }
  // pass 2 — vertical
  const out = new Float32Array(grid.length);
  for (let col = 0; col < cols; col++) {
    for (let row = 0; row < rows; row++) {
      let acc = Number.NaN;
      const lo = Math.max(0, row - b);
      const hi = Math.min(rows - 1, row + b);
      for (let r = lo; r <= hi; r++) {
        const val = horizontal[r * cols + col];
        if (!Number.isFinite(val)) continue;
        acc = Number.isNaN(acc) ? val : pick(acc, val);
      }
      out[row * cols + col] = acc;
    }
  }
  return out;
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Byte-identical comparison over the raw buffers, not value tolerance. */
function sameBytes(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const ba = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bb = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < ba.length; i++) {
    if (ba[i] !== bb[i]) return false;
  }
  return true;
}

/** Random grid with a configurable NaN-hole density. */
function randomGrid(cols: number, rows: number, rng: () => number, nanRate: number): Float32Array {
  const g = new Float32Array(cols * rows);
  for (let i = 0; i < g.length; i++) {
    if (rng() < nanRate) {
      g[i] = Number.NaN;
    } else {
      // Wide range including negatives, so ties and sign are exercised
      // beyond the always-positive elevation domain the filter usually sees.
      g[i] = (rng() - 0.5) * 200;
    }
  }
  return g;
}

/** Every finite value replaced by a signed zero, mixing -0 and +0 by index parity. */
function zeroGrid(cols: number, rows: number, rng: () => number, nanRate: number): Float32Array {
  const g = new Float32Array(cols * rows);
  for (let i = 0; i < g.length; i++) {
    if (rng() < nanRate) {
      g[i] = Number.NaN;
    } else {
      g[i] = rng() < 0.5 ? -0 : 0;
    }
  }
  return g;
}

function assertMatch(cols: number, rows: number, g: Float32Array, b: number, mode: 'min' | 'max', label: string): void {
  const expected = naiveWindowExtreme(g, cols, rows, b, mode);
  const actual = windowExtreme(g, cols, rows, b, mode);
  expect(sameBytes(actual, expected), `${label}: ${cols}x${rows} b=${b} mode=${mode}`).toBe(true);
}

// ── property test ───────────────────────────────────────────────────────

describe('windowExtreme: linear-time rewrite matches the direct-scan oracle bit for bit', () => {
  const shapes: Array<[number, number]> = [
    [1, 1],
    [1, 17],
    [17, 1],
    [5, 5],
    [8, 3],
    [3, 8],
    [23, 11],
    [40, 40],
  ];
  const radii = [1, 2, 3, 4, 5, 8, 16, 24, 32, 48]; // includes radii past every shape above
  const nanRates = [0, 0.05, 0.5, 1.0];
  const modes: Array<'min' | 'max'> = ['min', 'max'];

  it('agrees on random grids across shapes, radii, NaN densities and both modes', () => {
    const rng = mulberry32(0xa11ce_5eed);
    let cases = 0;
    for (const [cols, rows] of shapes) {
      for (const nanRate of nanRates) {
        const g = randomGrid(cols, rows, rng, nanRate);
        for (const b of radii) {
          for (const mode of modes) {
            assertMatch(cols, rows, g, b, mode, `random nanRate=${nanRate}`);
            cases++;
          }
        }
      }
    }
    expect(cases).toBe(shapes.length * nanRates.length * radii.length * modes.length);
  });

  it('a window of all-NaN cells stays NaN in both implementations', () => {
    const cols = 6, rows = 6;
    const g = new Float32Array(cols * rows).fill(Number.NaN);
    for (const b of [1, 2, 5, 10]) {
      for (const mode of modes) {
        const expected = naiveWindowExtreme(g, cols, rows, b, mode);
        const actual = windowExtreme(g, cols, rows, b, mode);
        expect(Array.from(expected).every(Number.isNaN)).toBe(true);
        expect(sameBytes(actual, expected), `all-NaN b=${b} mode=${mode}`).toBe(true);
      }
    }
  });

  it('preserves -0 vs +0 exactly, including ties resolved across the two-pass boundary', () => {
    const rng = mulberry32(0x5170_0000);
    const shapesZ: Array<[number, number]> = [[1, 1], [7, 1], [1, 7], [9, 9], [16, 4]];
    for (const [cols, rows] of shapesZ) {
      for (const nanRate of [0, 0.3, 0.7]) {
        const g = zeroGrid(cols, rows, rng, nanRate);
        for (const b of [1, 2, 4, 8, 16]) {
          for (const mode of modes) {
            assertMatch(cols, rows, g, b, mode, `zero grid nanRate=${nanRate}`);
          }
        }
      }
    }
  });

  it('a single -0 cell in an otherwise-positive grid resolves the same way as the direct scan', () => {
    // Constructed to force the -0 into the same window as several +0 and
    // positive neighbours, including across the horizontal-then-vertical
    // pass boundary where the sign has to survive a second fold.
    const cols = 9, rows = 9;
    const g = new Float32Array(cols * rows).fill(0); // +0 everywhere
    g[4 * cols + 4] = -0;
    g[4 * cols + 5] = 3.5;
    g[3 * cols + 4] = 2.25;
    for (const b of [1, 2, 3, 4, 5, 9]) {
      for (const mode of modes) {
        assertMatch(cols, rows, g, b, mode, 'single -0 in +0 field');
      }
    }
  });

  it('radius larger than the grid collapses every line to one value, both implementations agree', () => {
    const rng = mulberry32(0xb16_9a5);
    const shapes2: Array<[number, number]> = [[1, 1], [3, 1], [1, 3], [4, 4]];
    for (const [cols, rows] of shapes2) {
      const g = randomGrid(cols, rows, rng, 0.2);
      for (const b of [50, 64, 100]) {
        for (const mode of modes) {
          assertMatch(cols, rows, g, b, mode, 'radius >> grid');
        }
      }
    }
  });

  it('radius 0 is the identity (finite cells unchanged, NaN cells stay NaN) for both', () => {
    const rng = mulberry32(0xf00d);
    const g = randomGrid(12, 9, rng, 0.15);
    for (const mode of modes) {
      assertMatch(12, 9, g, 0, mode, 'radius 0 identity');
    }
  });
});
