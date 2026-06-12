/**
 * wallSlice.ts
 *
 * Stage 1 of the floor-plan extraction pipeline: cut a HORIZONTAL POINT SLICE
 * at wall height. Architectural walls are the only structure that is present
 * at EVERY elevation of a room, so a band well above the floor (default
 * 0.7–1.8 m) contains wall returns while excluding the floor itself, most
 * furniture (tables ~0.75 m, chairs ~0.9 m sit at or below the band's bottom
 * edge), and the ceiling. Projecting just that band to 2-D gives a far
 * cleaner wall signal than the full-cloud footprint the pre-v0.4.5 sketch
 * used (which smeared floors, clutter, and ceilings into one blob).
 *
 * v0.4.5 hardening, after a real 360 interior scan produced an unusable plan:
 *
 *   - DENSE-FOOTPRINT CLIP. 360 scanners leave sparse "noise arms" (stray
 *     returns trailing tens of metres past the building). Those arms used to
 *     inflate the slice bbox, blowing up the occupancy grid and diluting its
 *     density threshold. The slice is now clipped to the occupancy-weighted
 *     bounding box first: a coarse footprint grid keeps only cells carrying
 *     real point mass, and points outside that bbox (plus a one-cell margin)
 *     are discarded as outliers — `clippedCount` reports how many.
 *   - ROBUST FLOOR ANCHOR. The floor used to come ONLY from the dominant
 *     low-band histogram peak (the spaceMetrics rule); when no peak cleared
 *     the 4% mass bar (cluttered floors, partial captures) the slice fell
 *     all the way back to FULL HEIGHT — floor, furniture and ceiling smeared
 *     into the "wall" mask. Now a missing peak falls back to a robust low
 *     PERCENTILE of the (clipped) elevations as the band anchor — the
 *     lowest dense returns are the floor or close to it — and only the floor
 *     FILL (which needs a true floor plane) stays off. `floorBasis` records
 *     which anchor was used; the artifact renders the honest wording.
 *   - WIDENED-BAND RETRY. A thin standard band (0.7–1.8 m) on a sparse or
 *     low-ceiling capture retries once with a wider band (0.4–2.4 m) before
 *     surrendering to full height.
 *
 * The histogram itself ranges over percentile-clamped elevations (0.5–99.5%)
 * so a single stray return far below the floor can no longer stretch the bins.
 *
 * Pure data, deterministic, O(sampled points). No DOM.
 */

import type { Axis } from '../../scanShape';

export interface WallSliceParams {
  /** Detected up axis (from classifyScanShape). */
  readonly upAxis: Axis;
  /** Scale from source units to metres (default 1 — assume metres). */
  readonly unitToMetres?: number;
  /** Max points to sample (uniform stride). Default 300 000. */
  readonly maxSamples?: number;
  /** Band bottom, metres above the detected floor. Default 0.7. */
  readonly bandLowM?: number;
  /** Band top, metres above the detected floor. Default 1.8. */
  readonly bandHighM?: number;
}

/** How the wall band's floor anchor was determined. */
export type FloorBasis = 'histogram' | 'percentile' | 'none';

export interface WallSlice {
  /** Wall-band point coordinates in the floor plane (h1 / h2), metres. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly count: number;
  /** Floor-band points (returns within ±0.15 m of the floor level), metres. */
  readonly floorXs: Float64Array;
  readonly floorYs: Float64Array;
  readonly floorCount: number;
  /** True when a floor-anchored wall band was used; false = full-height fallback. */
  readonly usedWallBand: boolean;
  /**
   * Anchor provenance: 'histogram' = dominant low-band density peak (a real
   * floor plane — also enables the floor fill), 'percentile' = robust lowest
   * dense returns (anchors the band only; no floor fill is claimed),
   * 'none' = full-height fallback.
   */
  readonly floorBasis: FloorBasis;
  /** Band offsets actually used, metres above the anchor (0/0 when unbanded). */
  readonly bandLowUsedM: number;
  readonly bandHighUsedM: number;
  /**
   * Detected floor elevation (metres, slice frame) — null when no HISTOGRAM
   * floor plane was found (a percentile anchor does not claim a floor plane).
   */
  readonly floorLevelM: number | null;
  /** Bounding box of the WALL-slice points [minX, minY, maxX, maxY]. */
  readonly bbox: readonly [number, number, number, number];
  /** Total finite points sampled (before banding) — honesty bookkeeping. */
  readonly sampledCount: number;
  /** Points discarded by the dense-footprint clip (noise arms / outliers). */
  readonly clippedCount: number;
  /**
   * The dense-footprint bounding box the clip actually applied
   * [minX, minY, maxX, maxY] (metres) — null when no clip was applied. This
   * is THE reference extent for reconciling the plan with the Space panel:
   * both must measure the same clipped footprint.
   */
  readonly clipBbox: readonly [number, number, number, number] | null;
}

/** Same up-frame offset convention as spaceMetrics (vertical, horizontal1/2). */
const upOffsets = (a: Axis): { v: number; h1: number; h2: number } =>
  a === 'x' ? { v: 0, h1: 1, h2: 2 } : a === 'y' ? { v: 1, h1: 0, h2: 2 } : { v: 2, h1: 0, h2: 1 };

/** Histogram bins — matches spaceMetrics so both agree on the floor peak. */
const HIST_BINS = 64;
/** A floor peak must carry ≥4% of the sample mass in one bin (spaceMetrics). */
const PEAK_MASS_FRACTION = 0.04;
/** Floor-band half thickness for the interior fill, metres. */
const FLOOR_BAND_M = 0.15;
/** Minimum wall-band points before trusting the band over the fallback. */
const MIN_BAND_POINTS = 64;
/** Robust floor-anchor percentile when no histogram peak exists. */
const FLOOR_PERCENTILE = 0.05;
/** Elevation percentile clamp for the histogram range (tail-proof bins). */
const V_CLAMP_LO = 0.005;
const V_CLAMP_HI = 0.995;
/** Widened-band retry, metres above the anchor. */
const WIDE_BAND_LOW_M = 0.4;
const WIDE_BAND_HIGH_M = 2.4;
/** Coarse footprint grid resolution for the dense-footprint clip. */
const FOOTPRINT_BINS = 96;
/** A footprint cell needs this many points to join a component. */
const FOOTPRINT_CELL_MIN = 2;
/** A component must carry ≥ this fraction of the total point mass… */
const COMPONENT_MIN_MASS_FRAC = 0.01;
/** …and never fewer points than this. */
const COMPONENT_MIN_MASS = 16;

const EMPTY = new Float64Array(0);

/** Quantile (linear interpolation) of an ASCENDING-sorted array. */
function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const idx = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Occupancy-weighted bounding box of the (h1, h2) points: rasterise onto a
 * coarse grid, find the 8-connected components of cells carrying real point
 * mass, keep the components that carry a meaningful share of the TOTAL mass,
 * and return the kept cells' bbox expanded by one cell.
 *
 * WHY components, not a bare per-cell threshold: a 360 noise arm scatters
 * hundreds of stray returns over tens of metres; random clustering gives a
 * handful of arm cells 2–3 returns each, and any per-cell threshold either
 * admits those (bbox blown out again) or — raised high enough to reject them
 * — starts rejecting genuinely sparse scans. The structural difference is
 * CONNECTED MASS: the scanned footprint is a contiguous region holding
 * almost all the points, while arm fragments are tiny broken chains of a few
 * returns. Keeping only components with ≥ 1% of the point mass (and ≥ 16
 * points) excludes every arm fragment regardless of local clustering.
 *
 * Returns null when nothing clears the bar (degenerate input — the caller
 * keeps the raw bbox).
 *
 * Exported so spaceMetrics can clip its dimension sample with the SAME rule —
 * the plan sheet and the Space panel must not disagree about the footprint.
 */
export function denseFootprintBbox(
  H1: ReadonlyArray<number>,
  H2: ReadonlyArray<number>,
): readonly [number, number, number, number] | null {
  const m = H1.length;
  if (m < 16) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < m; i++) {
    if (H1[i] < minX) minX = H1[i];
    if (H1[i] > maxX) maxX = H1[i];
    if (H2[i] < minY) minY = H2[i];
    if (H2[i] > maxY) maxY = H2[i];
  }
  const ex = maxX - minX;
  const ey = maxY - minY;
  if (!(ex > 1e-6) || !(ey > 1e-6)) return null;
  const B = FOOTPRINT_BINS;
  const cellX = ex / B;
  const cellY = ey / B;
  const counts = new Uint32Array(B * B);
  for (let i = 0; i < m; i++) {
    let c = Math.floor((H1[i] - minX) / cellX);
    if (c >= B) c = B - 1;
    let r = Math.floor((H2[i] - minY) / cellY);
    if (r >= B) r = B - 1;
    counts[r * B + c]++;
  }
  // 8-connected components over cells with ≥ FOOTPRINT_CELL_MIN points,
  // each component scored by its total point mass.
  const eligible = (i: number): boolean => counts[i] >= FOOTPRINT_CELL_MIN;
  const seen = new Uint8Array(B * B);
  const massBar = Math.max(COMPONENT_MIN_MASS, Math.ceil(m * COMPONENT_MIN_MASS_FRAC));
  let kMinC = Infinity, kMinR = Infinity, kMaxC = -Infinity, kMaxR = -Infinity;
  const stack: number[] = [];
  const component: number[] = [];
  for (let start = 0; start < B * B; start++) {
    if (seen[start] || !eligible(start)) continue;
    // Flood-fill one component, accumulating mass + remembering its cells.
    component.length = 0;
    let mass = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      component.push(i);
      mass += counts[i];
      const r = (i / B) | 0;
      const c = i - r * B;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= B) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= B) continue;
          const j = rr * B + cc;
          if (!seen[j] && eligible(j)) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    if (mass < massBar) continue; // an arm fragment / stray cluster — excluded
    for (const i of component) {
      const r = (i / B) | 0;
      const c = i - r * B;
      if (c < kMinC) kMinC = c;
      if (c > kMaxC) kMaxC = c;
      if (r < kMinR) kMinR = r;
      if (r > kMaxR) kMaxR = r;
    }
  }
  if (!(kMaxC >= kMinC) || !(kMaxR >= kMinR)) return null;
  // One-cell margin so border points straddling a kept cell's edge survive.
  return [
    minX + (kMinC - 1) * cellX,
    minY + (kMinR - 1) * cellY,
    minX + (kMaxC + 2) * cellX,
    minY + (kMaxR + 2) * cellY,
  ];
}

/**
 * Cut the wall-height slice. Returns the band's 2-D points plus the floor-band
 * points (used later for the honest "scanned floor" interior fill).
 */
export function wallSlice(
  positions: Float32Array | ReadonlyArray<number>,
  params: WallSliceParams,
): WallSlice {
  const u2m = params.unitToMetres && params.unitToMetres > 0 ? params.unitToMetres : 1;
  const maxSamples = Math.max(100, Math.floor(params.maxSamples ?? 300_000));
  const bandLow = params.bandLowM ?? 0.7;
  const bandHigh = Math.max(bandLow + 0.1, params.bandHighM ?? 1.8);
  const n = Math.floor(positions.length / 3);

  const empty: WallSlice = {
    xs: EMPTY, ys: EMPTY, count: 0,
    floorXs: EMPTY, floorYs: EMPTY, floorCount: 0,
    usedWallBand: false, floorBasis: 'none',
    bandLowUsedM: 0, bandHighUsedM: 0,
    floorLevelM: null,
    bbox: [0, 0, 0, 0], sampledCount: 0, clippedCount: 0, clipBbox: null,
  };
  if (n < 16) return empty;

  const { v: vOff, h1: h1Off, h2: h2Off } = upOffsets(params.upAxis);
  const stride = Math.max(1, Math.floor(n / maxSamples));

  let H1: number[] = [], H2: number[] = [], V: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off] * u2m;
    const h2 = positions[b + h2Off] * u2m;
    const vv = positions[b + vOff] * u2m;
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(vv)) continue;
    H1.push(h1); H2.push(h2); V.push(vv);
  }
  const sampled = V.length;
  if (sampled < 16) return empty;

  // ── Dense-footprint clip (noise arms / stray outliers OUT, walls IN) ──
  let clippedCount = 0;
  let clipBbox: readonly [number, number, number, number] | null = null;
  const denseBox = denseFootprintBbox(H1, H2);
  if (denseBox) {
    const [bx0, by0, bx1, by1] = denseBox;
    const fH1: number[] = [], fH2: number[] = [], fV: number[] = [];
    for (let i = 0; i < sampled; i++) {
      if (H1[i] < bx0 || H1[i] > bx1 || H2[i] < by0 || H2[i] > by1) continue;
      fH1.push(H1[i]); fH2.push(H2[i]); fV.push(V[i]);
    }
    // The clip must only ever REMOVE outliers — if it would eat most of the
    // scan (pathological distribution), keep the raw slice instead.
    if (fV.length >= Math.max(16, sampled * 0.5)) {
      clippedCount = sampled - fV.length;
      H1 = fH1; H2 = fH2; V = fV;
      clipBbox = denseBox;
    }
  }
  const m = V.length;
  if (m < 16) return empty;

  // ── Elevation range for the floor histogram, percentile-clamped so one
  //    stray return below the floor cannot stretch the bins. ──
  const sortedV = V.slice().sort((a, b) => a - b);
  const vLo = quantileSorted(sortedV, V_CLAMP_LO);
  const vHi = quantileSorted(sortedV, V_CLAMP_HI);
  const exV = Math.max(0, vHi - vLo);

  // ── Floor elevation: dominant low-band histogram peak (spaceMetrics rule) ──
  // A real floor concentrates a large point mass in one thin elevation band;
  // walls spread their mass evenly, so a walls-only capture has NO bin that
  // clears the 4% mass threshold and honestly reports "no floor".
  let floorLevelM: number | null = null;
  if (exV > 0) {
    const binW = exV / HIST_BINS;
    const hist = new Float64Array(HIST_BINS);
    for (let i = 0; i < m; i++) {
      let bi = Math.floor((V[i] - vLo) / binW);
      if (bi < 0) bi = 0; else if (bi >= HIST_BINS) bi = HIST_BINS - 1;
      hist[bi]++;
    }
    const hiB = Math.max(1, Math.ceil(0.45 * HIST_BINS));
    let bestBin = 0, bestCount = -1;
    for (let i = 0; i < hiB; i++) {
      if (hist[i] > bestCount) { bestCount = hist[i]; bestBin = i; }
    }
    if (bestCount >= PEAK_MASS_FRACTION * m) floorLevelM = vLo + (bestBin + 0.5) * binW;
  }

  // ── Band anchor: histogram floor, else robust low percentile. ──
  // The percentile anchor exists because real interiors with cluttered or
  // partially-scanned floors often miss the 4% single-bin bar; falling all
  // the way back to FULL HEIGHT smeared floor + furniture + ceiling into the
  // wall mask. The lowest dense returns are the floor (or close enough to
  // anchor a band that starts 0.7 m above them). It anchors the BAND only —
  // floor fill / floor area still require the histogram floor plane.
  const anchor = floorLevelM ?? quantileSorted(sortedV, FLOOR_PERCENTILE);
  const anchorBasis: FloorBasis = floorLevelM != null ? 'histogram' : 'percentile';

  const countInBand = (lo: number, hi: number): number => {
    let k = 0;
    for (let i = 0; i < m; i++) if (V[i] >= lo && V[i] <= hi) k++;
    return k;
  };

  // Standard band first; one widened retry; then the full-height fallback.
  let usedWallBand = false;
  let floorBasis: FloorBasis = 'none';
  let bandLowUsed = 0, bandHighUsed = 0;
  let lo = -Infinity, hi = Infinity;
  if (Number.isFinite(anchor)) {
    for (const [bl, bh] of [[bandLow, bandHigh], [WIDE_BAND_LOW_M, WIDE_BAND_HIGH_M]] as const) {
      if (countInBand(anchor + bl, anchor + bh) >= MIN_BAND_POINTS) {
        lo = anchor + bl;
        hi = anchor + bh;
        usedWallBand = true;
        floorBasis = anchorBasis;
        bandLowUsed = bl;
        bandHighUsed = bh;
        break;
      }
    }
  }

  const xs: number[] = [], ys: number[] = [];
  const fxs: number[] = [], fys: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < m; i++) {
    const vv = V[i];
    if (vv >= lo && vv <= hi) {
      xs.push(H1[i]); ys.push(H2[i]);
      if (H1[i] < minX) minX = H1[i];
      if (H1[i] > maxX) maxX = H1[i];
      if (H2[i] < minY) minY = H2[i];
      if (H2[i] > maxY) maxY = H2[i];
    }
    if (floorLevelM != null && Math.abs(vv - floorLevelM) <= FLOOR_BAND_M) {
      fxs.push(H1[i]); fys.push(H2[i]);
    }
  }
  if (xs.length === 0) {
    return { ...empty, floorLevelM, sampledCount: m, clippedCount, clipBbox };
  }

  return {
    xs: Float64Array.from(xs),
    ys: Float64Array.from(ys),
    count: xs.length,
    floorXs: Float64Array.from(fxs),
    floorYs: Float64Array.from(fys),
    floorCount: fxs.length,
    usedWallBand,
    floorBasis,
    bandLowUsedM: bandLowUsed,
    bandHighUsedM: bandHighUsed,
    floorLevelM,
    bbox: [minX, minY, maxX, maxY],
    sampledCount: m,
    clippedCount,
    clipBbox,
  };
}
