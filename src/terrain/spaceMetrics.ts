/**
 * spaceMetrics.ts
 *
 * Measurements for a NON-TERRAIN scan — an interior space (a room / 360 /
 * iPhone-LiDAR capture with a floor + ceiling) or a compact object — computed
 * in the detected up-frame. This is the space/object-appropriate analysis that
 * replaces terrain contours for scans `classifyScanShape` flags `nonTerrain`.
 *
 * Grounded in what phone capture apps (Polycam Space Mode, Apple RoomPlan)
 * surface: room dimensions, floor area, ceiling height, enclosed volume,
 * floor/wall/ceiling presence, storey count, and capture quality.
 *
 * HONESTY: every figure is derived from the points currently loaded / streamed
 * and may change as more streams in. Ceilings are often sparsely captured
 * (a known RoomPlan-style limitation), so ceiling height and enclosed volume
 * are approximate. No survey-grade / certified claims are made, and a point
 * cloud has no watertight interior — "enclosed volume" is floor area × ceiling
 * height, an envelope, not a solid measurement.
 *
 * Pure data, deterministic, O(sampled). No ML, no RANSAC.
 */

import type { Axis } from './scanShape';
import { objectMetrics } from './objectMetrics';
import { denseFootprintBbox } from './space/floorplan/wallSlice';

/** Exact metre→foot factor (1 ft = 0.3048 m). */
const FT_PER_M = 1 / 0.3048;

export const metresToFeet = (m: number): number => m * FT_PER_M;
export const sqMetresToSqFeet = (a: number): number => a * FT_PER_M * FT_PER_M;
export const cubicMetresToCubicFeet = (v: number): number => v * FT_PER_M * FT_PER_M * FT_PER_M;

/** L × W × H, in metres. Length ≥ width (oriented footprint), height vertical. */
export interface SpaceDims {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
}

export interface PlaneReport {
  readonly floorPresent: boolean;
  /** Floor plane area (m²) — null when no floor plane is detected. */
  readonly floorAreaM2: number | null;
  readonly ceilingPresent: boolean;
  /** Ceiling plane area (m²) — null when no ceiling is detected (open object). */
  readonly ceilingAreaM2: number | null;
  /** Share of perimeter footprint cells whose returns span most of the height. */
  readonly wallCoveragePct: number;
  /** Approximate count of dominant wall sides (0..4) — clearly an estimate. */
  readonly dominantWallDirections: number;
}

export interface CaptureQuality {
  /** Points actually used (after striding to the sample budget). */
  readonly sampledPointCount: number;
  /** Source / resident point count the sample was drawn from. */
  readonly sourcePointCount: number;
  /**
   * Points per m² of occupied footprint, describing the SCAN: the sampled
   * count is scaled back up by the known stride (sourcePointCount /
   * sampledPointCount — uniform striding, so the ratio IS the stride). The
   * pre-v0.4.5 figure divided only the sample by the area, under-reporting
   * density by the stride factor (100× at stride 100).
   */
  readonly densityPerM2: number;
  /** Approximate mean point spacing (m), from the scan's areal density. */
  readonly meanSpacingM: number;
  /** Occupied footprint fraction (%) — coverage / completeness. */
  readonly coveragePct: number;
  /** Whether the scan carries per-point colour. */
  readonly hasRgb: boolean;
}

export interface SpaceMetrics {
  readonly spaceKind: 'interior' | 'object';
  readonly up: Axis;
  readonly dims: SpaceDims;
  /** Occupied-footprint (floor) area, m². */
  readonly floorAreaM2: number;
  /** Floor→ceiling height, m — null when no clear ceiling (open object). */
  readonly ceilingHeightM: number | null;
  /** Floor area × ceiling height, m³; envelope fallback when no ceiling. */
  readonly enclosedVolumeM3: number | null;
  readonly planes: PlaneReport;
  /** Storey / level count from well-separated floor peaks (≥ ~2.2 m apart). */
  readonly storyCount: number;
  readonly quality: CaptureQuality;
  /** Honesty caveats + basis strings. */
  readonly reasons: readonly string[];
}

export interface SpaceMetricsParams {
  /** Detected up axis (from classifyScanShape). */
  readonly upAxis: Axis;
  /** Which presentation to lean on. */
  readonly spaceKind: 'interior' | 'object';
  /** Scale from source units to metres (default 1 — assume metres). */
  readonly unitToMetres?: number;
  /** Whether the scan carries colour. */
  readonly hasRgb?: boolean;
  /** Honest source/resident count the sample was drawn from. */
  readonly sourcePointCount?: number;
  /**
   * True when the analysed points are the resident subset of a still-streaming
   * cloud, not the whole scan. Leads the caveats with the stronger "Preliminary
   * — partial stream" note so the figures are not read as final. Default false.
   */
  readonly residentOnly?: boolean;
  /** Max points to sample. Default 60000. */
  readonly maxSamples?: number;
  /** Footprint grid resolution (cells per axis). Default 48. */
  readonly gridN?: number;
}

/** Vertical band (fraction of height) that counts as floor / ceiling. */
const PLANE_BAND = 0.15;
const PLANE_COVER = 0.45;
/** Min separation (m) between storeys. */
const STOREY_SEP_M = 2.2;
const STREAM_CAVEAT =
  'Based on the points currently loaded / streamed — values may change as more data streams in.';
/**
 * Stronger caveat for a genuine PARTIAL stream (only the resident octree nodes
 * were measured). The dimensions/areas/volumes are computed on a coarse, partial
 * subsample, so they can shift a lot as the cloud fills in — say so plainly and
 * lead with it (see ObjectPanel._caveats). Parallels the terrain assessment's
 * "Preliminary" partial-stream verdict.
 */
const PARTIAL_STREAM_CAVEAT =
  'Preliminary — only the streamed-in part of the scan has been measured so far; dimensions, areas and volumes will change as more loads. Let the full cloud stream in, then re-run.';

const upOffsets = (a: Axis): { v: number; h1: number; h2: number } =>
  a === 'x' ? { v: 0, h1: 1, h2: 2 } : a === 'y' ? { v: 1, h1: 0, h2: 2 } : { v: 2, h1: 0, h2: 1 };

/** 2-D PCA on the horizontal projection → oriented footprint side lengths. */
function orientedFootprint(h1: number[], h2: number[]): { major: number; minor: number } {
  const m = h1.length;
  if (m < 3) return { major: 0, minor: 0 };
  let cx = 0, cy = 0;
  for (let i = 0; i < m; i++) { cx += h1[i]; cy += h2[i]; }
  cx /= m; cy /= m;
  let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < m; i++) {
    const dx = h1[i] - cx, dy = h2[i] - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  xx /= m; yy /= m; xy /= m;
  const tr = xx + yy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (xx * yy - xy * xy)));
  const l1 = tr / 2 + disc;
  // Principal direction for the larger eigenvalue l1.
  let ax: number, ay: number;
  if (Math.abs(xy) > 1e-12) { ax = l1 - yy; ay = xy; } else { ax = 1; ay = 0; }
  const len = Math.hypot(ax, ay) || 1;
  ax /= len; ay /= len;
  const bx = -ay, by = ax; // perpendicular
  let lo1 = Infinity, hi1 = -Infinity, lo2 = Infinity, hi2 = -Infinity;
  for (let i = 0; i < m; i++) {
    const dx = h1[i] - cx, dy = h2[i] - cy;
    const p1 = dx * ax + dy * ay;
    const p2 = dx * bx + dy * by;
    if (p1 < lo1) lo1 = p1; if (p1 > hi1) hi1 = p1;
    if (p2 < lo2) lo2 = p2; if (p2 > hi2) hi2 = p2;
  }
  const r1 = Math.max(0, hi1 - lo1);
  const r2 = Math.max(0, hi2 - lo2);
  return { major: Math.max(r1, r2), minor: Math.min(r1, r2) };
}

/**
 * Count storeys from the height histogram. A storey is a strong FLOOR peak with
 * a genuine room above it AND a real floor-to-floor separation to the next one.
 *
 * Robustness rules (deterministic; tuned to avoid over-counting):
 *   - peaks must clear a mass threshold (local maxima of ≥25% of the tallest bin);
 *   - candidate floor peaks merge when closer than one storey (STOREY_SEP_M),
 *     keeping the stronger — so a single thick slab is one storey, not several;
 *   - a merged peak only counts as a storey when there is point MASS in the room
 *     above it (distinguishing a floor from a ceiling, which has nothing above);
 *   - to count a SECOND (or later) storey, there must additionally be a real
 *     floor-to-floor gap to the previous counted floor AND a separating interface
 *     (point mass — a ceiling/floor slab) BETWEEN the two levels. This stops a
 *     single tall room's ceiling (a strong high peak with empty space below it)
 *     from being mistaken for a second floor.
 */
function countStoreys(hist: Float64Array, binW: number, minV: number, total: number): number {
  const B = hist.length;
  let maxC = 0;
  for (let i = 0; i < B; i++) if (hist[i] > maxC) maxC = hist[i];
  if (maxC <= 0) return 0;
  const thresh = 0.25 * maxC;
  const peaks: Array<{ level: number; count: number }> = [];
  for (let i = 0; i < B; i++) {
    if (hist[i] < thresh) continue;
    const lft = i > 0 ? hist[i - 1] : -1;
    const rgt = i < B - 1 ? hist[i + 1] : -1;
    if (hist[i] >= lft && hist[i] >= rgt) peaks.push({ level: minV + (i + 0.5) * binW, count: hist[i] });
  }
  // Merge peaks closer than one storey, keeping the stronger.
  const merged: Array<{ level: number; count: number }> = [];
  for (const p of peaks) {
    const last = merged[merged.length - 1];
    if (!last || p.level - last.level >= STOREY_SEP_M) merged.push({ ...p });
    else if (p.count > last.count) { last.level = p.level; last.count = p.count; }
  }
  /** Point mass within the half-open height band (lo, hi]. */
  const massBetween = (lo: number, hi: number): number => {
    let mass = 0;
    for (let i = 0; i < B; i++) {
      const lv = minV + (i + 0.5) * binW;
      if (lv > lo && lv <= hi) mass += hist[i];
    }
    return mass;
  };
  // Count floors with a room above; require a real gap AND a separating interface
  // (point mass) between successive counted floors.
  const MIN_ROOM_MASS = 0.02 * total; // a real room above the floor
  const MIN_INTERFACE_MASS = 0.01 * total; // a slab/ceiling separating two storeys
  let floors = 0;
  let prevFloorLevel = -Infinity;
  for (const p of merged) {
    const roomAbove = massBetween(p.level + 0.5, p.level + 4.0);
    if (roomAbove <= MIN_ROOM_MASS) continue; // a ceiling, not a floor — skip
    if (floors === 0) {
      floors = 1;
      prevFloorLevel = p.level;
      continue;
    }
    // Second+ storey: needs a genuine floor-to-floor gap AND a separating
    // interface (point mass) between the previous floor and this one.
    const gapOk = p.level - prevFloorLevel >= STOREY_SEP_M;
    const interfaceMass = massBetween(prevFloorLevel + 0.5, p.level - 0.5);
    if (gapOk && interfaceMass > MIN_INTERFACE_MASS) {
      floors++;
      prevFloorLevel = p.level;
    }
  }
  return Math.max(1, floors);
}

export function spaceMetrics(
  positions: Float32Array | ReadonlyArray<number>,
  params: SpaceMetricsParams,
): SpaceMetrics {
  const up = params.upAxis;
  const spaceKind = params.spaceKind;
  const u2m = params.unitToMetres && params.unitToMetres > 0 ? params.unitToMetres : 1;
  const hasRgb = params.hasRgb === true;
  const gridN = Math.max(8, Math.floor(params.gridN ?? 48));
  const maxSamples = Math.max(100, Math.floor(params.maxSamples ?? 60_000));
  const n = Math.floor(positions.length / 3);
  const sourcePointCount = params.sourcePointCount ?? n;

  const reasons: string[] = [params.residentOnly ? PARTIAL_STREAM_CAVEAT : STREAM_CAVEAT];
  const blankQuality: CaptureQuality = {
    sampledPointCount: 0, sourcePointCount, densityPerM2: 0,
    meanSpacingM: 0, coveragePct: 0, hasRgb,
  };
  const blank: SpaceMetrics = {
    spaceKind, up,
    dims: { lengthM: 0, widthM: 0, heightM: 0 },
    floorAreaM2: 0, ceilingHeightM: null, enclosedVolumeM3: null,
    planes: { floorPresent: false, floorAreaM2: null, ceilingPresent: false, ceilingAreaM2: null, wallCoveragePct: 0, dominantWallDirections: 0 },
    storyCount: 0, quality: blankQuality,
    reasons: [...reasons, 'Too few points to measure this space yet.'],
  };
  if (n < 16) return blank;

  const { v: vOff, h1: h1Off, h2: h2Off } = upOffsets(up);
  const stride = Math.max(1, Math.floor(n / maxSamples));

  let H1: number[] = [], H2: number[] = [], V: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off] * u2m, h2 = positions[b + h2Off] * u2m, vv = positions[b + vOff] * u2m;
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(vv)) continue;
    H1.push(h1); H2.push(h2); V.push(vv);
  }
  if (V.length < 16) return blank;

  // ── Dense-footprint clip — the SAME rule the floor-plan slice applies ──
  // 360 scans trail sparse stray returns ("noise arms") tens of metres past
  // the building. The floor plan clips them before tracing walls; until
  // v0.4.5 the panel did NOT, so the panel's L × W (PCA over everything,
  // arms included) could disagree with the plan sheet's extents by 2×. Both
  // now measure the same dense footprint, and the exclusion is reported.
  let clippedCount = 0;
  const denseBox = denseFootprintBbox(H1, H2);
  if (denseBox) {
    const [bx0, by0, bx1, by1] = denseBox;
    const fH1: number[] = [], fH2: number[] = [], fV: number[] = [];
    for (let i = 0; i < V.length; i++) {
      if (H1[i] < bx0 || H1[i] > bx1 || H2[i] < by0 || H2[i] > by1) continue;
      fH1.push(H1[i]); fH2.push(H2[i]); fV.push(V[i]);
    }
    // Only ever REMOVE outliers — keep the raw sample if the clip would eat
    // most of the scan (pathological distribution).
    if (fV.length >= Math.max(16, V.length * 0.5)) {
      clippedCount = V.length - fV.length;
      H1 = fH1; H2 = fH2; V = fV;
    }
  }
  if (clippedCount > 0) {
    reasons.push(
      `${clippedCount.toLocaleString()} stray return(s) outside the dense footprint were excluded — dimensions describe the scanned space, matching the floor-plan sheet.`,
    );
  }

  let minH1 = Infinity, maxH1 = -Infinity, minH2 = Infinity, maxH2 = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < V.length; i++) {
    if (H1[i] < minH1) minH1 = H1[i]; if (H1[i] > maxH1) maxH1 = H1[i];
    if (H2[i] < minH2) minH2 = H2[i]; if (H2[i] > maxH2) maxH2 = H2[i];
    if (V[i] < minV) minV = V[i]; if (V[i] > maxV) maxV = V[i];
  }
  const m = V.length;

  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);

  // ── Oriented dimensions (footprint from 2-D PCA, height from vertical AABB) ──
  const fp = orientedFootprint(H1, H2);
  const dims: SpaceDims = { lengthM: fp.major, widthM: fp.minor, heightM: exV };

  // ── Footprint occupancy grid + per-cell vertical span ──
  // Size the grid to the data: cells finer than the point spacing would leave
  // gaps and undercount floor area, so derive a target cell ≈ 2× the floor's
  // horizontal spacing (estimated from the floor-band point count), capped at
  // the requested resolution.
  const band0 = PLANE_BAND * exV;
  let floorBandPts = 0;
  for (let i = 0; i < m; i++) if (V[i] <= minV + band0) floorBandPts++;
  const bboxArea = ex1 * ex2;
  let cols = gridN, rows = gridN;
  if (floorBandPts > 0 && bboxArea > 0) {
    const targetCell = 2 * Math.sqrt(bboxArea / floorBandPts);
    if (targetCell > 0) {
      cols = Math.min(gridN, Math.max(4, Math.round(ex1 / targetCell)));
      rows = Math.min(gridN, Math.max(4, Math.round(ex2 / targetCell)));
    }
  }
  const cellW = ex1 > 0 ? ex1 / cols : 1;
  const cellH = ex2 > 0 ? ex2 / rows : 1;
  const cellArea = cellW * cellH;
  const zMin = new Float32Array(cols * rows).fill(Infinity);
  const zMax = new Float32Array(cols * rows).fill(-Infinity);
  const occ = new Uint8Array(cols * rows);
  for (let i = 0; i < m; i++) {
    let c = Math.floor((H1[i] - minH1) / cellW); if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    let r = Math.floor((H2[i] - minH2) / cellH); if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    const idx = r * cols + c;
    occ[idx] = 1;
    if (V[i] < zMin[idx]) zMin[idx] = V[i];
    if (V[i] > zMax[idx]) zMax[idx] = V[i];
  }
  let occupied = 0;
  for (let i = 0; i < occ.length; i++) if (occ[i]) occupied++;
  const floorAreaM2 = occupied * cellArea;
  const coveragePct = (100 * occupied) / (cols * rows);

  // ── Height histogram (density over vertical extent) — the primary signal ──
  // Built before plane detection so floor/ceiling are picked from density-weighted
  // peaks (where the point MASS sits), which survives a cluttered floor or a
  // partial ceiling far better than a raw per-cell band-coverage test alone.
  const B = 64;
  const binW = exV > 0 ? exV / B : 1;
  const hist = new Float64Array(B);
  for (let i = 0; i < m; i++) {
    let bi = Math.floor((V[i] - minV) / binW); if (bi < 0) bi = 0; else if (bi >= B) bi = B - 1;
    hist[bi]++;
  }
  /** Bin (level) of the strongest histogram peak within [loFrac, hiFrac). */
  const peakBin = (loFrac: number, hiFrac: number): { bin: number; count: number; level: number } => {
    const loB = Math.floor(loFrac * B), hiB = Math.min(B, Math.ceil(hiFrac * B));
    let bi = loB, best = -1;
    for (let i = loB; i < hiB; i++) if (hist[i] > best) { best = hist[i]; bi = i; }
    return { bin: bi, count: best, level: minV + (bi + 0.5) * binW };
  };
  const peakLevel = (loFrac: number, hiFrac: number): number => peakBin(loFrac, hiFrac).level;

  // ── Floor / ceiling planes ──
  // Per-cell band coverage (does each footprint cell carry a return near the very
  // bottom / top of the extent?) — kept as a corroborating signal.
  const band = PLANE_BAND * exV;
  const floorHi = minV + band;
  const ceilLo = maxV - band;
  // Walk cells by (r, c) so each cell knows whether it sits on the footprint
  // EDGE — a real ceiling is a horizontal surface over the room, so its returns
  // land on INTERIOR cells too, while wall tops reach the top band only on
  // perimeter cells. Counting interior ceiling cells separately lets the
  // ceiling test reject wall mass (a 360 scan of an open-top space otherwise
  // "detects" a ceiling that is not there — v0.4.5 vertical-axis bug).
  let floorCells = 0, ceilCells = 0, interiorOcc = 0, ceilInteriorCells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!occ[idx]) continue;
      if (zMin[idx] <= floorHi) floorCells++;
      const hitsCeil = zMax[idx] >= ceilLo;
      if (hitsCeil) ceilCells++;
      const edge =
        c === 0 || c === cols - 1 || r === 0 || r === rows - 1 ||
        !occ[idx - 1] || !occ[idx + 1] ||
        (r > 0 && !occ[idx - cols]) || (r < rows - 1 && !occ[idx + cols]);
      if (!edge) {
        interiorOcc++;
        if (hitsCeil) ceilInteriorCells++;
      }
    }
  }
  const floorCoverage = occupied > 0 ? floorCells / occupied : 0;
  const ceilCoverage = occupied > 0 ? ceilCells / occupied : 0;

  // Density-weighted peaks: the dominant low-band and high-band histogram peaks.
  // A peak is "strong" when it carries a meaningful share of the total mass,
  // so a sparsely-captured (partial) ceiling or a clutter-occluded floor — which
  // a raw coverage test can miss — is still found by the mass it concentrates.
  const PEAK_MASS_FRACTION = 0.04; // ≥4% of points in one ~1/64-extent bin
  const floorPeak = peakBin(0, 0.45);
  const ceilPeak = peakBin(0.55, 1);
  const massThresh = PEAK_MASS_FRACTION * m;
  const floorPeakStrong = exV > 0 && floorPeak.count >= massThresh;
  const ceilPeakStrong = exV > 0 && ceilPeak.count >= massThresh && ceilPeak.bin > floorPeak.bin;

  // Floor present when EITHER a strong low peak OR good band coverage says so.
  const floorPresent = exV > 0 && (floorPeakStrong || floorCoverage >= PLANE_COVER);
  // Interior-cell evidence gate for the ceiling: when the footprint has interior
  // cells at all, require that a meaningful share of them carry a top-band
  // return. Wall tops alone (perimeter-only top-band mass) must never read as a
  // ceiling. Degenerate grids with no interior cells skip the gate rather than
  // false-negative a tiny room.
  const ceilInteriorOk =
    interiorOcc === 0 || ceilInteriorCells >= Math.max(2, 0.05 * interiorOcc);
  // Ceiling present (requires a floor) when EITHER a strong, separated high peak
  // OR good band coverage says so — AND the interior-cell evidence holds.
  const ceilingPresent =
    exV > 0 && floorPresent && ceilInteriorOk && (ceilPeakStrong || ceilCoverage >= PLANE_COVER);

  // ── Ceiling height from the density-weighted floor / ceiling peaks ──
  let ceilingHeightM: number | null = null;
  if (ceilingPresent) {
    const floorLevel = peakLevel(0, 0.45);
    const ceilingLevel = peakLevel(0.55, 1);
    const h = ceilingLevel - floorLevel;
    if (h > 0) ceilingHeightM = h;
  }

  // ── Walls: perimeter footprint cells whose returns span most of the height ──
  let perim = 0, wallCells = 0;
  const sideCount = [0, 0, 0, 0]; // left(-h1), right(+h1), front(-h2), back(+h2)
  const wallSpan = 0.6 * exV;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!occ[idx]) continue;
      const edge =
        c === 0 || c === cols - 1 || r === 0 || r === rows - 1 ||
        !occ[idx - 1] || !occ[idx + 1] ||
        (r > 0 && !occ[idx - cols]) || (r < rows - 1 && !occ[idx + cols]);
      if (!edge) continue;
      perim++;
      if (exV > 0 && zMax[idx] - zMin[idx] >= wallSpan) {
        wallCells++;
        const dl = c, dr = cols - 1 - c, df = r, db = rows - 1 - r;
        const mn = Math.min(dl, dr, df, db);
        if (mn === dl) sideCount[0]++;
        else if (mn === dr) sideCount[1]++;
        else if (mn === df) sideCount[2]++;
        else sideCount[3]++;
      }
    }
  }
  const wallCoveragePct = perim > 0 ? (100 * wallCells) / perim : 0;
  let dominantWallDirections = 0;
  if (wallCells > 0) {
    const sideThresh = Math.max(2, 0.1 * wallCells);
    for (const s of sideCount) if (s >= sideThresh) dominantWallDirections++;
  }

  // ── Storey / level count ──
  // Multi-storey claims are gated on a detected ceiling: without any top
  // surface the histogram peaks are wall / clutter mass, and the live v0.4.4
  // bug showed an open-top space reporting 3 storeys. One floor ⇒ one storey,
  // never more, until a ceiling is actually captured.
  const rawStoreys = countStoreys(hist, binW, minV, m);
  const storyCount =
    spaceKind === 'interior' && !ceilingPresent ? Math.min(rawStoreys, 1) : rawStoreys;

  // ── Enclosed volume (envelope) ──
  // GATED on a detected ceiling for interiors: "floor area × ceiling height"
  // is only honest when a ceiling exists. The old OBB-envelope fallback printed
  // a confident m³ figure on the same panel that said "ceiling not detected"
  // (live v0.4.4 bug: 1,750 m³ on an open-top space) — interiors now report
  // null instead, matching the reason string below. Objects keep the envelope
  // fallback, which their reason string has always described as an envelope.
  let enclosedVolumeM3: number | null;
  if (ceilingHeightM != null) {
    enclosedVolumeM3 = floorAreaM2 * ceilingHeightM;
  } else if (spaceKind === 'object') {
    // Open object: fall back to the OBB envelope volume (in metres).
    const om = objectMetrics(u2m === 1 ? positions : scaleCopy(positions, u2m), { maxSamples });
    enclosedVolumeM3 = om.envelopeVolumeM3 > 0 ? om.envelopeVolumeM3 : dims.lengthM * dims.widthM * dims.heightM;
  } else {
    enclosedVolumeM3 = null;
  }

  // ── Capture quality ──
  // Density must describe the SCAN, not the sample: the gather + the local
  // stride both subsample uniformly, so the source-to-sample count ratio is
  // exactly the combined stride and scales the density back honestly. (The
  // pre-v0.4.5 `m / floorAreaM2` under-reported a stride-100 scan 100×.)
  // Guarded ≥ 1 so a caller passing a stale/smaller sourcePointCount can
  // never silently SHRINK the measured density.
  const sampleScale = sourcePointCount > m ? sourcePointCount / m : 1;
  const densityPerM2 = floorAreaM2 > 0 ? (m * sampleScale) / floorAreaM2 : 0;
  const meanSpacingM = densityPerM2 > 0 ? Math.sqrt(1 / densityPerM2) : 0;
  const quality: CaptureQuality = {
    sampledPointCount: m, sourcePointCount, densityPerM2, meanSpacingM, coveragePct, hasRgb,
  };
  if (sampleScale > 1) {
    reasons.push(
      `Density and spacing are scaled from a ${m.toLocaleString()}-point sample to the full ` +
        `${sourcePointCount.toLocaleString()}-point scan (uniform-stride assumption).`,
    );
  }

  if (spaceKind === 'interior') {
    if (ceilingPresent) {
      reasons.push('Ceilings are often sparsely captured — ceiling height and enclosed volume are approximate.');
    } else {
      reasons.push('No clear ceiling captured yet — height and volume are unavailable until the top surface is scanned.');
    }
    reasons.push('Wall and plane figures are pragmatic estimates, not a certified survey.');
  } else {
    reasons.push('Open object — enclosed volume is a bounding-box envelope, not a solid measurement.');
  }

  return {
    spaceKind, up, dims, floorAreaM2, ceilingHeightM, enclosedVolumeM3,
    planes: {
      floorPresent,
      floorAreaM2: floorPresent ? floorCells * cellArea : null,
      ceilingPresent,
      ceilingAreaM2: ceilingPresent ? ceilCells * cellArea : null,
      wallCoveragePct, dominantWallDirections,
    },
    storyCount, quality, reasons,
  };
}

/** Copy positions scaled by `s` (only used when a unit conversion is needed). */
function scaleCopy(positions: Float32Array | ReadonlyArray<number>, s: number): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = positions[i] * s;
  return out;
}
