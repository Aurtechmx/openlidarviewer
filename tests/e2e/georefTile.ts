import type { GlobalPoints } from '../../src/convert/globalPoints';

/** A 4x4 grid of points climbing 195 to 204 m, at the given global origin. */
export function tileAt(ox: number, oy: number): GlobalPoints {
  const n = 16;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = ox + (i % 4);
    y[i] = oy + Math.floor(i / 4);
    z[i] = 195 + (i % 10);
  }
  return { count: n, x, y, z };
}
