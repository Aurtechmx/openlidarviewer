/**
 * tests/healthCheckDuplicateExact.test.ts
 *
 * The duplicate scan in the Health Check used to key a `Set<string>` on
 * `"x,y,z"` — one JS string and one Set entry per unique point, which at the
 * desktop point budget was the largest allocation in the module. It is now an
 * open-addressed `Int32Array` of point indices keyed by a bit-pattern hash.
 *
 * A hash brings collisions, and a collision counted as a match would silently
 * INFLATE the reported duplicate count. That is the failure this file exists to
 * make impossible: every case is checked DIFFERENTIALLY against a verbatim copy
 * of the old string algorithm, so the assertion is not "the new number looks
 * right" but "the new number is the number the old code produced". The
 * handcrafted cases also carry their own hard-coded expected count, so a broken
 * reference cannot make the comparison pass vacuously.
 *
 * The equality both implementations must agree on is SameValueZero: the string
 * key made every NaN payload equal (`String(NaN)` is always `"NaN"`) and -0
 * equal to +0 (`String(-0)` is `"0"`), while every other double has a distinct
 * shortest round-tripping representation.
 */

import { healthCheck } from '../src/analysis/modules/healthCheck';
import { PointCloud } from '../src/model/PointCloud';

/**
 * The duplicate scan EXACTLY as it stood before the typed-array rewrite. Kept
 * verbatim on purpose — it is the oracle, so it must not be "cleaned up".
 */
function referenceDuplicateCount(pos: Float32Array, n: number): number {
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (let i = 0; i < n; i++) {
    const key = `${pos[i * 3]},${pos[i * 3 + 1]},${pos[i * 3 + 2]}`;
    if (seen.has(key)) {
      duplicateCount++;
    } else {
      seen.add(key);
    }
  }
  return duplicateCount;
}

/** Per-axis median + MAD exactly as it stood before the scratch-buffer reuse. */
function referenceMedianAndMAD(pos: Float32Array, n: number): {
  median: number[];
  mad: number[];
} {
  const medianSorted = (sorted: Float64Array): number => {
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const axes = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    axes[0][i] = pos[i * 3];
    axes[1][i] = pos[i * 3 + 1];
    axes[2][i] = pos[i * 3 + 2];
  }
  const median: number[] = [];
  const mad: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const sorted = axes[axis].slice().sort();
    const med = medianSorted(sorted);
    median.push(med);
    const absDevs = new Float64Array(n);
    for (let i = 0; i < n; i++) absDevs[i] = Math.abs(axes[axis][i] - med);
    absDevs.sort();
    mad.push(medianSorted(absDevs));
  }
  return { median, mad };
}

function makeCloud(positions: Float32Array): PointCloud {
  return new PointCloud({
    positions,
    origin: [0, 0, 0],
    sourceFormat: 'ply',
    name: 'dup-fixture',
  });
}

/** The count the module actually reports, read back out of its row. */
function reportedDuplicateCount(positions: Float32Array): number {
  const row = healthCheck.run(makeCloud(positions)).rows.find(
    (r) => r.label === 'Duplicate Points',
  );
  if (!row) throw new Error('Duplicate Points row missing');
  if (row.value === 'None') return 0;
  const match = /^(\d+) duplicate/.exec(row.value);
  if (!match) throw new Error(`Unparseable duplicate row: ${row.value}`);
  return Number(match[1]);
}

/** Assert the module matches the old algorithm, and report both when it does not. */
function expectMatchesReference(positions: Float32Array, expected: number): void {
  const n = Math.floor(positions.length / 3);
  const oracle = referenceDuplicateCount(positions, n);
  // Guards the oracle itself: a broken reference cannot silently agree.
  expect(oracle).toBe(expected);
  expect(reportedDuplicateCount(positions)).toBe(oracle);
}

/** Deterministic PRNG so a failing case is reproducible from the seed alone. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('healthCheck duplicate scan — exactness against the string-key original', () => {
  test('exact duplicates are counted, once per repeat', () => {
    // 1 unique + its 2 repeats, plus a triple-repeat: 2 + 2 = 4 duplicates.
    expectMatchesReference(
      Float32Array.from([
        1, 2, 3,
        1, 2, 3,
        1, 2, 3,
        7, 8, 9,
        7, 8, 9,
        7, 8, 9,
        4, 5, 6,
      ]),
      4,
    );
  });

  test('near-duplicates one float32 ULP apart are NOT duplicates', () => {
    // 2^-23 above 1 is the next representable float32, so these three points
    // survive the Float32Array round-trip as distinct values. A hash that were
    // treated as an answer rather than as a bucket would fold them together.
    const ulp = 2 ** -23;
    expectMatchesReference(
      Float32Array.from([
        1, 1, 1,
        1 + ulp, 1, 1,
        1, 1 + ulp, 1,
        1, 1, 1 + ulp,
      ]),
      0,
    );
  });

  test('a coordinate permutation is not a duplicate', () => {
    expectMatchesReference(
      Float32Array.from([
        1, 2, 3,
        3, 2, 1,
        2, 1, 3,
      ]),
      0,
    );
  });

  test('the digit-shift trap the "x,y,z" key survived is still not a duplicate', () => {
    // "1,23,4" vs "12,3,4": the same digits either side of a moved separator.
    expectMatchesReference(
      Float32Array.from([
        1, 23, 4,
        12, 3, 4,
      ]),
      0,
    );
  });

  test('NaN equals NaN, as the string key made it', () => {
    // `String(NaN)` is "NaN" for every payload, so the original counted two
    // NaN points as duplicates. The rewrite folds all NaNs into one bucket and
    // compares them equal, keeping that behaviour rather than quietly changing
    // an existing reported number.
    expectMatchesReference(
      Float32Array.from([
        NaN, 0, 0,
        NaN, 0, 0,
        0, NaN, 0,
        NaN, NaN, NaN,
        NaN, NaN, NaN,
      ]),
      2,
    );
  });

  test('+0 and -0 are the same point, as the string key made them', () => {
    expectMatchesReference(
      Float32Array.from([
        0, 0, 0,
        -0, -0, -0,
        -0, 0, -0,
      ]),
      2,
    );
  });

  test('+Infinity and -Infinity are distinct, and each duplicates itself', () => {
    expectMatchesReference(
      Float32Array.from([
        Infinity, 0, 0,
        -Infinity, 0, 0,
        Infinity, 0, 0,
        -Infinity, -Infinity, -Infinity,
      ]),
      1,
    );
  });

  test('non-finite and finite coordinates mixed in one cloud', () => {
    expectMatchesReference(
      Float32Array.from([
        1, 2, 3,
        NaN, 2, 3,
        Infinity, 2, 3,
        1, 2, 3,
        NaN, 2, 3,
        -0, 2, 3,
        0, 2, 3,
      ]),
      3,
    );
  });

  test('every point identical — the maximum-duplicate case', () => {
    const n = 500;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = 4.25;
      pos[i * 3 + 1] = -1.5;
      pos[i * 3 + 2] = 0.125;
    }
    expectMatchesReference(pos, n - 1);
  });

  test('a single point is never a duplicate of itself', () => {
    expectMatchesReference(Float32Array.from([1, 2, 3]), 0);
  });

  test('randomised clouds over a small alphabet agree with the original', () => {
    // A tiny value alphabet forces heavy duplication AND heavy probe traffic in
    // the open-addressed table, which is where a mis-resolved collision would
    // show up. Non-finite values are salted in so they exercise the same paths.
    const alphabet = [0, -0, 1, -1, 0.5, 2 ** -23, 1e7, -1e7, NaN, Infinity, -Infinity];
    for (let seed = 1; seed <= 12; seed++) {
      const rand = mulberry32(seed);
      const n = 200 + Math.floor(rand() * 800);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n * 3; i++) {
        pos[i] = alphabet[Math.floor(rand() * alphabet.length)];
      }
      const oracle = referenceDuplicateCount(pos, n);
      expect(
        reportedDuplicateCount(pos),
        `seed ${seed} (n=${n}) diverged from the string-key original`,
      ).toBe(oracle);
    }
  });

  test('randomised continuous clouds with planted duplicates agree with the original', () => {
    for (let seed = 100; seed <= 108; seed++) {
      const rand = mulberry32(seed);
      const n = 1500;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        if (i > 0 && rand() < 0.3) {
          // Plant an exact copy of an earlier point.
          const src = Math.floor(rand() * i);
          pos[i * 3] = pos[src * 3];
          pos[i * 3 + 1] = pos[src * 3 + 1];
          pos[i * 3 + 2] = pos[src * 3 + 2];
        } else {
          pos[i * 3] = (rand() - 0.5) * 1000;
          pos[i * 3 + 1] = (rand() - 0.5) * 1000;
          pos[i * 3 + 2] = (rand() - 0.5) * 1000;
        }
      }
      const oracle = referenceDuplicateCount(pos, n);
      expect(oracle).toBeGreaterThan(0); // the planting actually planted
      expect(reportedDuplicateCount(pos), `seed ${seed} diverged`).toBe(oracle);
    }
  });
});

describe('healthCheck median/MAD — scratch-buffer reuse changes no number', () => {
  /** The outlier row is the only observable of `computeMedianAndMAD`. */
  function outlierRowValue(positions: Float32Array): string {
    const row = healthCheck.run(makeCloud(positions)).rows.find(
      (r) => r.label === 'Stray Outliers',
    );
    if (!row) throw new Error('Stray Outliers row missing');
    return row.value;
  }

  /** Re-derive the outlier count from a reference median/MAD, as the module does. */
  function referenceOutlierCount(pos: Float32Array, n: number): number {
    const { median, mad } = referenceMedianAndMAD(pos, n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let axis = 0; axis < 3; axis++) {
        const range = mad[axis] === 0 ? 1e-9 : 8 * mad[axis];
        if (Math.abs(pos[i * 3 + axis] - median[axis]) > range) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  test('randomised clouds, with outliers and non-finite values, report the same count', () => {
    for (let seed = 200; seed <= 206; seed++) {
      const rand = mulberry32(seed);
      const n = 400 + Math.floor(rand() * 400);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const far = rand() < 0.02;
        for (let axis = 0; axis < 3; axis++) {
          pos[i * 3 + axis] = far ? (rand() - 0.5) * 1e6 : (rand() - 0.5) * 10;
        }
      }
      // NaNs park at the end of a typed-array sort in both shapes; prove the
      // in-place reuse did not disturb that.
      pos[3] = NaN;
      pos[7] = NaN;
      const expected = referenceOutlierCount(pos, n);
      const value = outlierRowValue(pos);
      const reported = value === 'None' ? 0 : Number(/^(\d+) outlier/.exec(value)?.[1]);
      expect(reported, `seed ${seed} diverged`).toBe(expected);
    }
  });

  test('an even-length cloud (median interpolates between two values) matches', () => {
    const pos = Float32Array.from([
      0, 0, 0,
      1, 1, 1,
      2, 2, 2,
      3, 3, 3,
      100, 100, 100,
      101, 101, 101,
    ]);
    const expected = referenceOutlierCount(pos, 6);
    const value = outlierRowValue(pos);
    const reported = value === 'None' ? 0 : Number(/^(\d+) outlier/.exec(value)?.[1]);
    expect(reported).toBe(expected);
  });
});
