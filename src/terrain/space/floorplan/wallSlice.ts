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
  /**
   * Adapt the wall band to the densest vertical wall-return zone above the
   * floor instead of using the fixed {@link bandLowM}–{@link bandHighM} band.
   * Default true. When a clear wall-evidence peak is found the band is
   * RE-CENTRED on it (countertop / industrial scans whose walls sit outside
   * 0.7–1.8 m then slice correctly); when no clear peak exists the fixed
   * default band is used unchanged. Set false to pin the fixed band.
   */
  readonly adaptiveBand?: boolean;
}

/** How the wall band's vertical extent was chosen. */
export type BandBasis = 'fixed' | 'adaptive';

/** How the wall band's floor anchor was determined. */
export type FloorBasis = 'histogram' | 'percentile' | 'none';

export interface WallSlice {
  /** Wall-band point coordinates in the floor plane (h1 / h2), metres. */
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  /**
   * Per-band-point ELEVATION (vertical axis, metres, slice frame), parallel to
   * {@link xs}/{@link ys}. Kept so a downstream pass can build a per-cell
   * height profile (z-spread) for the furniture-vs-structure classifier — a
   * tall thin column spans the whole band; a low blob occupies only its bottom.
   */
  readonly zs: Float64Array;
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
   * Whether the band offsets were the FIXED default (0.7–1.8 m or the widened
   * retry) or ADAPTIVE (re-centred on the detected wall-evidence z-peak).
   * 'fixed' when no band was cut at all (full-height fallback).
   */
  readonly bandBasis: BandBasis;
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

// ── Adaptive wall-band detection ─────────────────────────────────────────────
/** Bin width (m) of the above-floor wall-evidence histogram. */
const ADAPT_BIN_M = 0.1;
/** Ignore returns below this height above the floor (floor + low clutter). */
const ADAPT_FLOOR_CLEARANCE_M = 0.15;
/** Ignore returns above this height (ceilings on tall industrial scans). */
const ADAPT_CEILING_CLAMP_M = 6.0;
/**
 * A wall-evidence zone must hold a SUSTAINED density across its whole window:
 * its LEAST-dense bin must still carry at least this fraction of the mean
 * above-clearance bin mass. Walls return at every elevation (every bin in the
 * window is populated), so a wall window clears this; a floor/ceiling plane or
 * a furniture top is a single dense SPIKE with sparse neighbours, so its
 * window's minimum bin is near-empty and it is rejected. (Scoring by the
 * window MINIMUM, not its sum, is what separates a broad wall slab from a
 * narrow horizontal-plane spike — see {@link detectWallBand}.)
 */
const ADAPT_SUSTAIN_FRAC = 0.5;
/** Vertical window (m) the wall evidence is measured over (a slab is ~0.8 m). */
const ADAPT_PEAK_WINDOW_M = 0.8;
/**
 * Minimum re-centre distance (m): if the detected wall zone's centre sits
 * within this of the fixed band's centre, the fixed band is kept (no point
 * nudging a slice that is already on the walls — keeps standard rooms on the
 * well-tested 0.7–1.8 m band). Only a genuinely off-centre wall zone adapts.
 */
const ADAPT_RECENTRE_MIN_M = 0.35;

/**
 * Detect the densest vertical WALL-EVIDENCE zone above the floor and return a
 * band re-centred on it; null when no clear sustained peak exists (the caller
 * then keeps the fixed default band).
 *
 * WHY a sustained window, not a bare max bin: architectural walls return at
 * EVERY elevation of the room, so a wall zone shows up as a broad plateau of
 * vertical density; furniture (a countertop edge, a cabinet top) or a
 * floor/ceiling plane shows up as a narrow SPIKE at one height. Scoring the
 * densest contiguous {@link ADAPT_PEAK_WINDOW_M}-tall window by its WEAKEST
 * bin (so a one-bin spike never wins) and requiring that sustained floor to
 * clear {@link ADAPT_SUSTAIN_FRAC} of the mean bin mass keeps the detector
 * locked onto walls and off horizontal planes / low clutter — and lets it
 * FIND walls at non-standard heights (counters at 0.3–2.5 m, racking,
 * mezzanines) the fixed 0.7–1.8 m band would slice through or miss entirely.
 *
 * `defaultCentreM` (the fixed band's centre above the anchor) is the
 * TIE-BREAK target: when the wall evidence is broad and uniform (a normal
 * full-height room), many windows tie on the weakest-bin score, so the
 * detector keeps the one nearest the default centre — and when that nearest
 * window IS essentially the default band ({@link ADAPT_RECENTRE_MIN_M} away or
 * less), it returns null so the fixed band stands unchanged. The adaptive band
 * therefore only MOVES the slice when there is a genuinely off-centre wall
 * zone, never when the standard band already sits on the walls.
 *
 * Returns offsets ABOVE THE ANCHOR (metres), centred on the chosen window with
 * the requested band thickness, clamped so the band never dips below the floor
 * clearance. Exported for unit tests.
 */
export function detectWallBand(
  V: ReadonlyArray<number>,
  anchor: number,
  bandThicknessM: number,
  defaultCentreM: number,
): { lowM: number; highM: number } | null {
  const m = V.length;
  if (m < MIN_BAND_POINTS || !(bandThicknessM > 0)) return null;
  // Histogram of heights ABOVE the floor anchor, within the clearance/ceiling
  // window so the floor and far ceiling cannot dominate.
  const lo = ADAPT_FLOOR_CLEARANCE_M;
  const hi = ADAPT_CEILING_CLAMP_M;
  const nBins = Math.max(1, Math.ceil((hi - lo) / ADAPT_BIN_M));
  const hist = new Float64Array(nBins);
  let total = 0;
  for (let i = 0; i < m; i++) {
    const h = V[i] - anchor;
    if (h < lo || h >= hi) continue;
    let bi = Math.floor((h - lo) / ADAPT_BIN_M);
    if (bi >= nBins) bi = nBins - 1;
    hist[bi]++;
    total++;
  }
  if (total < MIN_BAND_POINTS) return null;
  // Highest occupied bin (so the "mean bin mass" reflects the real vertical
  // extent of returns, not the full 6 m clearance window most of which is air).
  let lastOccupied = -1;
  for (let i = nBins - 1; i >= 0; i--) {
    if (hist[i] > 0) { lastOccupied = i; break; }
  }
  if (lastOccupied < 0) return null;
  const occupiedBins = lastOccupied + 1;
  const meanBinMass = total / occupiedBins;
  // Slide a window of ADAPT_PEAK_WINDOW_M; score each by its WEAKEST bin (the
  // sustained-density floor of the window), so a broad wall slab beats a
  // narrow horizontal-plane / furniture spike whose neighbours are near-empty.
  const winBins = Math.max(1, Math.round(ADAPT_PEAK_WINDOW_M / ADAPT_BIN_M));
  if (winBins > occupiedBins) return null;
  const winSpanM = winBins * ADAPT_BIN_M;
  let bestStart = -1;
  let bestMin = -1;
  let bestCentreDist = Infinity;
  for (let s = 0; s + winBins <= occupiedBins; s++) {
    let windowMin = Infinity;
    for (let k = 0; k < winBins; k++) if (hist[s + k] < windowMin) windowMin = hist[s + k];
    const centreM = lo + s * ADAPT_BIN_M + winSpanM / 2;
    const centreDist = Math.abs(centreM - defaultCentreM);
    // Maximise the sustained floor; among ties prefer the window nearest the
    // default band centre (so uniform full-height walls keep the standard band).
    if (windowMin > bestMin || (windowMin === bestMin && centreDist < bestCentreDist)) {
      bestMin = windowMin;
      bestStart = s;
      bestCentreDist = centreDist;
    }
  }
  // The sustained floor must clear ADAPT_SUSTAIN_FRAC of the mean bin mass —
  // otherwise there is no broad wall zone and the fixed band stands.
  if (bestStart < 0 || bestMin < ADAPT_SUSTAIN_FRAC * meanBinMass) return null;
  // Centre of the densest sustained window, in metres above the anchor.
  const winLoM = lo + bestStart * ADAPT_BIN_M;
  const centreM = winLoM + winSpanM / 2;
  // If the detected wall zone is essentially where the default band already
  // sits, do not re-centre — let the fixed band stand (keeps normal rooms on
  // the well-tested 0.7–1.8 m slice).
  if (Math.abs(centreM - defaultCentreM) <= ADAPT_RECENTRE_MIN_M) return null;
  let lowM = centreM - bandThicknessM / 2;
  let highM = centreM + bandThicknessM / 2;
  // Never dip below the floor clearance — a band must clear the floor itself.
  if (lowM < lo) {
    highM += lo - lowM;
    lowM = lo;
  }
  return { lowM, highM };
}
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
    xs: EMPTY, ys: EMPTY, zs: EMPTY, count: 0,
    floorXs: EMPTY, floorYs: EMPTY, floorCount: 0,
    usedWallBand: false, floorBasis: 'none',
    bandLowUsedM: 0, bandHighUsedM: 0, bandBasis: 'fixed',
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

  // Band selection. When adaptive (default), first try a band RE-CENTRED on
  // the densest vertical wall-evidence zone above the floor — this is what
  // lets countertop / industrial scans, whose walls sit outside 0.7–1.8 m,
  // slice correctly. If no clear wall-evidence peak exists, or its band is too
  // sparse, fall back to the fixed default band, then the widened retry, then
  // the full-height fallback. The fixed thickness for the adaptive band is the
  // configured default span (bandHigh − bandLow) so the caller still controls
  // how thick a slice it wants.
  const adaptiveOn = params.adaptiveBand ?? true;
  let usedWallBand = false;
  let floorBasis: FloorBasis = 'none';
  let bandBasis: BandBasis = 'fixed';
  let bandLowUsed = 0, bandHighUsed = 0;
  let lo = -Infinity, hi = Infinity;
  if (Number.isFinite(anchor)) {
    interface Candidate { bl: number; bh: number; basis: BandBasis }
    const candidates: Candidate[] = [];
    if (adaptiveOn) {
      const defaultCentreM = (bandLow + bandHigh) / 2;
      const adapt = detectWallBand(V, anchor, bandHigh - bandLow, defaultCentreM);
      if (adapt) candidates.push({ bl: adapt.lowM, bh: adapt.highM, basis: 'adaptive' });
    }
    candidates.push({ bl: bandLow, bh: bandHigh, basis: 'fixed' });
    candidates.push({ bl: WIDE_BAND_LOW_M, bh: WIDE_BAND_HIGH_M, basis: 'fixed' });
    for (const { bl, bh, basis } of candidates) {
      if (countInBand(anchor + bl, anchor + bh) >= MIN_BAND_POINTS) {
        lo = anchor + bl;
        hi = anchor + bh;
        usedWallBand = true;
        floorBasis = anchorBasis;
        bandBasis = basis;
        bandLowUsed = bl;
        bandHighUsed = bh;
        break;
      }
    }
  }

  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const fxs: number[] = [], fys: number[] = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < m; i++) {
    const vv = V[i];
    if (vv >= lo && vv <= hi) {
      xs.push(H1[i]); ys.push(H2[i]); zs.push(vv);
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
    zs: Float64Array.from(zs),
    count: xs.length,
    floorXs: Float64Array.from(fxs),
    floorYs: Float64Array.from(fys),
    floorCount: fxs.length,
    usedWallBand,
    floorBasis,
    bandLowUsedM: bandLowUsed,
    bandHighUsedM: bandHighUsed,
    bandBasis,
    floorLevelM,
    bbox: [minX, minY, maxX, maxY],
    sampledCount: m,
    clippedCount,
    clipBbox,
  };
}
