import type { AnalysisModule, AnalysisResult, AnalysisRow } from '../ModuleApi';
import type { PointCloud } from '../../model/PointCloud';

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
  const axes: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(pointCount),
    new Float64Array(pointCount),
    new Float64Array(pointCount),
  ];

  for (let i = 0; i < pointCount; i++) {
    axes[0][i] = positions[i * 3];
    axes[1][i] = positions[i * 3 + 1];
    axes[2][i] = positions[i * 3 + 2];
  }

  const median: [number, number, number] = [0, 0, 0];
  const mad: [number, number, number] = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const sorted = axes[axis].slice().sort();
    const med = medianSorted(sorted);
    median[axis] = med;

    // Compute absolute deviations and their median
    const absDevs = new Float64Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
      absDevs[i] = Math.abs(axes[axis][i] - med);
    }
    absDevs.sort();
    mad[axis] = medianSorted(absDevs);
  }

  return { median, mad };
}

function checkInvalidCoordinates(cloud: PointCloud): AnalysisRow {
  let invalidCount = 0;
  for (let i = 0; i < cloud.positions.length; i++) {
    const v = cloud.positions[i];
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

function checkDuplicatePoints(cloud: PointCloud): AnalysisRow {
  const n = cloud.pointCount;
  if (n === 0) {
    return { label: 'Duplicate Points', value: 'N/A (empty cloud)', status: 'info' };
  }

  // Build a set of "x,y,z" strings to find duplicates
  const seen = new Set<string>();
  let duplicateCount = 0;
  for (let i = 0; i < n; i++) {
    const key = `${cloud.positions[i * 3]},${cloud.positions[i * 3 + 1]},${cloud.positions[i * 3 + 2]}`;
    if (seen.has(key)) {
      duplicateCount++;
    } else {
      seen.add(key);
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

  const { median, mad } = computeMedianAndMAD(cloud.positions, n);
  const THRESHOLD = 8;

  let outlierCount = 0;
  for (let i = 0; i < n; i++) {
    let isOutlier = false;
    for (let axis = 0; axis < 3; axis++) {
      const v = cloud.positions[i * 3 + axis];
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
 * checks (the median/MAD sort + the duplicate-scan's N-string Set) re-ran on
 * every Inspector refresh — a class toggle, a tab switch — stalling the main
 * thread on a multi-million-point scan. Keyed by the cloud via a WeakMap so the
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
