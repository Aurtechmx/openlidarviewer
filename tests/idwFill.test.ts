/**
 * idwFill.test.ts — inverse-distance void interpolation.
 */

import { describe, it, expect } from 'vitest';
import { idwFill } from '../src/terrain/ground/idwFill';

describe('idwFill', () => {
  it('leaves measured cells untouched', () => {
    const z = Float32Array.from([10, NaN, 20]);
    const had = Uint8Array.from([1, 0, 1]);
    const out = idwFill(z, had, 3, 1);
    expect(out[0]).toBe(10);
    expect(out[2]).toBe(20);
  });

  it('blends a void from its two equidistant measured neighbours', () => {
    // Cell 1 sits exactly between 10 and 20 → IDW mean = 15.
    const out = idwFill(Float32Array.from([10, NaN, 20]), Uint8Array.from([1, 0, 1]), 3, 1);
    expect(out[1]).toBeCloseTo(15, 5);
  });

  it('recovers a linear ramp far better than nearest-neighbour would', () => {
    // Measured endpoints of a 5-cell ramp 0..40; interior is linear truth.
    const z = Float32Array.from([0, NaN, NaN, NaN, 40]);
    const had = Uint8Array.from([1, 0, 0, 0, 1]);
    const out = idwFill(z, had, 5, 1, { power: 1 });
    // Nearest-neighbour would snap to 0 or 40 (error up to 20). IDW with
    // power 1 is symmetric at the centre and monotonic across — centre
    // must be the midpoint and the profile must increase left→right.
    expect(out[2]).toBeCloseTo(20, 5);
    expect(out[1]).toBeLessThan(out[2]);
    expect(out[3]).toBeGreaterThan(out[2]);
  });

  it('leaves a cell NaN when nothing is within the search radius', () => {
    const z = Float32Array.from([5, NaN, NaN, NaN, NaN]);
    const had = Uint8Array.from([1, 0, 0, 0, 0]);
    const out = idwFill(z, had, 5, 1, { maxRadiusCells: 1 });
    expect(out[0]).toBe(5);
    expect(out[1]).toBeCloseTo(5, 5); // within radius 1
    expect(Number.isNaN(out[4])).toBe(true); // beyond radius 1 → NaN
  });

  it('is deterministic and order-independent', () => {
    const z = Float32Array.from([0, NaN, NaN, 9]);
    const had = Uint8Array.from([1, 0, 0, 1]);
    const a = idwFill(z, had, 4, 1);
    const b = idwFill(z, had, 4, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('matches a full square scan of each ring bit for bit', () => {
    // Reference: visit every cell of the ring's bounding square in row
    // order and keep only the perimeter, as the fill did before it skipped
    // interior columns directly.
    const reference = (z: Float32Array, had: Uint8Array, cols: number, rows: number, k: number, maxR: number): Float32Array => {
      const out = new Float32Array(z);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = row * cols + col;
          if (had[i] === 1) continue;
          let wSum = 0, vSum = 0, found = 0, last = -1;
          for (let radius = 1; radius <= maxR; radius++) {
            for (let r = row - radius; r <= row + radius; r++) {
              if (r < 0 || r >= rows) continue;
              const edge = r === row - radius || r === row + radius;
              for (let c = col - radius; c <= col + radius; c++) {
                if (c < 0 || c >= cols) continue;
                if (!edge && c !== col - radius && c !== col + radius) continue;
                const j = r * cols + c;
                if (had[j] !== 1) continue;
                const w = 1 / Math.pow(Math.sqrt((r - row) ** 2 + (c - col) ** 2), 2);
                wSum += w;
                vSum += w * z[j];
                found++;
              }
            }
            if (found >= k && last < 0) last = radius;
            if (last >= 0 && radius >= last + 1) break;
          }
          out[i] = wSum > 0 ? vSum / wSum : Number.NaN;
        }
      }
      return out;
    };
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const [cols, rows, density] of [[23, 17, 0.08], [40, 31, 0.02], [9, 50, 0.3]] as const) {
      const n = cols * rows;
      const z = new Float32Array(n).fill(Number.NaN);
      const had = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (rand() < density) { had[i] = 1; z[i] = rand() * 100 - 20; }
      }
      const got = idwFill(z, had, cols, rows, { kNearest: 6, maxRadiusCells: 12 });
      const want = reference(z, had, cols, rows, 6, 12);
      for (let i = 0; i < n; i++) expect(Object.is(got[i], want[i])).toBe(true);
    }
  });
});
