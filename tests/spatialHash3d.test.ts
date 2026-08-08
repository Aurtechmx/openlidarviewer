/**
 * spatialHash3d.test.ts — the uniform-grid neighbourhood index.
 */

import { describe, it, expect } from 'vitest';
import { SpatialHash3d } from '../src/classification/spatialHash3d';

/** N points on a regular 1 m lattice in [0,g)^3. */
function lattice(g: number): Float32Array {
  const pts: number[] = [];
  for (let x = 0; x < g; x++) for (let y = 0; y < g; y++) for (let z = 0; z < g; z++) pts.push(x, y, z);
  return new Float32Array(pts);
}

describe('SpatialHash3d', () => {
  it('radius query matches a brute-force scan exactly', () => {
    const pos = lattice(10);
    const n = pos.length / 3;
    const hash = new SpatialHash3d(pos, 2.0);
    const qx = 4, qy = 5, qz = 6, r = 2.5;
    const got = new Set(hash.queryRadius(qx, qy, qz, r));
    const brute = new Set<number>();
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - qx, dy = pos[i * 3 + 1] - qy, dz = pos[i * 3 + 2] - qz;
      if (dx * dx + dy * dy + dz * dz <= r * r) brute.add(i);
    }
    expect(got).toEqual(brute);
    expect(got.size).toBeGreaterThan(0);
  });

  it('includes the point exactly at the query location', () => {
    const pos = lattice(5);
    const hash = new SpatialHash3d(pos, 1.0);
    expect(hash.queryRadius(2, 2, 2, 0.1)).toContain((2 * 5 + 2) * 5 + 2);
  });

  it('handles a radius larger than the cell size (ceil span covers the sphere)', () => {
    const pos = lattice(12);
    const n = pos.length / 3;
    const hash = new SpatialHash3d(pos, 1.0); // cell smaller than radius
    const r = 3.5;
    const got = new Set(hash.queryRadius(6, 6, 6, r));
    let brute = 0;
    for (let i = 0; i < n; i++) {
      const dx = pos[i * 3] - 6, dy = pos[i * 3 + 1] - 6, dz = pos[i * 3 + 2] - 6;
      if (dx * dx + dy * dy + dz * dz <= r * r) brute++;
    }
    expect(got.size).toBe(brute);
  });

  it('rejects a non-positive cell size', () => {
    expect(() => new SpatialHash3d(new Float32Array([0, 0, 0]), 0)).toThrow();
  });
});
