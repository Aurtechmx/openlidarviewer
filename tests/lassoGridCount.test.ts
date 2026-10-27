import { describe, it, expect } from 'vitest';
import { selectByLasso } from '../src/render/measure/lassoVolume';

// A regular grid and a circular lasso: the selection must be exactly the grid
// points inside the drawn polygon, counted independently here.
describe('lasso selection on a regular grid', () => {
  it('selects every grid point inside a circle lasso and no other', () => {
    const N = 201; // x, y in [-100, 100], 1 px spacing
    const positions = new Float32Array(N * N * 3);
    let k = 0;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      positions[k++] = i - 100; positions[k++] = j - 100; positions[k++] = 0;
    }
    const r = 40.5, M = 720, cx = 0.25, cy = 0.25;
    const lasso = Array.from({ length: M }, (_, m) => {
      const a = (m / M) * Math.PI * 2;
      return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
    });
    const sel = selectByLasso({ positions, lasso, project: (x, y) => ({ x, y }) });
    // Hand count: inside the inscribed polygon for sure below r*cos(pi/M);
    // no grid point lies in the thin band between that and r for this offset.
    const inner = r * Math.cos(Math.PI / M);
    let expected = 0, ambiguous = 0;
    for (let i = -100; i <= 100; i++) for (let j = -100; j <= 100; j++) {
      const d = Math.hypot(i - cx, j - cy);
      if (d < inner) expected++;
      else if (d < r) ambiguous++;
    }
    expect(ambiguous).toBe(0);
    expect(expected).toBe(5159);
    expect(sel.length).toBe(expected);
    for (const idx of sel) {
      const x = positions[idx * 3], y = positions[idx * 3 + 1];
      expect(Math.hypot(x - cx, y - cy)).toBeLessThan(r);
    }
  });
});
