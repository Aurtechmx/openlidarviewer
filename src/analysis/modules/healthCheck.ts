import type { AnalysisModule, AnalysisResult, AnalysisRow } from '../ModuleApi';
import type { PointCloud } from '../../model/PointCloud';
import { sourcePositions } from '../../model/pointFrames';

/** Compute the median of a sorted numeric array. */
function medianSorted(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute per-axis median and MAD (median absolute deviation) for the
 * positions array. Returns arrays of length 3.
 */
function computeMedianAndMAD(positions: Float32Array, pointCount: number): {
  median: [number, number, number];
  mad: [number, number, number];
} {
  // ONE scratch buffer for all three axes, reused twice per axis. The earlier
  // shape allocated nine Float64Arrays of N (three axis copies, a `.slice()` per
  // axis, an `absDevs` per axis) where two passes over one buffer suffice — on a
  // multi-million-point cloud that is hundreds of megabytes of garbage for a
  // number that is thrown away after the row is rendered.
  //
  // The in-place reuse is sound because a median does not care about order: the
  // absolute deviations are the same MULTISET whether they are derived from the
  // axis values in file order or from the already-sorted copy, so folding
  // `|v - median|` over the sorted buffer and re-sorting yields the identical
  // MAD. NaNs ride along unchanged — `TypedArray.sort` parks them at the end
  // both times, exactly as the two-array version did.
  const scratch = new Float64Array(pointCount);

  const median: [number, number, number] = [0, 0, 0];
  const mad: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < pointCount; i++) {
      scratch[i] = positions[i * 3 + axis];
    }
    scratch.sort();
    const med = medianSorted(scratch);
    median[axis] = med;

    for (let i = 0; i < pointCount; i++) {
      scratch[i] = Math.abs(scratch[i] - med);
    }
    scratch.sort();
    mad[axis] = medianSorted(scratch);
  }

  return { median, mad };
}

function checkInvalidCoordinates(cloud: PointCloud): AnalysisRow {
  let invalidCount = 0;
  const pos = sourcePositions(cloud);
  for (let i = 0; i < pos.length; i++) {
    const v = pos[i];
    if (!isFinite(v)) {
      invalidCount++;
    }
  }
  if (invalidCount > 0) {
    return {
      label: 'Invalid Coordinates',
      value: `${invalidCount} invalid value(s) (NaN or Infinite)`,
      status: 'fail',
    };
  }
  return {
    label: 'Invalid Coordinates',
    value: 'None',
    status: 'pass',
  };
}

function checkEmptyCloud(cloud: PointCloud): AnalysisRow {
  if (cloud.pointCount === 0) {
    return {
      label: 'Empty Cloud',
      value: 'Empty — 0 points',
      status: 'fail',
    };
  }
  // The check is a VERDICT (is this cloud empty?), so the pass value is the
  // verdict — printing the loaded point count here mislabelled the display-
  // sample count as an "Empty Cloud" figure. Point counts belong to the Scan
  // Report's Point Count / Loaded rows.
  return {
    label: 'Empty Cloud',
    value: 'None',
    status: 'pass',
  };
}

/** Locale-formatted integer for the health rows ("4,683,690"). */
function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

function checkDeclaredVsDecoded(cloud: PointCloud): AnalysisRow {
  const label = 'Declared vs Decoded Count';
  // The count decoded from the file — not `pointCount`, which a downsampled
  // cloud would report as the reduced count and falsely flag as a mismatch.
  const decoded = cloud.decodedPointCount ?? cloud.pointCount;
  if (cloud.declaredPointCount === undefined) {
    return { label, value: `${fmtCount(decoded)} decoded (no declared count)`, status: 'info' };
  }
  const declared = cloud.declaredPointCount;
  if (declared === decoded) {
    return { label, value: `${fmtCount(declared)} (match)`, status: 'pass' };
  }

  // Deliberate display-sample cap: the budget plan decoded one record per
  // bucket of `loadStride`, so decoded < declared is the EXPECTED outcome of
  // the cap, not an anomaly. The stratified sampler keeps exactly one record
  // per bucket — ceil(declared / stride) — so anything at or above that is a
  // complete capped decode (informational); anything below it means the
  // decode genuinely lost points even after accounting for the cap (amber).
  const stride = cloud.loadStride ?? 1;
  if (stride > 1) {
    const expected = Math.ceil(declared / stride);
    if (decoded >= expected) {
      return {
        label,
        value: `Declared ${fmtCount(declared)} · decoded ${fmtCount(decoded)} (display sample cap)`,
        status: 'info',
      };
    }
    return {
      label,
      value:
        `Declared ${fmtCount(declared)}, expected ${fmtCount(expected)} after the ` +
        `display-sample cap, decoded ${fmtCount(decoded)} — decode lost points`,
      status: 'warn',
    };
  }

  // No full-decode count survived (a loader that doesn't record it, or an
  // older saved session): `decoded` above fell back to the in-memory count,
  // which a budget downsample legitimately reduces below `declared`. That is
  // NOT evidence of decode loss — report it neutrally rather than raising a
  // false anomaly. Genuine loss stays detectable on the paths that do record
  // the decode count (LAS/LAZ).
  if (cloud.decodedPointCount === undefined && cloud.pointCount < declared) {
    return {
      label,
      value:
        `Declared ${fmtCount(declared)} · ${fmtCount(cloud.pointCount)} in memory ` +
        `(display sample; full decode count not recorded)`,
      status: 'info',
    };
  }

  // A real mismatch on a full decode — the file header promised a different
  // count than the decoder produced.
  return {
    label,
    value: `Declared: ${fmtCount(declared)}, Decoded: ${fmtCount(decoded)}`,
    status: 'warn',
  };
}

/**
 * Scratch used to read a coordinate's IEEE-754 bit pattern. Module-level so the
 * duplicate scan allocates nothing per point.
 */
const _bitsScratch = new Float64Array(1);
const _bitsWords = new Uint32Array(_bitsScratch.buffer);

/** Vacant marker for the duplicate table; point indices are always ≥ 0. */
const EMPTY_SLOT = -1;

/**
 * The equality the duplicate scan counts by, and the ONLY definition the hash
 * is allowed to disagree with by being coarser, never finer.
 *
 * This is SameValueZero, which is exactly what the previous `"x,y,z"` string
 * key meant: `String(NaN)` is `"NaN"` for every payload, so all NaNs collided;
 * `String(-0)` is `"0"`, so -0 and +0 collided; and every other double has a
 * distinct shortest round-tripping representation, so no two unequal values
 * ever produced the same text. Keeping that definition here is what makes the
 * typed-array rewrite a drop-in — the reported count is unchanged, not merely
 * close.
 */
function sameValueZero(a: number, b: number): boolean {
  return a === b || (a !== a && b !== b);
}

/**
 * Fold one coordinate into a running 32-bit hash by its bit pattern.
 *
 * Two normalisations keep the hash consistent with {@link sameValueZero}: -0 is
 * folded as +0 and every NaN payload is folded as one constant. Without them
 * two coordinates the confirm step calls equal could land in different buckets
 * and a real duplicate would be missed.
 */
function foldCoord(hash: number, v: number): number {
  let lo: number;
  let hi: number;
  if (v !== v) {
    // One bucket for every NaN, whatever its payload. Reading a NaN out of a
    // Float32Array yields the canonical quiet NaN on the engines we ship to, so
    // no test can currently distinguish this branch from falling through to the
    // bit read — it is here because the language does NOT guarantee that (a
    // conforming implementation may surface any NaN bit pattern), and a payload
    // that reached the hash unfolded would put two points the confirm step
    // calls equal in different buckets and UNDER-count duplicates.
    lo = 0x7ff80000;
    hi = 0;
  } else {
    _bitsScratch[0] = v === 0 ? 0 : v; // -0 → +0
    lo = _bitsWords[0];
    hi = _bitsWords[1];
  }
  let h = Math.imul(hash ^ lo, 0x9e3779b1);
  h = Math.imul(h ^ hi, 0x85ebca6b);
  return h ^ (h >>> 15);
}

function checkDuplicatePoints(cloud: PointCloud): AnalysisRow {
  const n = cloud.pointCount;
  if (n === 0) {
    return { label: 'Duplicate Points', value: 'N/A (empty cloud)', status: 'info' };
  }

  // An open-addressed index table, NOT a `Set` of `"x,y,z"` strings.
  //
  // The string form allocated one JS string plus one Set entry per UNIQUE
  // point, which at the desktop point budget was the largest allocation in this
  // module by a wide margin — several hundred megabytes of short-lived strings
  // for a single integer — and on a mobile budget it was a plausible way to run
  // the tab out of memory. This table is one Int32Array of point indices sized
  // to the next power of two at or above 2n, so the load factor stays at or
  // below 0.5 and linear probing terminates quickly.
  //
  // The count stays EXACT. The hash only chooses a bucket; a collision is
  // resolved by comparing the actual three coordinates of the stored point
  // (`sameValueZero` per axis), so two distinct points that happen to hash
  // alike probe past each other instead of being miscounted as a duplicate.
  const pos = sourcePositions(cloud);
  let capacity = 1;
  while (capacity < n * 2) capacity *= 2;
  const mask = capacity - 1;
  const slots = new Int32Array(capacity).fill(EMPTY_SLOT);

  let duplicateCount = 0;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    let bucket = foldCoord(foldCoord(foldCoord(0, x), y), z) & mask;
    for (;;) {
      const stored = slots[bucket];
      if (stored === EMPTY_SLOT) {
        slots[bucket] = i;
        break;
      }
      if (
        sameValueZero(pos[stored * 3], x) &&
        sameValueZero(pos[stored * 3 + 1], y) &&
        sameValueZero(pos[stored * 3 + 2], z)
      ) {
        duplicateCount++;
        break;
      }
      bucket = (bucket + 1) & mask;
    }
  }

  if (duplicateCount > 0) {
    return {
      label: 'Duplicate Points',
      value: `${duplicateCount} duplicate(s)`,
      status: 'warn',
    };
  }
  return {
    label: 'Duplicate Points',
    value: 'None',
    status: 'pass',
  };
}

function checkStrayOutliers(cloud: PointCloud): AnalysisRow {
  const n = cloud.pointCount;
  if (n < 3) {
    return { label: 'Stray Outliers', value: 'N/A (too few points)', status: 'info' };
  }

  const pos = sourcePositions(cloud);
  const { median, mad } = computeMedianAndMAD(pos, n);
  const THRESHOLD = 8;

  let outlierCount = 0;
  for (let i = 0; i < n; i++) {
    let isOutlier = false;
    for (let axis = 0; axis < 3; axis++) {
      const v = pos[i * 3 + axis];
      const madAxis = mad[axis];
      // If MAD is 0, use a small epsilon to avoid all points being "outliers"
      const range = madAxis === 0 ? 1e-9 : THRESHOLD * madAxis;
      if (Math.abs(v - median[axis]) > range) {
        isOutlier = true;
        break;
      }
    }
    if (isOutlier) outlierCount++;
  }

  if (outlierCount > 0) {
    return {
      label: 'Stray Outliers',
      value: `${outlierCount} outlier(s) beyond median ± 8·MAD`,
      status: 'warn',
    };
  }
  return {
    label: 'Stray Outliers',
    value: 'None',
    status: 'pass',
  };
}

/**
 * Per-cloud result memo. Every check reads only the cloud's IMMUTABLE fields
 * (positions, point counts) — no scope, no classification — so the result is a
 * pure function of the cloud and is identical on every re-run. The two heavy
 * checks (the median/MAD sort + the duplicate-scan table) re-ran on every
 * Inspector refresh — a class toggle, a tab switch — stalling the main thread
 * on a multi-million-point scan. Keyed by the cloud via a WeakMap so the
 * entry is collected with the cloud; nothing to invalidate because nothing the
 * checks read can change without a new cloud.
 */
const _resultCache = new WeakMap<PointCloud, AnalysisResult>();

export const healthCheck: AnalysisModule = {
  id: 'health-check',
  label: 'Health Check',

  run(cloud: PointCloud): AnalysisResult {
    const cached = _resultCache.get(cloud);
    if (cached) return cached;
    // Every health-check row is a diagnostic — surfaced under "Advanced report".
    const rows = [
      checkInvalidCoordinates(cloud),
      checkEmptyCloud(cloud),
      checkDeclaredVsDecoded(cloud),
      checkDuplicatePoints(cloud),
      checkStrayOutliers(cloud),
    ];
    const result: AnalysisResult = { rows: rows.map((row) => ({ ...row, advanced: true })) };
    _resultCache.set(cloud, result);
    return result;
  },
};
