/**
 * The comparison the Zenodo small-file study relies on, on a synthetic cloud.
 * Offline and small: the study itself runs on real bytes through
 * `npm run validate:zenodo-small`, outside the default test run.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error plain ESM helper without type declarations
import { canonicalFromGlobal, compareCanonical, float32HalfUlp } from '../scripts/zenodo-study/canonical.mjs';

const Q = { scale: [0.001, 0.001, 0.001], offset: [-744000, -1036000, 0] };

function cloud(ints: Array<[number, number, number]>, cls: number[], colors?: number[]) {
  const n = ints.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  ints.forEach(([a, b, c], i) => {
    x[i] = a * Q.scale[0] + Q.offset[0];
    y[i] = b * Q.scale[1] + Q.offset[1];
    z[i] = c * Q.scale[2] + Q.offset[2];
  });
  return {
    count: n, x, y, z,
    classification: Uint8Array.from(cls),
    intensity: new Uint16Array(n),
    ...(colors ? { colors: Uint8Array.from(colors) } : {}),
  };
}

const PTS: Array<[number, number, number]> = [
  [-304049, -302980, 306107],
  [-245254, -184234, 310367],
  [-245254, -184234, 310367], // a genuine duplicate record
  [-280000, -250000, 307000],
];

describe('canonical record comparison', () => {
  it('treats a permutation as equal and keeps duplicate multiplicity', () => {
    const a = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2]), Q);
    const order = [3, 2, 0, 1];
    const b = canonicalFromGlobal(cloud(order.map((i) => PTS[i]), order.map((i) => [0, 1, 1, 2][i])), Q);
    const r = compareCanonical(a, b);
    expect(r.multisetEqual).toBe(true);
    expect(r.duplicateRecordsA).toBe(1);
    expect(r.duplicateRecordsB).toBe(1);
  });

  it('does not deduplicate: dropping one copy of a duplicate is a mismatch', () => {
    const a = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2]), Q);
    const b = canonicalFromGlobal(cloud([PTS[0], PTS[1], PTS[3]], [0, 1, 2]), Q);
    const r = compareCanonical(a, b);
    expect(r.multisetEqual).toBe(false);
    expect(r.countA - r.countB).toBe(1);
  });

  it('separates an attribute difference from a coordinate difference', () => {
    const a = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2]), Q);
    const b = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 7]), Q);
    const r = compareCanonical(a, b);
    expect(r.multisetEqual).toBe(false);
    expect(r.coordinateMismatches).toBe(0);
    expect(r.fieldMismatches.classification).toBeGreaterThan(0);
  });

  it('a one-step integer shift is a coordinate mismatch, not absorbed by a tolerance', () => {
    const a = canonicalFromGlobal(cloud(PTS, [0, 0, 0, 0]), Q);
    const shifted = PTS.map(([x, y, z], i) => (i === 0 ? [x + 1, y, z] : [x, y, z])) as Array<[number, number, number]>;
    const b = canonicalFromGlobal(cloud(shifted, [0, 0, 0, 0]), Q);
    expect(compareCanonical(a, b).coordinateMismatches).toBeGreaterThan(0);
  });

  it('fails when the reference has a field the compared side lacks', () => {
    const olv = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2]), Q);
    const ref = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2], new Array(12).fill(9)), Q);
    const r = compareCanonical(olv, ref);
    expect(r.multisetEqual).toBe(false);
    expect(r.mismatchedRecords).toBe(0);
    expect(r.missingFields).toEqual(['red8', 'green8', 'blue8']);
    expect(r.notDecodedFields).toEqual([]);
  });

  it('reports a field listed as not decoded on the path without failing', () => {
    const olv = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2]), Q);
    const ref = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2], new Array(12).fill(9)), Q);
    const r = compareCanonical(olv, ref, { notDecoded: ['red8', 'green8', 'blue8'] });
    expect(r.multisetEqual).toBe(true);
    expect(r.missingFields).toEqual([]);
    expect(r.notDecodedFields).toEqual(['red8', 'green8', 'blue8']);
  });

  it('names fields only the compared side has and does not fail on them', () => {
    const a = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2], new Array(12).fill(9)), Q);
    const b = canonicalFromGlobal(cloud(PTS, [0, 1, 1, 2]), Q);
    const r = compareCanonical(a, b);
    expect(r.multisetEqual).toBe(true);
    expect(r.notCompared.onlyA).toEqual(['red8', 'green8', 'blue8']);
    expect(r.missingFields).toEqual([]);
  });

  it('reports the float32 recentring residual within the float32 half-step bound', () => {
    const g = cloud(PTS, [0, 0, 0, 0]);
    const exact = canonicalFromGlobal(g, Q);
    expect(exact.stats.ambiguousRounding).toBe(0);
    // Recentre about a floored origin and store in float32, as the loaders do.
    const origin = [-744305, -1036303, 306];
    const local = new Float32Array(PTS.length * 3);
    for (let i = 0; i < PTS.length; i++) {
      local[i * 3] = g.x[i] - origin[0];
      local[i * 3 + 1] = g.y[i] - origin[1];
      local[i * 3 + 2] = g.z[i] - origin[2];
    }
    const back = { ...g, x: g.x.map((_, i) => local[i * 3] + origin[0]), y: g.y.map((_, i) => local[i * 3 + 1] + origin[1]), z: g.z.map((_, i) => local[i * 3 + 2] + origin[2]) };
    const c = canonicalFromGlobal(back, Q, { local });
    expect(c.stats.ambiguousRounding).toBe(0);
    for (let a = 0; a < 3; a++) {
      expect(c.stats.maxAbsError[a]).toBeLessThanOrEqual(float32HalfUlp(c.stats.maxAbsLocal[a]) + 1e-9);
    }
    expect(compareCanonical(exact, c).multisetEqual).toBe(true);
  });
});
