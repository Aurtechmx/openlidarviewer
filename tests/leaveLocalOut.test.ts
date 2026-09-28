/**
 * leaveLocalOut.test.ts
 *
 * The held-out rebuild behind the reconstruction residual: one measured cell
 * is rebuilt by the canonical geodesic fill from its measured 8-neighbours
 * only. Checked on known synthetic surfaces and at the grid's edges.
 */
import { describe, it, expect } from 'vitest';
import { isMeasuredCell, rebuildHeldOutCell, type ResidualGrid } from '../src/terrain/ground/leaveLocalOut';

function grid(cols: number, rows: number, h: (c: number, r: number) => number): ResidualGrid & { z: Float32Array; counts: Uint32Array } {
  const n = cols * rows;
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) z[i] = h(i % cols, Math.floor(i / cols));
  return { z, counts: new Uint32Array(n).fill(2), cols, rows };
}
const at = (g: ResidualGrid, c: number, r: number): number => r * g.cols + c;

describe('isMeasuredCell', () => {
  it('needs a return and a finite height', () => {
    const g = grid(3, 1, () => 5);
    g.counts[1] = 0;
    g.z[2] = Number.NaN;
    expect([0, 1, 2].map((i) => isMeasuredCell(g, i))).toEqual([true, false, false]);
  });
});

describe('rebuildHeldOutCell', () => {
  it('rebuilds a flat plane exactly, interior, edge and corner', () => {
    const g = grid(5, 4, () => 42.5);
    for (const [c, r] of [[2, 2], [0, 2], [4, 0], [0, 0], [4, 3]] as const) {
      expect(rebuildHeldOutCell(g, at(g, c, r))).toBe(42.5);
    }
  });

  it('never reads the held-out height', () => {
    const g = grid(5, 5, (c, r) => 10 + 0.3 * c - 0.2 * r);
    const i = at(g, 2, 2);
    const a = rebuildHeldOutCell(g, i);
    g.z[i] = 1e6;
    expect(rebuildHeldOutCell(g, i)).toBe(a);
  });

  it('stays within the range of the measured neighbours on a sloped plane', () => {
    const g = grid(6, 6, (c, r) => 100 + 0.5 * c + 0.25 * r);
    for (const [c, r] of [[2, 3], [0, 0], [5, 2]] as const) {
      const v = rebuildHeldOutCell(g, at(g, c, r));
      const nb: number[] = [];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc, rr = r + dr;
        if ((dc || dr) && cc >= 0 && rr >= 0 && cc < g.cols && rr < g.rows) nb.push(g.z[at(g, cc, rr)]);
      }
      expect(v).toBeGreaterThanOrEqual(Math.min(...nb) - 1e-4);
      expect(v).toBeLessThanOrEqual(Math.max(...nb) + 1e-4);
    }
  });

  it('rebuilds the centre of a symmetric ramp to its own height', () => {
    // The 8 neighbours pair off about the centre, so any symmetric fill lands on it.
    const g = grid(3, 3, (c) => 7 + c);
    expect(rebuildHeldOutCell(g, at(g, 1, 1))).toBeCloseTo(8, 4);
  });

  it('uses the one measured neighbour when it is the only one', () => {
    const g = grid(3, 3, () => 1);
    g.counts.fill(0);
    g.counts[at(g, 1, 1)] = 1;
    g.counts[at(g, 2, 0)] = 1;
    g.z[at(g, 2, 0)] = 9;
    expect(rebuildHeldOutCell(g, at(g, 1, 1))).toBeCloseTo(9, 5);
  });

  it('ignores neighbours without a return or with a NaN height', () => {
    const g = grid(3, 3, () => 4);
    g.counts[at(g, 0, 0)] = 0;
    g.z[at(g, 0, 0)] = 1000;
    g.z[at(g, 2, 2)] = Number.NaN;
    expect(rebuildHeldOutCell(g, at(g, 1, 1))).toBe(4);
  });

  it('is NaN with no measured neighbour, including a 1 x 1 grid', () => {
    const g = grid(3, 3, () => 2);
    g.counts.fill(0);
    g.counts[at(g, 1, 1)] = 1;
    expect(rebuildHeldOutCell(g, at(g, 1, 1))).toBeNaN();
    expect(rebuildHeldOutCell(grid(1, 1, () => 3), 0)).toBeNaN();
  });

  it('never reaches past the 8-neighbourhood', () => {
    const g = grid(5, 5, () => 0);
    g.z[at(g, 0, 0)] = 500; // two cells from the centre
    expect(rebuildHeldOutCell(g, at(g, 2, 2))).toBe(0);
  });

  it('is deterministic and finite under a vertical scale', () => {
    const g = grid(4, 4, (c, r) => Math.sin(c) + Math.cos(r));
    const s = { cellMetresX: 2, cellMetresY: 2, verticalUnitToMetres: 0.3048 };
    const a = rebuildHeldOutCell(g, at(g, 1, 2), s);
    expect(Number.isFinite(a)).toBe(true);
    expect(rebuildHeldOutCell(g, at(g, 1, 2), s)).toBe(a);
  });
});
