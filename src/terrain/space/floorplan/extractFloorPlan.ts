/**
 * extractFloorPlan.ts
 *
 * The floor-plan extraction PIPELINE for an interior scan — the v0.4.5
 * rewrite of the old density-silhouette sketch. The old generator traced a
 * single blob around a coarse (≤48-cell) full-cloud occupancy grid and drew
 * fabricated bbox-edge "wall" lines; on real scans it produced an
 * unrecognisable blob (the user's verdict: "totally not realistic"). The
 * pipeline replacing it:
 *
 *   1. {@link wallSlice}    — clip to the dense footprint (360 noise arms /
 *                             stray outliers excluded), then cut the points
 *                             0.7–1.8 m above the floor anchor (walls only;
 *                             floor / furniture / ceiling cut). The anchor is
 *                             the detected floor peak, else a robust low
 *                             percentile of the elevations; a widened band is
 *                             retried before the full-height fallback;
 *   2. {@link buildOccupancyMask} + {@link closeMask}
 *                           — adaptive 2–5 cm density-thresholded wall mask
 *                             (the cell GROWS, to ≤ 0.3 m, when the slice is
 *                             too sparse to support 5 cm cells — a strided
 *                             gather over a large scan stays traceable),
 *                             morphologically closed so scan dropouts heal
 *                             while doorways (≥ keepOpenM) stay open;
 *   3. {@link traceMaskBoundaries} → {@link simplifyRing} →
 *      {@link snapRingToAxes}
 *                           — vector wall outlines, simplified and (only
 *                             when the direction histogram is bimodal at
 *                             ~90°) snapped to the two dominant axes;
 *   4. realism passes ({@link classifyIslands}, {@link normalizeWallThickness},
 *      {@link mergeAxisJogs}, {@link removeSpikes}, {@link classifyWallGaps})
 *                           — compact off-wall islands (furniture caught by
 *                             the band) are lifted out of the poché into
 *                             light "contents" hints (convex hull per blob),
 *                             echo-fattened wall mass collapses onto its
 *                             centerline at the measured median thickness
 *                             (the promoted v0.4.6 pass — clean walls
 *                             round-trip unchanged), stair-step jogs are
 *                             merged into single wall lines, sub-0.25 m
 *                             spurs and tracing slivers are removed, and
 *                             wall gaps are classified door-vs-unknown by
 *                             jamb evidence (unknown gaps render dashed).
 *                             Door jambs survive every pass by construction.
 *
 * The model also carries the SCANNED-FLOOR region (for the light interior
 * fill — honest captured extent, not a synthetic room polygon) and a floor
 * area derived from the floor mask.
 *
 * HONESTY: walls come from where points actually landed. Unscanned wall
 * runs stay missing; openings are gaps in the data, which may be doorways
 * or simply unscanned. The artifact renderers state this. Suitable for
 * orientation / layout reference — never construction, survey, or legal use.
 *
 * Pure data, deterministic. No DOM, no pdf-lib.
 */

import type { Axis } from '../../scanShape';
import { wallSlice, type FloorBasis } from './wallSlice';
import {
  buildOccupancyMask,
  closeMask,
  closeRadiusCells,
  maskAreaM2,
  type OccupancyGrid,
} from './occupancyGrid';
import {
  traceMaskBoundaries,
  simplifyRing,
  snapRingToAxes,
  resolveSnapAxes,
  SNAP_MODE,
  ringSignedArea,
  type Ring,
} from './vectorize';
import {
  classifyIslands,
  convexHullRing,
  mergeAxisJogs,
  removeSpikes,
  ringMeanThicknessM,
  MIN_SPUR_M,
  SLIVER_THICKNESS_CELL_FRAC,
} from './regularize';
import { normalizeWallThickness, classifyWallGaps, type PlanGap } from './centerline';

export type { PlanGap } from './centerline';

/** A closed plan ring, metres in the floor plane (h1 east, h2 north). */
export type PlanRing = Ring;

export interface FloorPlanModel {
  /**
   * Wall outlines as closed rings (outer CCW, holes CW) — render all rings
   * as ONE nonzero-winding fill for architectural poché (solid walls).
   */
  readonly wallRings: ReadonlyArray<PlanRing>;
  /** Scanned-floor region ring(s) for the light interior fill (may be empty). */
  readonly floorRings: ReadonlyArray<PlanRing>;
  /**
   * Furniture / room-contents islands lifted out of the wall mask — compact
   * blobs at wall height that are not part of the wall network. Rendered as
   * light hints (architectural convention), never as wall poché.
   */
  readonly contentRings: ReadonlyArray<PlanRing>;
  /** How many contents islands were lifted out of the walls. */
  readonly contentsCount: number;
  /**
   * Classified wall gaps (centerline.ts jamb-evidence pass): 'door' gaps have
   * square flanking wall ends and stay genuine openings on the sheet;
   * 'unknown' gaps (ragged / non-door width) are rendered as dashed lines —
   * unscanned or unclassifiable, never claimed as doors.
   */
  readonly doorways: ReadonlyArray<PlanGap>;
  readonly unknownGaps: ReadonlyArray<PlanGap>;
  /**
   * Per-ring OBSERVED fraction, aligned 1:1 with {@link wallRings}: how much
   * of each ring's outline is backed by raw (pre-close) wall returns, sampled
   * against the density-thresholded mask BEFORE morphological closing. Rings
   * below {@link OBSERVED_FRAC_MIN} were mostly interpolated by gap-closing
   * from sparse evidence — the sheet tints them and says so. Coarse by
   * design: a boundary-sample statistic, not a survey confidence figure.
   */
  readonly wallRingObservedFrac: ReadonlyArray<number>;
  /** Measured median wall thickness (m) from the centerline pass; null when
   * the pass could not run (no walls). */
  readonly wallThicknessM: number | null;
  /** True when the centerline pass actually removed echo/clutter wall mass. */
  readonly thicknessNormalized: boolean;
  /** Overall extents of the wall geometry, metres. */
  readonly widthM: number;
  readonly depthM: number;
  /** Bounding box of the plan [minX, minY, maxX, maxY], metres. */
  readonly bbox: readonly [number, number, number, number];
  /** Wall-mask cell size, metres. */
  readonly cellSizeM: number;
  /** Scanned floor area (m²) from the floor mask — null when no floor. */
  readonly floorAreaM2: number | null;
  /** True when a floor-anchored wall band was used (false = full-height fallback). */
  readonly usedWallBand: boolean;
  /**
   * How the band's floor anchor was found: 'histogram' = real floor plane
   * (also enables the floor fill), 'percentile' = lowest dense returns
   * (band anchor only — no floor fill claimed), 'none' = full-height fallback.
   */
  readonly floorBasis: FloorBasis;
  /** Stray returns excluded by the dense-footprint clip (noise arms etc.). */
  readonly clippedCount: number;
  /**
   * The dense-footprint clip bbox [minX, minY, maxX, maxY] (metres) the
   * slice applied — null when no clip fired. The Space panel's dimensions
   * are measured against the SAME clip, so sheet and panel agree.
   */
  readonly clipBbox: readonly [number, number, number, number] | null;
  /** True when wall segments were snapped to two dominant perpendicular axes. */
  readonly snappedToAxes: boolean;
  /** Honest basis / caveat strings (rendered on the artifacts). */
  readonly reasons: readonly string[];
}

export interface FloorPlanParams {
  /** Detected up axis (from classifyScanShape). */
  readonly upAxis: Axis;
  /** Scale from source units to metres (default 1 — assume metres). */
  readonly unitToMetres?: number;
  /** Max points to sample. Default 300 000 (the wallSlice default). */
  readonly maxSamples?: number;
  /** Wall band bottom / top, metres above the floor. Defaults 0.7 / 1.8. */
  readonly bandLowM?: number;
  readonly bandHighM?: number;
  /** Openings at least this wide are never sealed by closing. Default 0.6 m. */
  readonly keepOpenM?: number;
  /** Minimum points for any extraction at all. Default 500. */
  readonly minPoints?: number;
}

const SUITABILITY_NOTE =
  'Derived from the point cloud — suitable for orientation and layout reference, not for construction, survey, or legal use.';
const OPENINGS_NOTE =
  'Wall gaps are where the scan has no wall returns — doorways or unscanned runs; gaps wider than the door-keep threshold are never bridged.';

/** Simplification tolerance in cells — recovers straight runs from the raster. */
const SIMPLIFY_CELLS = 1.25;
/** Rings smaller than this many cell-areas are speckle and dropped. */
const MIN_RING_CELL_AREAS = 9;
/** Floor-fill mask is coarser than the wall mask (presence, not density). */
const FLOOR_CELL_MIN_M = 0.05;
const FLOOR_CELL_MAX_M = 0.2;

// ── Emitted-geometry budgets (the "opening the floorplan SVG makes the
// computer slow" fix). The raster trace is unbounded: a dense patchy floor
// mask can emit HUNDREDS of decorative hole subpaths and the wall mask can
// reach 1024² cells, so a large noisy scan once shipped an SVG/PDF whose
// renderer cost scaled with the scan, not the sheet. Walls carry the plan and
// get most of the budget; the floor fill and contents hints are decorative
// context and are coarsened/dropped first. ──
/** The decorative floor fill simplifies far more aggressively than walls. */
const FLOOR_SIMPLIFY_CELLS = 2.5;
/** The floor fill keeps at most this many (largest) outer regions. */
const FLOOR_MAX_RINGS = 24;
/** Per-layer vertex budgets. */
export const WALL_VERTEX_BUDGET = 3500;
export const FLOOR_VERTEX_BUDGET = 1000;
export const CONTENTS_VERTEX_BUDGET = 500;
/** Total emitted-vertex budget across all plan ring layers. */
export const PLAN_VERTEX_BUDGET =
  WALL_VERTEX_BUDGET + FLOOR_VERTEX_BUDGET + CONTENTS_VERTEX_BUDGET;
/** At most this many dashed unknown-gap segments are emitted. */
export const MAX_UNKNOWN_GAPS = 32;

/** Total vertex count across a set of rings. */
export const ringVertexCount = (rings: ReadonlyArray<Ring>): number =>
  rings.reduce((acc, r) => acc + r.length, 0);

/**
 * Wall rings whose outline is observed below this fraction render as
 * "interpolated from sparse evidence" (yellow-tinted poché + footer note).
 */
export const OBSERVED_FRAC_MIN = 0.6;

/**
 * Fraction of a ring's outline backed by RAW (pre-close) wall returns:
 * sample the ring's edges at ~1 cell spacing and test each sample's 3×3 cell
 * neighbourhood against the pre-close mask. The 1-cell neighbourhood absorbs
 * boundary/snap jitter (a traced outline rides the cell edges of the CLOSED
 * mask), while cells deep inside a morphologically closed bridge stay ≥ 2
 * cells from any raw return and honestly read unobserved. Cheap (O(outline
 * length)), coarse, and deterministic.
 */
export function ringObservedFraction(ring: Ring, raw: OccupancyGrid): number {
  const { mask, cols, rows, cellX, cellY, originX, originY } = raw;
  const stepM = Math.max(cellX, cellY);
  if (!(stepM > 0) || ring.length < 2) return 0;
  const cellSet = (c: number, r: number): boolean =>
    c >= 0 && c < cols && r >= 0 && r < rows && mask[r * cols + c] === 1;
  let total = 0;
  let observed = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(len / stepM));
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const c = Math.floor((x1 + (x2 - x1) * t - originX) / cellX);
      const r = Math.floor((y1 + (y2 - y1) * t - originY) / cellY);
      total++;
      let hit = false;
      for (let dr = -1; dr <= 1 && !hit; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (cellSet(c + dc, r + dr)) { hit = true; break; }
        }
      }
      if (hit) observed++;
    }
  }
  return total > 0 ? observed / total : 0;
}

/**
 * Enforce a vertex budget over a ring set: keep the LARGEST rings first, then
 * progressively coarsen with Douglas-Peucker (tolerance scaled by how far
 * over budget the set is — proportional tightening), then drop the smallest
 * rings, and as a last resort uniformly decimate. DP only ever REMOVES
 * vertices from the raster trace, so nothing is fabricated — the cap trades
 * decorative fidelity for a bounded renderer cost.
 */
export function capRingVertices(
  rings: ReadonlyArray<Ring>,
  cellM: number,
  budget: number,
): Ring[] {
  let out = [...rings];
  if (ringVertexCount(out) <= budget) return out;
  out.sort((a, b) => Math.abs(ringSignedArea(b)) - Math.abs(ringSignedArea(a)));
  let eps = SIMPLIFY_CELLS * Math.max(cellM, 1e-6) * Math.max(1.5, ringVertexCount(out) / budget);
  for (let pass = 0; pass < 4 && ringVertexCount(out) > budget; pass++) {
    out = out.map((r) => simplifyRing(r, eps)).filter((r) => r.length >= 3);
    eps *= 2;
  }
  while (ringVertexCount(out) > budget && out.length > 1) out.pop();
  if (ringVertexCount(out) > budget && out.length === 1) {
    const ring = out[0];
    const step = Math.ceil(ring.length / Math.max(3, budget));
    out = [ring.filter((_, i) => i % step === 0)];
  }
  return out;
}

/**
 * Merge near-duplicate dashed gaps (midpoints within ~2 cells read as the
 * same opening traced twice) and keep at most {@link MAX_UNKNOWN_GAPS},
 * widest first — the dashed hints are honesty annotations, not geometry, and
 * a noisy multi-room scan can classify hundreds of them.
 */
export function limitUnknownGaps(gaps: ReadonlyArray<PlanGap>, cellM: number): PlanGap[] {
  const sorted = [...gaps].sort((a, b) => b.widthM - a.widthM);
  const out: PlanGap[] = [];
  const tol = Math.max(2 * cellM, 0.05);
  for (const g of sorted) {
    if (out.length >= MAX_UNKNOWN_GAPS) break;
    const mx = (g.a[0] + g.b[0]) / 2;
    const my = (g.a[1] + g.b[1]) / 2;
    const dup = out.some((h) => {
      const hx = (h.a[0] + h.b[0]) / 2;
      const hy = (h.a[1] + h.b[1]) / 2;
      return Math.hypot(mx - hx, my - hy) <= tol;
    });
    if (!dup) out.push(g);
  }
  return out;
}

const emptyModel = (reasons: string[]): FloorPlanModel => ({
  wallRings: [],
  wallRingObservedFrac: [],
  floorRings: [],
  contentRings: [],
  contentsCount: 0,
  doorways: [],
  unknownGaps: [],
  wallThicknessM: null,
  thicknessNormalized: false,
  widthM: 0,
  depthM: 0,
  bbox: [0, 0, 0, 0],
  cellSizeM: 0,
  floorAreaM2: null,
  usedWallBand: false,
  floorBasis: 'none',
  clippedCount: 0,
  clipBbox: null,
  snappedToAxes: false,
  reasons,
});

/**
 * Trace + simplify (+ optionally snap, + optionally regularize) one mask
 * into rings, dropping speckle. Regularization (jog merge along the snap
 * axes, spur removal, sliver filter) only runs when requested — the wall
 * mask gets it, the floor / contents masks do not.
 */
function vectorise(
  grid: OccupancyGrid,
  snapTheta: number | null,
  regularize = false,
  simplifyCells = SIMPLIFY_CELLS,
): Ring[] {
  const cell = Math.max(grid.cellX, grid.cellY);
  const minArea = MIN_RING_CELL_AREAS * grid.cellX * grid.cellY;
  const minThickness = SLIVER_THICKNESS_CELL_FRAC * cell;
  const out: Ring[] = [];
  for (const raw of traceMaskBoundaries(grid)) {
    if (Math.abs(ringSignedArea(raw)) < minArea) continue;
    let ring = simplifyRing(raw, simplifyCells * cell);
    if (snapTheta != null) ring = snapRingToAxes(ring, snapTheta);
    if (regularize) {
      // Jogs of up to ~one cell are raster stair-steps, not separate walls.
      if (snapTheta != null) ring = mergeAxisJogs(ring, snapTheta, 1.05 * cell);
      ring = removeSpikes(ring, MIN_SPUR_M);
      if (snapTheta != null) ring = mergeAxisJogs(ring, snapTheta, 1.05 * cell);
      if (Math.abs(ringSignedArea(ring)) < minArea) continue;
      if (ringMeanThicknessM(ring) < minThickness) continue; // tracing sliver
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/**
 * Run the full pipeline. Degenerate input (< minPoints) returns an honest
 * empty model rather than a fabricated outline.
 */
export function extractFloorPlan(
  positions: Float32Array | ReadonlyArray<number>,
  params: FloorPlanParams,
): FloorPlanModel {
  const minPoints = Math.max(16, Math.floor(params.minPoints ?? 500));
  const keepOpenM = Math.max(0.1, params.keepOpenM ?? 0.6);
  const n = Math.floor(positions.length / 3);
  if (n < minPoints) {
    return emptyModel([
      `Too few points (${n.toLocaleString()} < ${minPoints.toLocaleString()}) to trace walls — no plan extracted.`,
      SUITABILITY_NOTE,
    ]);
  }

  // ── 1. Wall-height slice ──
  const slice = wallSlice(positions, {
    upAxis: params.upAxis,
    unitToMetres: params.unitToMetres,
    maxSamples: params.maxSamples,
    bandLowM: params.bandLowM,
    bandHighM: params.bandHighM,
  });
  if (slice.count < 64) {
    return emptyModel(['No wall-height structure found in the scan.', SUITABILITY_NOTE]);
  }

  // ── 2. Density-thresholded wall mask + gap closing ──
  const rawGrid = buildOccupancyMask(slice.xs, slice.ys, slice.count);
  if (!rawGrid) {
    return emptyModel(['Wall slice too sparse or degenerate to rasterise.', SUITABILITY_NOTE]);
  }
  const cell = Math.max(rawGrid.cellX, rawGrid.cellY);
  const closedGrid = closeMask(rawGrid, closeRadiusCells(cell, keepOpenM));

  // ── 3. Island classification: furniture out of the poché ──
  const islands = classifyIslands(closedGrid);

  // ── 3.6. Centerline pass (centerline.ts): wall-thickness normalisation.
  //         Echo-fattened runs (a wall scanned from both sides, clutter fused
  //         against a wall) collapse onto their centerline at the measured
  //         median thickness; clean walls round-trip unchanged (the pass only
  //         removes EXCESS mass — its output is a subset of its input).
  //         Free-standing fat masses (kitchen islands…) demote to contents. ──
  const norm = normalizeWallThickness(islands.walls);
  const wallGrid = norm.walls;
  const removedM2 = norm.removedCells * wallGrid.cellX * wallGrid.cellY;
  const thicknessNormalized = removedM2 > 0.05;
  let contentsGrid = islands.contents;
  let contentsCount = islands.contentsCount;
  if (norm.demoted) {
    if (contentsGrid) {
      const merged = contentsGrid.mask.slice();
      for (let i = 0; i < merged.length; i++) if (norm.demoted.mask[i]) merged[i] = 1;
      contentsGrid = { ...contentsGrid, mask: merged };
    } else {
      contentsGrid = norm.demoted;
    }
    contentsCount += norm.demotedCount;
  }

  // ── 4. Vectorise (axis snap only when the histogram is truly bimodal),
  //       then regularize (jog merge / spur kill / sliver filter) ──
  const unsnapped = vectorise(wallGrid, null);
  const snap = resolveSnapAxes(unsnapped, SNAP_MODE);
  const axes = snap.axes;
  const wallRingsRaw = axes
    ? vectorise(wallGrid, axes.thetaRad, true)
    : vectorise(wallGrid, null, true);
  if (wallRingsRaw.length === 0) {
    return emptyModel(['No coherent wall outline could be traced.', SUITABILITY_NOTE]);
  }
  // Vertex budget: walls carry the plan, so the cap is generous and only a
  // pathologically noisy mask ever trips it (proportional DP tightening).
  const wallRings = capRingVertices(wallRingsRaw, cell, WALL_VERTEX_BUDGET);
  // Per-ring observed fraction against the PRE-CLOSE mask: how much of each
  // final outline is backed by raw returns vs interpolated by gap-closing.
  const wallRingObservedFrac = wallRings.map((r) => ringObservedFraction(r, rawGrid));

  // Contents hints: convex hull per blob (outer rings only — a furniture
  // hint needs no holes). The raw raster outline of a blob is ragged noise;
  // its hull is the honest "something stands here, about this big" footprint.
  const contentRings = contentsGrid
    ? capRingVertices(
        vectorise(contentsGrid, null)
          .filter((r) => ringSignedArea(r) > 0)
          .map(convexHullRing),
        cell,
        CONTENTS_VERTEX_BUDGET,
      )
    : [];

  // ── 4.5. Door-vs-data-gap classification (jamb evidence, centerline.ts):
  //         square flanking wall ends across a door-width gap = doorway
  //         (stays a genuine opening); ragged / non-door-width facing ends =
  //         unknown gap, rendered dashed. The dashed set is deduped + capped
  //         (MAX_UNKNOWN_GAPS) — the footer reports the FULL classified
  //         count, the sheet draws a bounded number of hints. ──
  const gaps = classifyWallGaps(wallGrid, norm.skeleton, norm.distances);
  const doorways = gaps.filter((g) => g.kind === 'door');
  const unknownGapsAll = gaps.filter((g) => g.kind === 'unknown');
  const unknownGaps = limitUnknownGaps(unknownGapsAll, cell);

  // ── Scanned-floor interior fill + floor area (presence mask, coarser) ──
  // The fill is DECORATIVE context: holes (furniture occlusion shadows,
  // unhealed pinholes) are dropped — a real 360 house scan once traced 200+
  // hole subpaths into the sheet — only the largest outer regions are kept,
  // the DP tolerance is coarser than the walls', and the layer is capped at
  // FLOOR_VERTEX_BUDGET. The floor AREA is measured on the raw presence mask
  // BEFORE closing/simplification, so the printed figure describes scanned
  // floor, not the simplified decoration.
  let floorRings: Ring[] = [];
  let floorAreaM2: number | null = null;
  if (slice.floorCount >= 64) {
    const floorGrid = buildOccupancyMask(slice.floorXs, slice.floorYs, slice.floorCount, {
      cellMinM: FLOOR_CELL_MIN_M,
      cellMaxM: FLOOR_CELL_MAX_M,
      // Presence, not density: the floor is one return thick, so any return
      // marks the cell scanned. The area figure must count those cells.
      minCellCount: 1,
      thresholdFrac: 0,
    });
    if (floorGrid) {
      floorAreaM2 = maskAreaM2(floorGrid);
      // Close 1 cell to heal pinholes in the fill, but measure area BEFORE
      // closing — the area must describe scanned floor, not healed floor.
      const closed = closeMask(floorGrid, 1);
      const floorCell = Math.max(floorGrid.cellX, floorGrid.cellY);
      floorRings = capRingVertices(
        vectorise(closed, null, false, FLOOR_SIMPLIFY_CELLS)
          .filter((r) => ringSignedArea(r) > 0)
          .sort((a, b) => ringSignedArea(b) - ringSignedArea(a))
          .slice(0, FLOOR_MAX_RINGS),
        floorCell,
        FLOOR_VERTEX_BUDGET,
      );
    }
  }

  // ── Extents from the wall geometry ──
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of wallRings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const reasons: string[] = [];
  // Basis line: the band offsets ACTUALLY used (the widened retry shows its
  // real numbers), and an honest distinction between a detected floor plane
  // and a percentile-estimated anchor.
  reasons.push(
    slice.usedWallBand
      ? slice.floorBasis === 'histogram'
        ? `Walls traced from the point slice ${slice.bandLowUsedM.toFixed(1)}–${slice.bandHighUsedM.toFixed(1)} m above the detected floor.`
        : `No dominant floor plane — floor level estimated from the lowest dense returns; walls traced from the ${slice.bandLowUsedM.toFixed(1)}–${slice.bandHighUsedM.toFixed(1)} m slice above it.`
      : 'No floor-anchored wall band could be cut — walls traced from the full-height point density instead.',
  );
  if (slice.clippedCount > 0) {
    reasons.push(
      `${slice.clippedCount.toLocaleString()} stray return(s) outside the dense footprint were excluded as outliers.`,
    );
  }
  reasons.push(
    snap.mode === 'off'
      ? 'Axis snapping disabled (SNAP_MODE off) — wall directions left exactly as traced.'
      : snap.forced && axes
        ? 'Wall directions FORCED onto the strongest axis pair (SNAP_MODE strong) — the auto bimodal gates did not pass, so right angles may be assumed where the scan shows none.'
        : axes
          ? 'Wall directions snapped to the two dominant perpendicular axes (within ±7°).'
          : 'Wall directions left as traced — no two dominant perpendicular directions found, so no right angles were assumed.',
  );
  if (thicknessNormalized) {
    reasons.push(
      `Echo-fattened wall mass (a wall scanned from both sides reads double) was collapsed onto its centerline at the measured ~${norm.medianThicknessM.toFixed(2)} m wall thickness (${removedM2.toFixed(1)} m² removed).`,
    );
  }
  if (norm.demotedCount > 0) {
    reasons.push(
      `${norm.demotedCount} free-standing mass(es) far thicker than the building's walls (likely large furniture) were demoted from the wall poché to contents hints.`,
    );
  }
  if (contentsCount > 0) {
    reasons.push(
      `${contentsCount} compact island(s) at wall height (likely furniture or room contents, not walls) were lifted out of the wall poché and drawn as light grey hints (simplified to their convex outline).`,
    );
  }
  if (doorways.length > 0 || unknownGapsAll.length > 0) {
    reasons.push(
      `Of the wall gaps, ${doorways.length} show squared jamb evidence on both sides and read as doorways (left open); ${unknownGapsAll.length} other facing gap(s) lack that evidence — unscanned or unclassifiable, drawn as dashed lines` +
        (unknownGaps.length < unknownGapsAll.length
          ? ` (the ${unknownGaps.length} widest are shown).`
          : '.'),
    );
  }
  reasons.push(OPENINGS_NOTE, SUITABILITY_NOTE);

  return {
    wallRings,
    wallRingObservedFrac,
    floorRings,
    contentRings,
    contentsCount,
    doorways,
    unknownGaps,
    wallThicknessM: norm.medianThicknessM,
    thicknessNormalized,
    widthM: Math.max(0, maxX - minX),
    depthM: Math.max(0, maxY - minY),
    bbox: [minX, minY, maxX, maxY],
    cellSizeM: cell,
    floorAreaM2,
    usedWallBand: slice.usedWallBand,
    floorBasis: slice.floorBasis,
    clippedCount: slice.clippedCount,
    clipBbox: slice.clipBbox,
    snappedToAxes: axes != null,
    reasons,
  };
}
