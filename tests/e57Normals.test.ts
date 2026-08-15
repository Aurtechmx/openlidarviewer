import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';

/**
 * Surface normals ride the libE57 `nor:` extension namespace, so real scanner
 * files declare `nor:normalX/Y/Z`, not the bare `normalX`. The reader keys its
 * decoded columns by the raw (prefixed) field name; `loadE57` must still resolve
 * them by LOCAL name, or the normals decode and are silently dropped and the
 * Viewer's normal-shading mode stays dark for exactly the files that ship the
 * data. This fixture (scripts/make-e57-normals-fixture.mjs) is the regression
 * target: eight points, indices 3 and 7 flagged invalid, normals cycling through
 * the three axis-aligned unit vectors.
 */
const fixture = readFileSync(
  fileURLToPath(new URL('./fixtures/synthetic-normals.e57', import.meta.url)),
);
const buffer = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);

describe('E57 namespaced surface normals', () => {
  it('decodes the normals under the nor: extension prefix', () => {
    const { scans } = parseE57(buffer);
    expect(scans).toHaveLength(1);
    const names = scans[0].fields.map((f) => f.name);
    expect(names).toContain('nor:normalX');
    expect(names).toContain('nor:normalY');
    expect(names).toContain('nor:normalZ');
    // The bare names must NOT be present — this is the exact case the bare
    // lookup missed.
    expect(names).not.toContain('normalX');
  });

  it('loadE57 resolves namespaced normals into the PointCloud as unit vectors', async () => {
    const cloud = await loadE57(buffer, 'synthetic-normals.e57');
    // The two invalid records (indices 3, 7) are dropped; six survive in order.
    expect(cloud.pointCount).toBe(6);
    expect(cloud.normals).toBeDefined();
    const n = cloud.normals!;
    expect(n.length).toBe(6 * 3);

    // Surviving indices 0,1,2,4,5,6 → axes cycle by i % 3.
    const expected = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ];
    for (let p = 0; p < 6; p++) {
      expect(n[p * 3]).toBeCloseTo(expected[p][0], 6);
      expect(n[p * 3 + 1]).toBeCloseTo(expected[p][1], 6);
      expect(n[p * 3 + 2]).toBeCloseTo(expected[p][2], 6);
      const len = Math.hypot(n[p * 3], n[p * 3 + 1], n[p * 3 + 2]);
      expect(len).toBeCloseTo(1, 6);
    }
  });
});
