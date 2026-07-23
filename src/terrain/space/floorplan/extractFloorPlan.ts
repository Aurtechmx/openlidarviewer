/**
 * extractFloorPlan.ts
 *
 * The floor-plan extraction PIPELINE for an interior scan — the v0.4.5
 * rewrite of the old density-silhouette sketch. The old generator traced a
 * single blob around a coarse (≤48-cell) full-cloud occupancy grid and drew
 * fabricated bbox-edge "wall" lines; on real scans it produced an
 * unrecognisable blob (an unrecognizable floor-plan geometry). The
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
 *                             Door jambs survive every pass by construction;
 *   5. wall graph + rooms ({@link buildWallGraph}, {@link extrudeWallGraph},
 *      {@link detectRooms} — the v0.4.6 hardening)
 *                           — the pruned skeleton becomes an explicit
 *                             {nodes, edges} graph (per-edge measured
 *                             thickness + observed fraction, straightened
 *                             centerlines); the wall mask is RE-EXTRUDED from
 *                             the graph (constant thickness per run, corner
 *                             joins at junctions), and rooms are segmented by
 *                             flood fill bounded by those walls + closed
 *                             doorway spans (door-separated rooms stay
 *                             distinct; unknown gaps never seal — an
 *                             unscanned divider merges its regions).
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
import { wallSlice, type FloorBasis, type BandBasis } from './wallSlice';
import {
  buildOccupancyMask,
  buildCellHeightProfile,
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
  type SnapMode,
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
import { buildWallGraph, extrudeWallGraph } from './wallGraph';
import { detectRooms, type RoomRegion, type RoomSegmentation } from './roomDetect';

export type { PlanGap } from './centerline';
export type { RoomRegion, RoomSegmentation } from './roomDetect';

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
   * Rooms segmented by flood fill bounded by the wall-graph walls plus the
   * classified doorways' closed spans (roomDetect.ts). Door-separated rooms
   * stay distinct; unknown gaps are never closed, so an unscanned divider
   * merges its regions instead of fabricating a wall. Empty when the graph
   * pass did not run or no enclosed region survived.
   */
  readonly rooms: ReadonlyArray<RoomRegion>;
  /**
   * Honest segmentation outcome (roomDetect.ts). 'rooms' — the room schedule
   * is real; 'open-space' — the floor is essentially ONE connected space
   * ({@link openSpaceAreaM2}), not a multi-room partition; 'unsegmented' —
   * rooms could not be reliably separated from the wall returns. The sheet /
   * panel print the schedule ONLY for 'rooms', and the honest line otherwise —
   * never a fabricated "5 rooms" on a floor the scan could not partition.
   */
  readonly roomSegmentation: RoomSegmentation;
  /**
   * The "open space" area, m², when {@link roomSegmentation} is 'open-space'
   * (the single dominant interior region); 0 otherwise. Reported as
   * "Open space · ~N m²" — an honest one-region figure, not a room.
   */
  readonly openSpaceAreaM2: number;
  /**
   * True when the wall poché was re-extruded FROM the centerline wall graph
   * (wallGraph.ts) — one measured thickness per wall run, corner joins at
   * junctions — rather than traced straight off the normalised mask. The
   * sheet may then honestly say "wall-graph reconstruction".
   */
  readonly fromWallGraph: boolean;
  /** Wall-graph size (footer provenance) — 0/0 when the graph did not run. */
  readonly wallGraphNodeCount: number;
  readonly wallGraphEdgeCount: number;
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
  /**
   * Whether the wall slice used the FIXED default band (0.7–1.8 m / the
   * widened retry) or an ADAPTIVE band re-centred on the detected
   * wall-evidence z-peak. 'fixed' when no band was cut (full-height fallback).
   */
  readonly bandBasis: BandBasis;
  /** Wall-band offsets actually used, metres above the floor anchor. */
  readonly bandLowUsedM: number;
  readonly bandHighUsedM: number;
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
  /**
   * Re-centre the wall slice on the detected wall-evidence z-peak (so
   * countertop / industrial scans whose walls sit outside 0.7–1.8 m slice
   * correctly). Default true; the fixed band is kept when no clear peak is
   * found. Set false to pin the fixed {@link bandLowM}–{@link bandHighM} band.
   */
  readonly adaptiveBand?: boolean;
  /**
   * Axis-snapping policy for the wall vectoriser (vectorize.ts SNAP_MODE):
   * 'auto' (default) snaps only when the direction histogram is genuinely
   * bimodal at ~90°; 'off' leaves directions exactly as traced; 'strong'
   * forces the dominant axis pair (right angles may be assumed where the scan
   * shows none — the sheet says so). Defaults to the module {@link SNAP_MODE}.
   */
  readonly snapMode?: SnapMode;
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
/**
 * At most this many (largest) contents/furniture hint blobs are DRAWN. The
 * classifier on a cluttered 360 interior can lift 30–40 compact islands; a
 * sheet stippled with that many tiny grey specks reads as noise, not a layout
 * aid. We keep the N largest by footprint area (the ones a reader can actually
 * make sense of) and drop the speck tail. The footer reports the FULL found
 * count and how many were drawn — same honesty pattern as MAX_UNKNOWN_GAPS.
 */
export const MAX_CONTENTS_HINTS = 12;
/**
 * Contents blobs smaller than this (m²) are dropped entirely before the
 * largest-N cap — below roughly a stool's footprint a grey speck carries no
 * layout information, only clutter.
 */
export const MIN_CONTENTS_HINT_M2 = 0.12;

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
  rooms: [],
  roomSegmentation: 'unsegmented',
  openSpaceAreaM2: 0,
  fromWallGraph: false,
  wallGraphNodeCount: 0,
  wallGraphEdgeCount: 0,
  wallThicknessM: null,
  thicknessNormalized: false,
  widthM: 0,
  depthM: 0,
  bbox: [0, 0, 0, 0],
  cellSizeM: 0,
  floorAreaM2: null,
  usedWallBand: false,
  floorBasis: 'none',
  bandBasis: 'fixed',
  bandLowUsedM: 0,
  bandHighUsedM: 0,
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
    adaptiveBand: params.adaptiveBand,
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
  // Per-cell height profile (z min/max per cell) from the slice's band points,
  // so the classifier can weigh a component's VERTICAL extent: a tall thin
  // column spans the band (→ structure) while a low wide blob fills only a
  // shallow slab (→ furniture). The profile aligns to the same cell layout as
  // the (closed) wall grid; the band span is the reference z-extent.
  const bandSpanM = Math.max(0, slice.bandHighUsedM - slice.bandLowUsedM);
  const hp = buildCellHeightProfile(closedGrid, slice.xs, slice.ys, slice.zs, slice.count);
  const islands = classifyIslands(closedGrid, { zMin: hp.zMin, zMax: hp.zMax, bandSpanM });

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
  const snap = resolveSnapAxes(unsnapped, params.snapMode ?? SNAP_MODE);
  const axes = snap.axes;

  // ── 4.2. Wall graph + re-extrusion (wallGraph.ts, the v0.4.6 hardening):
  //         junctions/endpoints of the pruned skeleton become NODES, the
  //         skeleton paths between them EDGES (straightened, one measured
  //         thickness + observed fraction each), and the wall mask is
  //         re-extruded FROM the graph — consistent thickness per run, clean
  //         corner joins at junctions. Falls back to the normalised mask when
  //         the graph is degenerate (no edges) or its extrusion loses every
  //         traceable ring — the sheet then must NOT claim a graph. ──
  const graph = buildWallGraph(wallGrid, norm.skeleton, {
    snapThetaRad: axes?.thetaRad ?? null,
    raw: rawGrid,
  });
  let fromWallGraph = graph.edges.length > 0;
  let planGrid = fromWallGraph ? extrudeWallGraph(graph, wallGrid) : wallGrid;
  let wallRingsRaw = axes
    ? vectorise(planGrid, axes.thetaRad, true)
    : vectorise(planGrid, null, true);
  if (wallRingsRaw.length === 0 && fromWallGraph) {
    fromWallGraph = false;
    planGrid = wallGrid;
    wallRingsRaw = axes ? vectorise(wallGrid, axes.thetaRad, true) : vectorise(wallGrid, null, true);
  }
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
  // Drop sub-threshold specks, then keep only the MAX_CONTENTS_HINTS largest by
  // footprint area — a sheet stippled with 30+ tiny grey blobs reads as noise,
  // not a layout aid (the footer reports the full found count + how many were
  // drawn). `drawnContentsCount` feeds the honest reason line below.
  const allContentRings = contentsGrid
    ? vectorise(contentsGrid, null)
        .filter((r) => ringSignedArea(r) > 0)
        .map(convexHullRing)
    : [];
  const contentRingsKept = allContentRings
    .map((r) => ({ ring: r, areaM2: Math.abs(ringSignedArea(r)) }))
    .filter((e) => e.areaM2 >= MIN_CONTENTS_HINT_M2)
    .sort((a, b) => b.areaM2 - a.areaM2)
    .slice(0, MAX_CONTENTS_HINTS)
    .map((e) => e.ring);
  const drawnContentsCount = contentRingsKept.length;
  const contentRings = contentsGrid
    ? capRingVertices(contentRingsKept, cell, CONTENTS_VERTEX_BUDGET)
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
  //
  // WHY computed BEFORE room segmentation: the room detector's honesty guard
  // (roomDetect.ts) compares the segmented room area against this scanned
  // floor area — if the "rooms" cover only a sliver of the floor (a leaking
  // open plan), it reports an honest open-space / unsegmented outcome instead
  // of numbering micro-pockets. So the floor area must exist first.
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

  // ── 4.6. Room segmentation (roomDetect.ts): flood fill of the free space
  //         bounded by the plan walls + the classified doorways' closed
  //         spans. Door-separated rooms stay distinct; unknown gaps are
  //         never closed (an unscanned divider merges its regions — no
  //         fabricated wall); a region leaking to the border is exterior.
  //         The scanned floor area is passed so the detector can suppress a
  //         fake room schedule when the segmented rooms cover only a sliver
  //         of the floor (a leaking open plan → 'open-space' / 'unsegmented'). ──
  const roomsDet = detectRooms(planGrid, doorways, floorAreaM2);
  const rooms = roomsDet.rooms;

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
  // The band wording also states when the slice was ADAPTED to the detected
  // wall-evidence peak (vs the standard 0.7–1.8 m band) — an honest note that
  // the slice height was chosen from the data, not assumed.
  const bandAdapted = slice.bandBasis === 'adaptive';
  reasons.push(
    slice.usedWallBand
      ? slice.floorBasis === 'histogram'
        ? `Walls traced from the point slice ${slice.bandLowUsedM.toFixed(1)}–${slice.bandHighUsedM.toFixed(1)} m above the detected floor${bandAdapted ? ' (band re-centred on the densest wall-return height)' : ''}.`
        : `No dominant floor plane — floor level estimated from the lowest dense returns; walls traced from the ${slice.bandLowUsedM.toFixed(1)}–${slice.bandHighUsedM.toFixed(1)} m slice above it${bandAdapted ? ' (band re-centred on the densest wall-return height)' : ''}.`
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
    // Honest found-vs-drawn wording: when the speck filter + largest-N cap
    // dropped some islands, say so rather than implying every island is drawn.
    const undrawn = contentsCount - drawnContentsCount;
    reasons.push(
      undrawn > 0
        ? `${contentsCount} compact island(s) at wall height (likely furniture or room contents, not walls) were lifted out of the wall poché; the ${drawnContentsCount} largest are drawn as light grey hints (simplified to their convex outline), the ${undrawn} smallest omitted to keep the sheet legible.`
        : `${contentsCount} compact island(s) at wall height (likely furniture or room contents, not walls) were lifted out of the wall poché and drawn as light grey hints (simplified to their convex outline).`,
    );
  }
  if (fromWallGraph) {
    reasons.push(
      `Walls reconstructed from the centerline wall graph (${graph.nodes.length} node(s), ${graph.edges.length} edge(s)) — one measured thickness per wall run, corners joined at junctions; no run was added that the skeleton did not trace.`,
    );
  }
  if (rooms.length > 0) {
    reasons.push(
      `${rooms.length} room(s) segmented by flood fill bounded by the walls${roomsDet.closedDoorways > 0 ? ` and ${roomsDet.closedDoorways} closed doorway span(s)` : ''}; unknown gaps are never closed, so an unscanned divider merges its regions instead of fabricating a wall. Room areas are measured on the region mask.`,
    );
  } else if (roomsDet.segmentation === 'open-space') {
    // HONESTY: one connected interior region dominates the floor — present it
    // as a single open space, NOT a numbered room schedule of flood pockets.
    reasons.push(
      `Open-plan interior: the free space floods into one connected region (~${roomsDet.dominantRegionAreaM2.toFixed(0)} m²) — no interior partitions were reliably segmented, so the plan is presented as a single open space rather than numbered rooms.`,
    );
  } else if (roomsDet.segmentation === 'unsegmented') {
    // HONESTY: the flood found only micro-pockets between wall fragments that
    // together cover a sliver of the floor (a leaking open plan). Numbering
    // those as "rooms" would fabricate partitions the scan never saw.
    reasons.push(
      'Rooms could not be reliably segmented from the wall returns — the open floor leaks past unscanned boundary runs, leaving only wall-fragment pockets too small to be rooms. No room schedule is claimed; the wall poché, overall dimensions, and floor area still stand.',
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
    rooms,
    roomSegmentation: roomsDet.segmentation,
    openSpaceAreaM2: roomsDet.segmentation === 'open-space' ? roomsDet.dominantRegionAreaM2 : 0,
    fromWallGraph,
    wallGraphNodeCount: fromWallGraph ? graph.nodes.length : 0,
    wallGraphEdgeCount: fromWallGraph ? graph.edges.length : 0,
    wallThicknessM: norm.medianThicknessM,
    thicknessNormalized,
    widthM: Math.max(0, maxX - minX),
    depthM: Math.max(0, maxY - minY),
    bbox: [minX, minY, maxX, maxY],
    cellSizeM: cell,
    floorAreaM2,
    usedWallBand: slice.usedWallBand,
    floorBasis: slice.floorBasis,
    bandBasis: slice.bandBasis,
    bandLowUsedM: slice.bandLowUsedM,
    bandHighUsedM: slice.bandHighUsedM,
    clippedCount: slice.clippedCount,
    clipBbox: slice.clipBbox,
    snappedToAxes: axes != null,
    reasons,
  };
}
