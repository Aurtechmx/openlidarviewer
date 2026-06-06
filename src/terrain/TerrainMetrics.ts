/**
 * TerrainMetrics.ts
 *
 * Deterministic per-neighborhood metrics. Each function takes a
 * `TerrainNeighborhood` and returns a single finite number plus the
 * sample count it used. Pure: no I/O, no globals, no Math.random.
 * Identical inputs → identical outputs across runs and across
 * platforms (we avoid sums of high-magnitude floats in different
 * orders by sorting where order matters).
 *
 * Conventions:
 *   - "Local surface" is a best-fit plane through the neighborhood
 *     samples computed by closed-form symmetric covariance. The
 *     plane normal is the eigenvector of the smallest eigenvalue of
 *     the 3x3 covariance matrix.
 *   - Slope is measured between the local-surface normal and the
 *     world up axis (+Z by convention).
 *   - Roughness is the RMS residual of every sample's signed
 *     distance to the local surface.
 *   - All metrics return NaN-safe values when the neighborhood is
 *     under-defined (fewer than 4 samples for plane-based metrics).
 *
 * These are INTERNAL deterministic primitives of the foundation layer (an
 * internal, feature-flag-gated seam). The live ground classification,
 * DTM/DSM, hillshade, slope, and height-above-ground products surfaced in
 * the Analyse panel are implemented by the confidence-aware pipeline under
 * `src/terrain/ground/`, `surface/`, and `contour/` and do not consume
 * these helpers.
 */

import type { TerrainMetric, TerrainNeighborhood, TerrainPoint } from './TerrainContracts';

// ── tiny linalg helpers (kept module-local) ─────────────────────────

function mean3(samples: ReadonlyArray<TerrainPoint>): { x: number; y: number; z: number } {
  let sx = 0, sy = 0, sz = 0;
  for (const s of samples) {
    sx += s.x;
    sy += s.y;
    sz += s.z;
  }
  const n = samples.length;
  return { x: sx / n, y: sy / n, z: sz / n };
}

/** 3x3 symmetric covariance matrix of a sample set. */
function covariance3(samples: ReadonlyArray<TerrainPoint>): {
  xx: number;
  yy: number;
  zz: number;
  xy: number;
  xz: number;
  yz: number;
} {
  const m = mean3(samples);
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (const s of samples) {
    const dx = s.x - m.x;
    const dy = s.y - m.y;
    const dz = s.z - m.z;
    xx += dx * dx;
    yy += dy * dy;
    zz += dz * dz;
    xy += dx * dy;
    xz += dx * dz;
    yz += dy * dz;
  }
  const n = samples.length;
  return {
    xx: xx / n,
    yy: yy / n,
    zz: zz / n,
    xy: xy / n,
    xz: xz / n,
    yz: yz / n,
  };
}

/** A unit vector. */
type Vec3 = [number, number, number];

/** Cross product, returning the result + its magnitude. */
function cross(
  a: Vec3,
  b: Vec3,
): { v: Vec3; len: number } {
  const vx = a[1] * b[2] - a[2] * b[1];
  const vy = a[2] * b[0] - a[0] * b[2];
  const vz = a[0] * b[1] - a[1] * b[0];
  const len = Math.hypot(vx, vy, vz);
  return { v: [vx, vy, vz], len };
}

/**
 * Smallest-eigenvalue eigenvector of a 3x3 symmetric matrix. Returns
 * a unit-length vector oriented to align with the supplied world-up
 * axis (positive dot product). NaN-safe — when the matrix is fully
 * degenerate, returns the worldUp axis itself so downstream slope
 * reads as "flat".
 *
 * Robustness: for each of the three eigenvectors we try ALL THREE
 * pairs of rows of `M − λI` and take the longest cross product.
 * Single-pair recipes fail when the chosen rows are linearly
 * dependent (which happens for a vertical wall whose normal lies in
 * XY, among other steep cases). The longest cross product is the
 * one whose two rows are least collinear and gives the most
 * numerically stable eigenvector.
 */
function smallestEigenvector(
  m: { xx: number; yy: number; zz: number; xy: number; xz: number; yz: number },
  worldUp: Vec3 = [0, 0, 1],
): Vec3 {
  // Three eigenvalues of a 3x3 symmetric — use the characteristic
  // polynomial. We add a tiny epsilon to avoid singular matrices
  // when samples are exactly coplanar.
  const eps = 1e-12;
  const a = m.xx + eps;
  const b = m.yy + eps;
  const c = m.zz + eps;
  const d = m.xy;
  const e = m.xz;
  const f = m.yz;
  const p1 = d * d + e * e + f * f;
  if (p1 === 0) {
    // Diagonal matrix — eigenvalues are the diagonal entries.
    const eigs = [a, b, c];
    const minIdx = eigs.indexOf(Math.min(...eigs));
    const axis: Vec3 =
      minIdx === 0 ? [1, 0, 0] : minIdx === 1 ? [0, 1, 0] : [0, 0, 1];
    return orientToward(axis, worldUp);
  }
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const B = [
    [(a - q) / p, d / p, e / p],
    [d / p, (b - q) / p, f / p],
    [e / p, f / p, (c - q) / p],
  ];
  const det =
    B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) -
    B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) +
    B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0]);
  const r = Math.max(-1, Math.min(1, det / 2));
  const phi = Math.acos(r) / 3;
  const eig = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  // Three rows of (M − λI). The null space of this matrix is the
  // eigenvector. Cross any two independent rows to get it.
  const row1: Vec3 = [a - eig, d, e];
  const row2: Vec3 = [d, b - eig, f];
  const row3: Vec3 = [e, f, c - eig];
  // Try all three pairs and take the longest result — least collinear
  // input rows give the most stable cross product.
  const c12 = cross(row1, row2);
  const c13 = cross(row1, row3);
  const c23 = cross(row2, row3);
  const best =
    c12.len >= c13.len && c12.len >= c23.len
      ? c12
      : c13.len >= c23.len
        ? c13
        : c23;
  if (!Number.isFinite(best.len) || best.len === 0) {
    return [worldUp[0], worldUp[1], worldUp[2]];
  }
  const unit: Vec3 = [
    best.v[0] / best.len,
    best.v[1] / best.len,
    best.v[2] / best.len,
  ];
  return orientToward(unit, worldUp);
}

/**
 * Flip `v` so it has a non-negative dot product with `up`. Keeps the
 * normal consistently oriented for slope and HAG sign conventions.
 */
function orientToward(v: Vec3, up: Vec3): Vec3 {
  const dot = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
  return dot < 0 ? [-v[0], -v[1], -v[2]] : v;
}

/** Dot of two 3-vectors. */
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function packMetric(
  name: TerrainMetric['name'],
  value: number,
  samples: number,
  radius: number,
): TerrainMetric {
  return { name, value: Number.isFinite(value) ? value : Number.NaN, sampleCount: samples, radius };
}

// ── public metrics ──────────────────────────────────────────────────

/** Resolve the worldUp default — Z-up unless overridden. */
function worldUpOf(nh: TerrainNeighborhood): Vec3 {
  const u = nh.worldUp;
  return u ? [u[0], u[1], u[2]] : [0, 0, 1];
}

/** Resolve the linear-unit-to-metres default. */
function linearUnitOf(nh: TerrainNeighborhood): number {
  const u = nh.linearUnitToMetres;
  return typeof u === 'number' && Number.isFinite(u) && u > 0 ? u : 1;
}

/**
 * Local slope in degrees between the local surface normal and the
 * neighborhood's `worldUp` axis. Returns NaN when the SAMPLES set
 * has fewer than 3 points (insufficient for a plane fit; the centre
 * is intentionally excluded so it can't pull the plane toward
 * itself).
 */
export function localSlopeDegrees(nh: TerrainNeighborhood): TerrainMetric {
  if (nh.samples.length < 3) {
    return packMetric('slope-degrees', Number.NaN, nh.samples.length + 1, nh.radius);
  }
  const up = worldUpOf(nh);
  const cov = covariance3(nh.samples);
  const n = smallestEigenvector(cov, up);
  // Angle between normal and worldUp.
  const cos = Math.max(-1, Math.min(1, Math.abs(dot3(n, up))));
  const degrees = (Math.acos(cos) * 180) / Math.PI;
  return packMetric('slope-degrees', degrees, nh.samples.length + 1, nh.radius);
}

/**
 * Roughness as RMS residual of every sample's signed distance to the
 * local surface, in metres (scaled by `linearUnitToMetres`).
 *
 * The plane is fit to SAMPLES ONLY (centre excluded) so the
 * centre's residual is honest. The residual sum then includes ALL
 * samples — the centre is omitted because including it would
 * artificially deflate the roughness of an anomalous centre point.
 */
export function roughnessRms(nh: TerrainNeighborhood): TerrainMetric {
  if (nh.samples.length < 3) {
    return packMetric('roughness-rms', Number.NaN, nh.samples.length + 1, nh.radius);
  }
  const up = worldUpOf(nh);
  const cov = covariance3(nh.samples);
  const n = smallestEigenvector(cov, up);
  const m = mean3(nh.samples);
  let sumSq = 0;
  for (const s of nh.samples) {
    const d = (s.x - m.x) * n[0] + (s.y - m.y) * n[1] + (s.z - m.z) * n[2];
    sumSq += d * d;
  }
  const rmsLocal = Math.sqrt(sumSq / nh.samples.length);
  return packMetric(
    'roughness-rms',
    rmsLocal * linearUnitOf(nh),
    nh.samples.length + 1,
    nh.radius,
  );
}

/**
 * Approximate mean curvature via the ratio of the smallest to the
 * sum of the three eigenvalues of the covariance matrix. The trace
 * is invariant under rotation so the metric is rotation-stable.
 * Values are in `[0, 1/3]` — higher means more curved.
 *
 * Fit to SAMPLES ONLY so an anomalous centre point doesn't pull the
 * covariance toward itself.
 */
export function meanCurvatureApprox(nh: TerrainNeighborhood): TerrainMetric {
  if (nh.samples.length < 3) {
    return packMetric('curvature-mean', Number.NaN, nh.samples.length + 1, nh.radius);
  }
  const cov = covariance3(nh.samples);
  const trace = cov.xx + cov.yy + cov.zz;
  if (trace <= 0) return packMetric('curvature-mean', 0, nh.samples.length + 1, nh.radius);
  const up = worldUpOf(nh);
  const n = smallestEigenvector(cov, up);
  // λ_min = nᵀ C n (Rayleigh quotient).
  const lambdaMin =
    n[0] * (cov.xx * n[0] + cov.xy * n[1] + cov.xz * n[2]) +
    n[1] * (cov.xy * n[0] + cov.yy * n[1] + cov.yz * n[2]) +
    n[2] * (cov.xz * n[0] + cov.yz * n[1] + cov.zz * n[2]);
  return packMetric(
    'curvature-mean',
    lambdaMin / trace,
    nh.samples.length + 1,
    nh.radius,
  );
}

/**
 * Variance along the worldUp axis (centre + samples), reported in
 * metres² (scaled by `linearUnitToMetres²`).
 */
export function elevationVariance(nh: TerrainNeighborhood): TerrainMetric {
  const all = [nh.centre, ...nh.samples];
  if (all.length < 2) return packMetric('elevation-variance', Number.NaN, all.length, nh.radius);
  const up = worldUpOf(nh);
  // Project each point onto worldUp.
  let sum = 0;
  for (const s of all) sum += dot3([s.x, s.y, s.z], up);
  const mean = sum / all.length;
  let sq = 0;
  for (const s of all) {
    const h = dot3([s.x, s.y, s.z], up);
    sq += (h - mean) * (h - mean);
  }
  const scale = linearUnitOf(nh);
  return packMetric(
    'elevation-variance',
    (sq / all.length) * scale * scale,
    all.length,
    nh.radius,
  );
}

/**
 * Sample density: count of points in the neighborhood divided by the
 * area of the horizontal circle of the given `radius`.
 *
 * IMPORTANT — the radius query is CYLINDRICAL (filters on XY radius,
 * any Z), so the count includes vertically-stacked returns. The
 * denominator is the horizontal footprint area. The result is a
 * "horizontal projected density" — useful for ground / canopy
 * comparison but it overestimates true sample density when the
 * neighborhood spans tall vegetation or buildings.
 *
 * Future producers that need a 3D density should filter the
 * radius-query result on Z themselves and divide by a sphere volume.
 *
 * Returns NaN when `radius` is zero.
 */
export function pointDensity(nh: TerrainNeighborhood): TerrainMetric {
  const all = [nh.centre, ...nh.samples];
  if (nh.radius <= 0) return packMetric('point-density', Number.NaN, all.length, nh.radius);
  const area = Math.PI * nh.radius * nh.radius;
  return packMetric('point-density', all.length / area, all.length, nh.radius);
}

/**
 * Height above the local plane fit, evaluated at the centre point.
 * Signed: positive when the centre sits above the surface (along
 * worldUp).
 *
 * The plane is fit to SAMPLES ONLY (centre excluded) — otherwise an
 * anomalous centre point pulls the surface fit toward itself and
 * the measured height is systematically biased toward zero. This is
 * the height-above-ground foundation; correctness here matters
 * because vegetation and building detection thresholds read it
 * directly.
 *
 * Returned value is in metres (scaled by `linearUnitToMetres`).
 */
export function heightAboveLocalSurface(nh: TerrainNeighborhood): TerrainMetric {
  // Need at least 3 samples (not counting centre) for a stable plane fit.
  if (nh.samples.length < 3) {
    return packMetric(
      'height-above-local-surface',
      Number.NaN,
      nh.samples.length + 1,
      nh.radius,
    );
  }
  const up = worldUpOf(nh);
  const cov = covariance3(nh.samples);
  const n = smallestEigenvector(cov, up);
  const m = mean3(nh.samples);
  const d =
    (nh.centre.x - m.x) * n[0] +
    (nh.centre.y - m.y) * n[1] +
    (nh.centre.z - m.z) * n[2];
  return packMetric(
    'height-above-local-surface',
    d * linearUnitOf(nh),
    nh.samples.length + 1,
    nh.radius,
  );
}

/** Range along worldUp (max − min) of the neighborhood, in metres. */
export function neighborhoodElevationRange(nh: TerrainNeighborhood): TerrainMetric {
  const all = [nh.centre, ...nh.samples];
  if (all.length === 0) return packMetric('neighborhood-elevation-range', Number.NaN, 0, nh.radius);
  const up = worldUpOf(nh);
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of all) {
    const h = dot3([s.x, s.y, s.z], up);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return packMetric(
    'neighborhood-elevation-range',
    (hi - lo) * linearUnitOf(nh),
    all.length,
    nh.radius,
  );
}

/**
 * Local planarity score in `[0, 1]`. Computed as `1 − 3·λ_min/Σλ` —
 * 1 for a perfect plane, 0 for an isotropic 3D cloud.
 *
 * LIMITATION — this metric reads "high" for both planes AND LINES.
 * A linear cluster of samples (curb, fence line, sapling stem)
 * yields λ_min ≈ 0 because the points are collinear, not because
 * they form a plane. The eigenvalue ratio alone can't distinguish
 * the two. Future producers that need plane-vs-line discrimination
 * should also compute `(λ₂ − λ₁) / λ₃` (linearity) and threshold on
 * it.
 */
export function localPlanarity(nh: TerrainNeighborhood): TerrainMetric {
  const c = meanCurvatureApprox(nh);
  if (!Number.isFinite(c.value)) return packMetric('local-planarity', Number.NaN, c.sampleCount, nh.radius);
  return packMetric('local-planarity', 1 - 3 * c.value, c.sampleCount, nh.radius);
}

/**
 * Compute every metric for a neighborhood with the plane fit shared
 * across the four metrics that need it (slope, roughness, curvature
 * /planarity, height-above-local-surface). The covariance + smallest
 * eigenvector are computed ONCE per call. Per-metric helpers above
 * still recompute independently — use `allMetrics` when the caller
 * reads more than one metric to avoid the 4× redundant
 * eigendecomposition.
 *
 * The plane fit walks SAMPLES ONLY (centre excluded) so the centre
 * can't pull the surface toward itself; this is the same fix
 * applied to the individual helpers.
 */
export function allMetrics(
  nh: TerrainNeighborhood,
): Readonly<Record<TerrainMetric['name'], TerrainMetric>> {
  const total = nh.samples.length + 1;
  // Need 3 samples (centre excluded) for a stable plane fit.
  if (nh.samples.length < 3) {
    return {
      'slope-degrees': packMetric('slope-degrees', Number.NaN, total, nh.radius),
      'roughness-rms': packMetric('roughness-rms', Number.NaN, total, nh.radius),
      'curvature-mean': packMetric('curvature-mean', Number.NaN, total, nh.radius),
      'elevation-variance': elevationVariance(nh),
      'point-density': pointDensity(nh),
      'height-above-local-surface': packMetric(
        'height-above-local-surface',
        Number.NaN,
        total,
        nh.radius,
      ),
      'neighborhood-elevation-range': neighborhoodElevationRange(nh),
      'local-planarity': packMetric('local-planarity', Number.NaN, total, nh.radius),
    };
  }
  const up = worldUpOf(nh);
  const unit = linearUnitOf(nh);
  // Single shared eigendecomposition for the plane-fit metrics —
  // fit to SAMPLES only.
  const cov = covariance3(nh.samples);
  const n = smallestEigenvector(cov, up);
  const m = mean3(nh.samples);
  // Slope (degrees) — angle between normal and worldUp.
  const cosUp = Math.max(-1, Math.min(1, Math.abs(dot3(n, up))));
  const slopeDeg = (Math.acos(cosUp) * 180) / Math.PI;
  // Roughness (RMS residual to plane) — walk SAMPLES only so an
  // anomalous centre doesn't inflate the residual artificially.
  let sumSq = 0;
  for (const s of nh.samples) {
    const d = (s.x - m.x) * n[0] + (s.y - m.y) * n[1] + (s.z - m.z) * n[2];
    sumSq += d * d;
  }
  const rough = Math.sqrt(sumSq / nh.samples.length) * unit;
  // Height above the (samples-only) plane — measure centre vs plane.
  const heightAbove =
    ((nh.centre.x - m.x) * n[0] +
      (nh.centre.y - m.y) * n[1] +
      (nh.centre.z - m.z) * n[2]) *
    unit;
  // Curvature via Rayleigh quotient = λ_min / trace.
  const trace = cov.xx + cov.yy + cov.zz;
  const lambdaMin =
    n[0] * (cov.xx * n[0] + cov.xy * n[1] + cov.xz * n[2]) +
    n[1] * (cov.xy * n[0] + cov.yy * n[1] + cov.yz * n[2]) +
    n[2] * (cov.xz * n[0] + cov.yz * n[1] + cov.zz * n[2]);
  const curvature = trace > 0 ? lambdaMin / trace : 0;
  return {
    'slope-degrees': packMetric('slope-degrees', slopeDeg, total, nh.radius),
    'roughness-rms': packMetric('roughness-rms', rough, total, nh.radius),
    'curvature-mean': packMetric('curvature-mean', curvature, total, nh.radius),
    'elevation-variance': elevationVariance(nh),
    'point-density': pointDensity(nh),
    'height-above-local-surface': packMetric(
      'height-above-local-surface',
      heightAbove,
      total,
      nh.radius,
    ),
    'neighborhood-elevation-range': neighborhoodElevationRange(nh),
    'local-planarity': packMetric(
      'local-planarity',
      1 - 3 * curvature,
      total,
      nh.radius,
    ),
  };
}

// ── ground confidence scaffold ─────────────────────────────────────

import type { GroundScore } from './TerrainContracts';

/**
 * Compute a per-neighborhood ground-likelihood score from the
 * deterministic metrics. SCORING SCAFFOLD ONLY — this foundation helper
 * does NOT classify points; it produces a 0..100 confidence with reasons.
 * Actual ground classification on the live Analyse path is done by the SMRF
 * filter in `src/terrain/ground/groundFilter.ts`, independently of this
 * scaffold.
 *
 * The four axes:
 *
 *   slopeScore       — low slope contributes positively (ground is flat).
 *   roughnessScore   — low roughness contributes positively.
 *   varianceScore    — low elevation variance contributes positively.
 *   densityScore     — denser sampling means a more reliable measurement.
 *
 * Each sub-score is 0..100 with a tunable knee. The composite
 * confidence is the arithmetic mean.
 */
export function computeGroundScore(nh: TerrainNeighborhood): GroundScore {
  const metrics = allMetrics(nh);
  const reasons: string[] = [];

  const slope = metrics['slope-degrees'].value;
  const slopeScore = Number.isFinite(slope)
    ? Math.max(0, 100 - slope * 4) // 0° → 100, 25° → 0
    : 0;
  if (Number.isFinite(slope) && slope > 25) reasons.push(`steep slope (${slope.toFixed(1)}°)`);

  const roughness = metrics['roughness-rms'].value;
  const roughnessScore = Number.isFinite(roughness)
    ? Math.max(0, 100 - roughness * 50) // 0 → 100, 2.0 m → 0
    : 0;
  if (Number.isFinite(roughness) && roughness > 0.5) {
    reasons.push(`high roughness (${roughness.toFixed(2)} m RMS)`);
  }

  const variance = metrics['elevation-variance'].value;
  const varianceScore = Number.isFinite(variance)
    ? Math.max(0, 100 - variance * 20) // 0 → 100, 5 m² → 0
    : 0;

  const density = metrics['point-density'].value;
  const densityScore = Number.isFinite(density)
    ? Math.min(100, density * 2) // 50 pts/m² → 100
    : 0;
  if (Number.isFinite(density) && density < 5) {
    reasons.push(`sparse sampling (${density.toFixed(1)} pts/m²)`);
  }

  const confidence = (slopeScore + roughnessScore + varianceScore + densityScore) / 4;
  if (reasons.length === 0) reasons.push('all axes within ground-typical ranges');

  return {
    confidence: Math.max(0, Math.min(100, confidence)),
    slopeScore,
    roughnessScore,
    varianceScore,
    densityScore,
    reasons,
  };
}
