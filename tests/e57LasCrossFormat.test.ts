import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadE57 } from '../src/io/loadE57';
import { loadLas } from '../src/io/loadLas';
import { writeLas14 } from '../src/convert/writeLas';
import type { GlobalPoints } from '../src/convert/globalPoints';
import type { PointCloud } from '../src/model/PointCloud';

/**
 * Cross-format equivalence: OLV's E57 reader (IEEE-754 float columns) and its
 * LAS reader (scaled-integer records) are wholly independent decode paths, yet
 * the same scan carried in both formats must reconstruct the same world-space
 * geometry. This is the committed, CI-runnable guard for that invariant, using
 * the project's own synthetic-normals E57 fixture as the E57 side and the LAS
 * writer to produce the matching LAS side from the same points.
 *
 * The empirical counterpart runs against real paired scanner exports — see
 * validation/e57-fidelity/README.md — where two ~14 M / ~37 M-point scans agree
 * to Δn = 0 and sub-millimetre bounds. That evidence is not committed (the raw
 * files are private and multi-gigabyte); this fixture-scale check protects the
 * decode paths from drifting apart in CI.
 */

// The synthetic-normals fixture's eight points; indices 3 and 7 are flagged
// invalid, so loadE57 keeps the six below (world coordinates x=i/4, y=i/2, z=i).
const VALID = [
  [0, 0, 0],
  [0.25, 0.5, 1],
  [0.5, 1.0, 2],
  [1.0, 2.0, 4],
  [1.25, 2.5, 5],
  [1.5, 3.0, 6],
];

function worldSorted(c: PointCloud): number[][] {
  const p = c.positions;
  const o = c.origin;
  const rows: number[][] = [];
  for (let i = 0; i < p.length / 3; i++) {
    rows.push([p[i * 3] + o[0], p[i * 3 + 1] + o[1], p[i * 3 + 2] + o[2]]);
  }
  // Order-independent compare: both formats may enumerate points differently.
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return rows;
}

describe('E57 ↔ LAS cross-format equivalence', () => {
  it('the E57 and LAS readers reconstruct the same world geometry', async () => {
    const bytes = readFileSync(fileURLToPath(new URL('./fixtures/synthetic-normals.e57', import.meta.url)));
    const e57Ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const fromE57 = await loadE57(e57Ab, 'synthetic-normals.e57');

    // Write the SAME six valid points to LAS via the real writer, then read them
    // back through the independent LAS decode path.
    const n = VALID.length;
    const g: GlobalPoints = {
      count: n,
      x: Float64Array.from(VALID.map((p) => p[0])),
      y: Float64Array.from(VALID.map((p) => p[1])),
      z: Float64Array.from(VALID.map((p) => p[2])),
    };
    const lasBytes = writeLas14(g, { epsg: 32633, linearUnitCode: 9001 });
    const lasAb = lasBytes.buffer.slice(
      lasBytes.byteOffset,
      lasBytes.byteOffset + lasBytes.byteLength,
    ) as ArrayBuffer;
    const fromLas = await loadLas(lasAb, 'las', 'synthetic.las');

    expect(fromE57.pointCount).toBe(n);
    expect(fromLas.pointCount).toBe(n);

    const e = worldSorted(fromE57);
    const l = worldSorted(fromLas);
    // Agreement is bounded only by the LAS 1 mm quantisation scale (0.001).
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        expect(Math.abs(e[i][a] - l[i][a])).toBeLessThanOrEqual(0.0015);
      }
    }
  });
});
