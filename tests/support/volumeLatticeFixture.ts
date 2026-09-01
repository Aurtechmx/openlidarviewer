/**
 * volumeLatticeFixture.ts — the shared square-footprint lattice for volume tests.
 *
 * Both the analytic volume oracle and the oracle-consensus volume family sample a
 * height field at the cell centres of an n x n lattice over the unit-area square
 * S = [-A_HALF, A_HALF]^2. Kept in one place so the two suites build the identical
 * cloud rather than each carrying its own copy.
 */

/** Half-width of the unit-area square footprint S (A = 4·A_HALF² = 1 m²). */
export const A_HALF = 0.5;

/** A height field z(x, y) over S. */
export type Field = (x: number, y: number) => number;

/** Cell centres of an n x n lattice over S, heights from `z`; flat [x,y,z,…]. */
export function latticeCloud(z: Field, n: number): Float32Array {
  const h = (2 * A_HALF) / n;
  const out = new Float32Array(n * n * 3);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = -A_HALF + (i + 0.5) * h;
    for (let j = 0; j < n; j++) {
      const y = -A_HALF + (j + 0.5) * h;
      out[k++] = x;
      out[k++] = y;
      out[k++] = z(x, y);
    }
  }
  return out;
}
