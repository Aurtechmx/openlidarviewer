import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadE57 } from '../src/io/loadE57';
import { loadLas } from '../src/io/loadLas';
import type { PointCloud } from '../src/model/PointCloud';

/**
 * The real-data leg of the E57 ↔ LAS cross-format check (see
 * validation/e57-fidelity/README.md and tests/e57LasCrossFormat.test.ts).
 *
 * It runs only when `OLV_E57_FIDELITY_DIR` points at a directory holding paired
 * scanner exports — for each `<stem>.e57` with a sibling `<stem>.las`, both are
 * decoded and their world-space geometry compared. The raw files are private
 * and multi-gigabyte, so nothing is committed and CI skips this cleanly; the
 * committed synthetic gate protects the same invariant at fixture scale.
 */
const DIR = process.env.OLV_E57_FIDELITY_DIR;

function toAB(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

function worldStats(c: PointCloud): { n: number; min: number[]; max: number[]; centroid: number[] } {
  const p = c.positions;
  const o = c.origin;
  const n = p.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const sum = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const v = p[i * 3 + a] + o[a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
      sum[a] += v;
    }
  }
  return { n, min, max, centroid: sum.map((s) => s / n) };
}

const pairs: Array<{ stem: string; e57: string; las: string }> = [];
if (DIR && existsSync(DIR)) {
  for (const f of readdirSync(DIR)) {
    if (!f.toLowerCase().endsWith('.e57')) continue;
    const stem = f.slice(0, -4);
    const las = join(DIR, `${stem}.las`);
    if (existsSync(las)) pairs.push({ stem, e57: join(DIR, f), las });
  }
}

describe.skipIf(pairs.length === 0)('E57 ↔ LAS cross-format (real paired exports)', () => {
  for (const { stem, e57, las } of pairs) {
    it(
      `${stem}: E57 and LAS agree on point count and bounds`,
      async () => {
        const se = worldStats(await loadE57(toAB(e57), `${stem}.e57`));
        const sl = worldStats(await loadLas(toAB(las), 'las', `${stem}.las`));

        // Same valid-point population.
        expect(se.n).toBe(sl.n);

        // Bounds and centroid agree within the LAS quantisation scale — a few
        // millimetres — since the only lossy step is LAS scaled-integer storage.
        const TOL = 0.01; // 10 mm: comfortably above the 1 mm LAS scale
        for (let a = 0; a < 3; a++) {
          expect(Math.abs(se.min[a] - sl.min[a])).toBeLessThanOrEqual(TOL);
          expect(Math.abs(se.max[a] - sl.max[a])).toBeLessThanOrEqual(TOL);
          expect(Math.abs(se.centroid[a] - sl.centroid[a])).toBeLessThanOrEqual(TOL);
        }
      },
      900_000,
    );
  }
});
