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
 *     `samples` (≥ 2). Each sample's height is the nearest cloud point's
 *     elevation, measured along the world's up vector.
 *
 *   - The sampler walks the line in screen-perpendicular world-XY bins;
 *     each bin picks the closest cloud point and takes its elevation. If
 *     a bin sees no points within `bandWidth` of the line, the height
 *     is `NaN` — the consumer renders that gap as a discontinuity.
 *
 *   - "Closest" is measured in the horizontal (map) plane, perpendicular
 *     to `up`. This is the cartographer's definition: a cross-section is
 *     the surface seen edge-on along a transect, not the nearest 3D point.
 *
 * The cost model is deliberately simple — a single linear pass over the
 * cloud, O(N · samples). For a 1 M-point static cloud and 64 samples,
 * that's 64 M comparisons, ~300 ms on a modest laptop. The Measurements
 * panel renders the chart asynchronously and shows a "Sampling…" hint
 * while the worker runs; the full chart appears once the sampler returns.
 *
 * Streaming clouds sample only the resident points. This matches the live
 * inspector contract — what the user sees on screen is what gets sampled.
 */

import type { Vec3 } from '../navMath';

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
}

const MIN_SAMPLES = 2;
const MAX_SAMPLES = 512;

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

  // Per-sample nearest-point bookkeeping. We track the minimum perpendicular
  // distance seen in each bin so a denser sampling near the line wins over a
  // far-but-coincidentally-aligned point.
  const bestPerpSq = new Float32Array(samples);
  const bestHeight = new Float32Array(samples);
  const bestHit = new Uint8Array(samples);
  bestPerpSq.fill(Number.POSITIVE_INFINITY);

  const band = input.bandWidth == null ? horizontalLen * 0.05 : Math.max(0, input.bandWidth);
  const bandSq = band * band;

  const binStep = horizontalLen / (samples - 1);

  // a's horizontal anchor.
  const aH: Vec3 = [
    input.a[0] - u[0] * dot(input.a, u),
    input.a[1] - u[1] * dot(input.a, u),
    input.a[2] - u[2] * dot(input.a, u),
  ];

  const positions = input.positions;
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
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

    if (perpSq < bestPerpSq[binIndex]) {
      bestPerpSq[binIndex] = perpSq;
      bestHeight[binIndex] = pHeight;
      bestHit[binIndex] = 1;
    }
  }

  const out: ProfileSample[] = new Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = {
      distance: i * binStep,
      height: bestHit[i] === 1 ? bestHeight[i] : Number.NaN,
    };
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
