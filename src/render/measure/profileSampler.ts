/**
 * profileSampler.ts
 *
 * Sample a height-vs-distance profile along a cross-section line. Pure,
 * unit-testable in Node (no three.js, no DOM). The v0.3.5 release shipped
 * the scalar geometry of a Profile measurement (`profileMetrics` in
 * `geometry.ts`); this module is the v0.3.7 chart half.
 *
 * The contract:
 *
 *   - Given two endpoints `a` and `b` in local render-space and a flat
 *     point cloud (positions Float32Array, x/y/z interleaved), return a
 *     polyline of `(distanceAlongLine, height)` samples whose count is
 *     `samples` (≥ 2). Each sample's height is a robust statistic of the
 *     cloud points inside that bin's corridor, measured along `up`.
 *
 *   - The sampler walks the line in screen-perpendicular world-XY bins;
 *     each bin collects EVERY cloud point within `bandWidth` of the line
 *     and reduces them to one elevation with a percentile estimator (see
 *     below). If a bin sees no points, the height is `NaN` — the consumer
 *     renders that gap as a discontinuity, never an interpolation.
 *
 *   - "Within the corridor" is measured in the horizontal (map) plane,
 *     perpendicular to `up`. This is the cartographer's definition: a
 *     cross-section is the surface seen edge-on along a transect.
 *
 * Why a percentile, not the nearest point (the scientific core):
 *
 *   A LiDAR corridor over real ground contains bare-earth returns AND
 *   higher returns from vegetation, wires, vehicles, and noise. Picking
 *   the single nearest point per bin makes the chosen surface jump
 *   between canopy and ground from one bin to the next — a spiky line
 *   that is a SAMPLING ARTEFACT, not real micro-topography, and that
 *   corrupts any slope read off it. Instead each bin takes a low
 *   percentile of its corridor elevations (`groundPercentile`, default
 *   25). Because non-ground returns sit ABOVE the ground, a low
 *   percentile rejects them and recovers the bare-earth transect using
 *   MORE data, not less — de-noising by aggregation, never by inventing
 *   values between samples. The percentile is the standard type-7
 *   quantile (linear interpolation between order statistics), so the
 *   estimate is continuous and reproducible. A `groundPercentile` of 50
 *   gives the median (robust to symmetric noise but keeps real bumps);
 *   0 gives the strict floor, 100 the canopy top.
 *
 * The cost model is a single linear pass to bin the points, O(N), then a
 * per-bin sort, O(Σ b log b). For a 1 M-point cloud and 64 bins that is
 * tens of ms. The Measurements panel samples asynchronously.
 *
 * Streaming clouds sample only the resident points. This matches the live
 * inspector contract — what the user sees on screen is what gets sampled.
 */

import type { Vec3 } from '../navMath';
import { NON_GROUND_CLASSES } from '../../terrain/ground/classificationFilter';

// Inline vector helpers — duplicated from `geometry.ts` where they are
// also module-local. Cheap, branch-free, no allocations beyond return
// values. Keeping them here lets the module ship as a pure leaf unit.
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}
function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len === 0) return [0, 0, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** A single profile sample — distance along the line and elevation. */
export interface ProfileSample {
  /** Distance from `a` along the horizontal projection of the line, metres. */
  distance: number;
  /** Elevation at this distance (along `up`). NaN if no points were near. */
  height: number;
}

/** Inputs to `sampleProfile`. */
export interface SampleProfileInput {
  /** Profile line start, local render-space. */
  a: Vec3;
  /** Profile line end, local render-space. */
  b: Vec3;
  /** World up vector in local render-space (usually [0, 0, 1] for Z-up). */
  up: Vec3;
  /** Interleaved x/y/z point positions (Float32Array length is 3 · N). */
  positions: Float32Array;
  /** Sample count along the line (clamped 2..512). */
  samples: number;
  /**
   * Horizontal band width on each side of the line, metres. A point further
   * than this from the line in the horizontal plane is ignored. The default
   * `null` means "auto" — use 5 % of the horizontal line length.
   */
  bandWidth?: number | null;
  /**
   * Per-bin elevation percentile (0..100) used to reduce the corridor
   * points to one height. Default 25 — a bare-earth estimate that
   * rejects vegetation/noise (which sit above the ground). 50 = median,
   * 0 = strict floor, 100 = canopy top. `null` falls back to the default.
   */
  groundPercentile?: number | null;
  /**
   * Per-point ASPRS classification, index-aligned with `positions`. When
   * present, vegetation / building / noise returns are dropped from each
   * corridor BEFORE the percentile, so trees can't pull the bare-earth line
   * up — the profile is computed over classified ground returns. Omit when
   * the cloud carries no classification (the percentile alone is used).
   */
  classification?: Uint8Array | ReadonlyArray<number> | null;
  /** ASPRS classes to drop when classification is supplied. Default veg/building/noise. */
  excludeClasses?: ReadonlyArray<number>;
}

const MIN_SAMPLES = 2;
const MAX_SAMPLES = 512;
const DEFAULT_GROUND_PERCENTILE = 25;

/**
 * Type-7 quantile (linear interpolation between order statistics) over a
 * pre-sorted ascending array. `p` is in [0, 100]. Matches the default of
 * NumPy / R / Excel PERCENTILE.INC so results are reproducible against
 * standard tools. Caller guarantees `sorted.length >= 1`.
 */
function percentileSorted(sorted: Float64Array, count: number, p: number): number {
  if (count === 1) return sorted[0];
  const frac = Math.max(0, Math.min(100, p)) / 100;
  const rank = frac * (count - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Sample a height-vs-distance profile along the segment a → b.
 *
 * Returns a `samples`-long array of `(distance, height)` pairs. Distance
 * is measured in the horizontal plane (perpendicular to `up`), so the
 * chart's X-axis matches what an engineer would draw on paper.
 *
 * Algorithm: for each cloud point, project it onto the horizontal line,
 * compute the perpendicular distance, and (if within `bandWidth`) update
 * the bin's nearest-point record. After the linear pass, walk the bins
 * and emit `(distance, nearestHeight)` for each.
 */
export function sampleProfile(input: SampleProfileInput): ProfileSample[] {
  const samples = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, input.samples | 0));
  const u = normalize(input.up);

  // Horizontal projection of the line a → b.
  const ab = sub(input.b, input.a);
  const verticalAB = dot(ab, u);
  const hAB: Vec3 = [
    ab[0] - u[0] * verticalAB,
    ab[1] - u[1] * verticalAB,
    ab[2] - u[2] * verticalAB,
  ];
  const horizontalLen = length(hAB);

  // Degenerate line (a == b in plan) — return two samples at a's elevation.
  if (horizontalLen < 1e-9) {
    const aH = dot(input.a, u);
    return [
      { distance: 0, height: aH },
      { distance: 0, height: aH },
    ];
  }

  const hDir: Vec3 = [hAB[0] / horizontalLen, hAB[1] / horizontalLen, hAB[2] / horizontalLen];

  // Per-bin corridor collection. Every point within the band contributes
  // its elevation to its bin; the bin is later reduced to one height via
  // the percentile estimator. One growable array per bin.
  const binElevations: number[][] = new Array(samples);
  for (let i = 0; i < samples; i++) binElevations[i] = [];

  const band = input.bandWidth == null ? horizontalLen * 0.05 : Math.max(0, input.bandWidth);
  const bandSq = band * band;
  const percentile =
    input.groundPercentile == null ? DEFAULT_GROUND_PERCENTILE : input.groundPercentile;

  const binStep = horizontalLen / (samples - 1);

  // a's horizontal anchor.
  const aH: Vec3 = [
    input.a[0] - u[0] * dot(input.a, u),
    input.a[1] - u[1] * dot(input.a, u),
    input.a[2] - u[2] * dot(input.a, u),
  ];

  const positions = input.positions;
  const n = positions.length / 3;
  // Classification gate — drop vegetation / building / noise so they never
  // enter a corridor's elevation statistics. Only active when an aligned
  // classification channel was supplied.
  const cls = input.classification && input.classification.length === n ? input.classification : null;
  const drop = cls ? new Set(input.excludeClasses ?? NON_GROUND_CLASSES) : null;
  for (let i = 0; i < n; i++) {
    if (drop && drop.has(cls![i])) continue;
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];

    // Horizontal vector from a to this point.
    const pHeight = px * u[0] + py * u[1] + pz * u[2];
    const dx = px - u[0] * pHeight - aH[0];
    const dy = py - u[1] * pHeight - aH[1];
    const dz = pz - u[2] * pHeight - aH[2];

    // Along-line scalar (distance along hDir from a's horizontal anchor).
    const along = dx * hDir[0] + dy * hDir[1] + dz * hDir[2];
    if (along < -band || along > horizontalLen + band) continue;

    // Perpendicular distance (horizontal-plane, squared).
    const pdx = dx - hDir[0] * along;
    const pdy = dy - hDir[1] * along;
    const pdz = dz - hDir[2] * along;
    const perpSq = pdx * pdx + pdy * pdy + pdz * pdz;
    if (perpSq > bandSq) continue;

    // Bin index (clamped so band-extension hits the end bins).
    let binIndex = Math.round(along / binStep);
    if (binIndex < 0) binIndex = 0;
    if (binIndex > samples - 1) binIndex = samples - 1;

    binElevations[binIndex].push(pHeight);
  }

  // Reduce each bin's corridor elevations to one robust height.
  const out: ProfileSample[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const els = binElevations[i];
    let height = Number.NaN;
    if (els.length > 0) {
      const sorted = Float64Array.from(els).sort();
      height = percentileSorted(sorted, sorted.length, percentile);
    }
    out[i] = { distance: i * binStep, height };
  }
  return out;
}

/**
 * Summary statistics over a profile sample series — for the chart card's
 * headline strip (min, max, span). NaN samples (no-coverage bins) are
 * skipped; if every sample is NaN the summary returns NaN fields and a
 * `coverage` of 0.
 */
export interface ProfileSummary {
  /** Minimum elevation seen across all bins (NaN if no hits). */
  minHeight: number;
  /** Maximum elevation seen across all bins (NaN if no hits). */
  maxHeight: number;
  /** maxHeight − minHeight (NaN if no hits). */
  heightSpan: number;
  /** Fraction of bins that have a hit (0..1). */
  coverage: number;
}

export function summariseProfile(samples: readonly ProfileSample[]): ProfileSummary {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let hits = 0;
  for (const s of samples) {
    if (!Number.isFinite(s.height)) continue;
    hits++;
    if (s.height < min) min = s.height;
    if (s.height > max) max = s.height;
  }
  if (hits === 0) {
    return { minHeight: NaN, maxHeight: NaN, heightSpan: NaN, coverage: 0 };
  }
  return {
    minHeight: min,
    maxHeight: max,
    heightSpan: max - min,
    coverage: hits / samples.length,
  };
}
