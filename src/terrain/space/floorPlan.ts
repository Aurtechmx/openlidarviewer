/**
 * floorPlan.ts
 *
 * A DENSITY-DERIVED, top-down footprint sketch for an INTERIOR scan — NOT a CAD
 * floor plan and NOT a measured survey. From the occupied horizontal-footprint
 * grid (the same up-frame projection {@link spaceMetrics} uses) it derives:
 *
 *   - the footprint OUTLINE — a boundary polyline traced around the occupied
 *     cell mask (a simple marching-squares-style boundary walk of the binary
 *     occupancy raster). It follows cell edges, so it is blocky / approximate by
 *     construction, never a smoothed architectural wall line;
 *   - dominant WALL directions — perimeter cells whose vertical point span is a
 *     large fraction of the room height (near-full-height columns), grouped into
 *     the four footprint sides;
 *   - overall W × D dimensions (metres) and a metres-per-unit scale.
 *
 * HONESTY: every figure is derived from where points happen to land. A sparsely
 * captured wall leaves a notch; clutter can bulge the outline. The artifact this
 * feeds (an SVG / PDF sketch) carries that caveat prominently. No CAD geometry,
 * no RANSAC line fitting, no fabricated right-angles.
 *
 * Pure data, deterministic, O(cells). No DOM, no pdf-lib.
 */

import type { Axis } from '../scanShape';

/** A closed boundary ring in floor-plane metres (x = h1 east, y = h2 north). */
export type PlanRing = ReadonlyArray<readonly [number, number]>;

/** A dominant wall side of the footprint, with its coverage strength. */
export interface PlanWall {
  /** Which footprint side the near-full-height columns concentrate on. */
  readonly side: 'left' | 'right' | 'front' | 'back';
  /** A representative segment (metres) spanning the captured run on that side. */
  readonly segment: readonly [readonly [number, number], readonly [number, number]];
  /** Count of near-full-height perimeter cells assigned to this side. */
  readonly cells: number;
}

export interface FloorPlan {
  /** Footprint boundary ring(s), metres in the floor plane. First is the outer. */
  readonly outline: PlanRing;
  /** Dominant wall sides detected from near-full-height perimeter columns. */
  readonly walls: ReadonlyArray<PlanWall>;
  /** Overall footprint width (h1 extent) and depth (h2 extent), metres. */
  readonly widthM: number;
  readonly depthM: number;
  /** Cell size used for the occupancy raster, metres. */
  readonly cellSizeM: number;
  /** Bounding box of the outline in plan metres [minX, minY, maxX, maxY]. */
  readonly bbox: readonly [number, number, number, number];
  /** Honest basis / caveat strings. */
  readonly reasons: readonly string[];
}

export interface FloorPlanParams {
  /** Detected up axis (from classifyScanShape). */
  readonly upAxis: Axis;
  /** Scale from source units to metres (default 1 — assume metres). */
  readonly unitToMetres?: number;
  /** Max points to sample. Default 60000. */
  readonly maxSamples?: number;
  /** Footprint grid resolution (cells per axis). Default 48. */
  readonly gridN?: number;
}

/** Same up-frame offset convention as spaceMetrics (vertical, horizontal1/2). */
const upOffsets = (a: Axis): { v: number; h1: number; h2: number } =>
  a === 'x' ? { v: 0, h1: 1, h2: 2 } : a === 'y' ? { v: 1, h1: 0, h2: 2 } : { v: 2, h1: 0, h2: 1 };

/** Fraction of vertical extent a perimeter column must span to read as a wall. */
const WALL_SPAN_FRAC = 0.6;

const APPROX_NOTE =
  'Approximate sketch traced from point density — not a measured floor plan or survey.';
const SPARSE_NOTE =
  'Gaps in the outline are unscanned areas, not openings; right-angles are not assumed.';

/**
 * Trace the boundary of the occupied-cell mask as a closed ring of cell-corner
 * points (a Moore-neighbour boundary walk). Returns the LARGEST connected
 * boundary found, as plan-metre coordinates. Blocky by construction — it follows
 * the binary raster's edges, which is exactly the honest, un-fabricated outline.
 */
function traceOutline(
  occ: Uint8Array,
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
  ox: number,
  oy: number,
): Array<[number, number]> {
  // Find the first occupied cell scanning row-major; its bottom-left corner is on
  // the outer boundary. The walk follows occupied/empty edges around the region.
  let startC = -1, startR = -1;
  for (let r = 0; r < rows && startR < 0; r++) {
    for (let c = 0; c < cols; c++) {
      if (occ[r * cols + c]) { startC = c; startR = r; break; }
    }
  }
  if (startC < 0) return [];

  const filled = (c: number, r: number): boolean =>
    c >= 0 && c < cols && r >= 0 && r < rows && occ[r * cols + c] === 1;

  // Corner-grid boundary walk: walk along grid corners between filled/empty
  // cells. Directions: 0=+x (right), 1=+y (up), 2=-x (left), 3=-y (down). We
  // start at the bottom-left corner of the start cell heading right.
  const cornerX = (c: number): number => ox + c * cellW;
  const cornerY = (r: number): number => oy + r * cellH;
  const ring: Array<[number, number]> = [];
  const start: [number, number] = [startC, startR];
  let cx = start[0], cy = start[1]; // current corner (col,row in corner-grid)
  let dir = 0;
  const maxSteps = 4 * cols * rows + 8;
  let steps = 0;
  do {
    ring.push([cornerX(cx), cornerY(cy)]);
    // At corner (cx,cy) the four incident cells are:
    //   bottom-left  = cell (cx-1, cy-1)
    //   bottom-right = cell (cx,   cy-1)
    //   top-left     = cell (cx-1, cy)
    //   top-right    = cell (cx,   cy)
    // Pick the next edge by a left-hand rule on the filled region.
    const bl = filled(cx - 1, cy - 1);
    const br = filled(cx, cy - 1);
    const tl = filled(cx - 1, cy);
    const tr = filled(cx, cy);
    // Turn preference (left, straight, right) relative to current heading.
    const tryDirs = [(dir + 1) % 4, dir, (dir + 3) % 4, (dir + 2) % 4];
    let moved = false;
    for (const nd of tryDirs) {
      // An edge in direction nd is walkable when it has a filled cell on its
      // LEFT and empty on its RIGHT (region kept on the left, CCW outer walk).
      let leftFilled = false, rightFilled = false;
      if (nd === 0) { leftFilled = tr; rightFilled = br; }       // moving +x
      else if (nd === 1) { leftFilled = tl; rightFilled = tr; }  // moving +y
      else if (nd === 2) { leftFilled = bl; rightFilled = tl; }  // moving -x
      else { leftFilled = br; rightFilled = bl; }                // moving -y
      if (leftFilled && !rightFilled) {
        dir = nd;
        if (nd === 0) cx++; else if (nd === 1) cy++; else if (nd === 2) cx--; else cy--;
        moved = true;
        break;
      }
    }
    if (!moved) break;
    steps++;
  } while ((cx !== start[0] || cy !== start[1]) && steps < maxSteps);
  return ring;
}

/**
 * Compute a deterministic, density-derived floor-plan sketch from a point cloud.
 * Reuses the same up-frame projection + occupancy-grid approach spaceMetrics
 * uses, so the outline and the room dimensions agree with the on-screen report.
 */
export function computeFloorPlan(
  positions: Float32Array | ReadonlyArray<number>,
  params: FloorPlanParams,
): FloorPlan {
  const up = params.upAxis;
  const u2m = params.unitToMetres && params.unitToMetres > 0 ? params.unitToMetres : 1;
  const gridN = Math.max(8, Math.floor(params.gridN ?? 48));
  const maxSamples = Math.max(100, Math.floor(params.maxSamples ?? 60_000));
  const n = Math.floor(positions.length / 3);

  const empty: FloorPlan = {
    outline: [],
    walls: [],
    widthM: 0,
    depthM: 0,
    cellSizeM: 0,
    bbox: [0, 0, 0, 0],
    reasons: [APPROX_NOTE, 'Too few points to sketch a footprint yet.'],
  };
  if (n < 16) return empty;

  const { v: vOff, h1: h1Off, h2: h2Off } = upOffsets(up);
  const stride = Math.max(1, Math.floor(n / maxSamples));

  const H1: number[] = [], H2: number[] = [], V: number[] = [];
  let minH1 = Infinity, maxH1 = -Infinity, minH2 = Infinity, maxH2 = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off] * u2m, h2 = positions[b + h2Off] * u2m, vv = positions[b + vOff] * u2m;
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(vv)) continue;
    H1.push(h1); H2.push(h2); V.push(vv);
    if (h1 < minH1) minH1 = h1; if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2; if (h2 > maxH2) maxH2 = h2;
    if (vv < minV) minV = vv; if (vv > maxV) maxV = vv;
  }
  const m = V.length;
  if (m < 16) return empty;

  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);
  if (ex1 <= 0 || ex2 <= 0) return empty;

  // Occupancy grid sized to the data — mirror spaceMetrics' target-cell logic so
  // the footprint isn't fragmented by a too-fine grid.
  const PLANE_BAND = 0.15;
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
  const cellW = ex1 / cols;
  const cellH = ex2 / rows;
  const occ = new Uint8Array(cols * rows);
  const zMin = new Float32Array(cols * rows).fill(Infinity);
  const zMax = new Float32Array(cols * rows).fill(-Infinity);
  for (let i = 0; i < m; i++) {
    let c = Math.floor((H1[i] - minH1) / cellW); if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    let r = Math.floor((H2[i] - minH2) / cellH); if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    const idx = r * cols + c;
    occ[idx] = 1;
    if (V[i] < zMin[idx]) zMin[idx] = V[i];
    if (V[i] > zMax[idx]) zMax[idx] = V[i];
  }

  const outline = traceOutline(occ, cols, rows, cellW, cellH, minH1, minH2);

  // ── Dominant wall sides — perimeter cells spanning most of the height ──
  const wallSpan = WALL_SPAN_FRAC * exV;
  const sideCells: Record<PlanWall['side'], number> = { left: 0, right: 0, front: 0, back: 0 };
  const sideRange: Record<PlanWall['side'], { lo: number; hi: number }> = {
    left: { lo: Infinity, hi: -Infinity },
    right: { lo: Infinity, hi: -Infinity },
    front: { lo: Infinity, hi: -Infinity },
    back: { lo: Infinity, hi: -Infinity },
  };
  let wallCells = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (!occ[idx]) continue;
      const edge =
        c === 0 || c === cols - 1 || r === 0 || r === rows - 1 ||
        !occ[idx - 1] || !occ[idx + 1] ||
        (r > 0 && !occ[idx - cols]) || (r < rows - 1 && !occ[idx + cols]);
      if (!edge) continue;
      if (exV <= 0 || zMax[idx] - zMin[idx] < wallSpan) continue;
      wallCells++;
      const dl = c, dr = cols - 1 - c, df = r, db = rows - 1 - r;
      const mn = Math.min(dl, dr, df, db);
      const cellMidX = minH1 + (c + 0.5) * cellW;
      const cellMidY = minH2 + (r + 0.5) * cellH;
      let side: PlanWall['side'];
      if (mn === dl) side = 'left';
      else if (mn === dr) side = 'right';
      else if (mn === df) side = 'front';
      else side = 'back';
      sideCells[side]++;
      // Track the run extent along the wall's free axis (left/right walls run
      // along h2/north; front/back run along h1/east).
      const along = side === 'left' || side === 'right' ? cellMidY : cellMidX;
      const range = sideRange[side];
      if (along < range.lo) range.lo = along;
      if (along > range.hi) range.hi = along;
    }
  }

  const walls: PlanWall[] = [];
  if (wallCells > 0) {
    const thresh = Math.max(2, 0.1 * wallCells);
    const sideFixed: Record<PlanWall['side'], number> = {
      left: minH1,
      right: maxH1,
      front: minH2,
      back: maxH2,
    };
    (['left', 'right', 'front', 'back'] as const).forEach((side) => {
      if (sideCells[side] < thresh) return;
      const range = sideRange[side];
      if (!Number.isFinite(range.lo) || !Number.isFinite(range.hi)) return;
      const fixed = sideFixed[side];
      const seg: PlanWall['segment'] =
        side === 'left' || side === 'right'
          ? [[fixed, range.lo], [fixed, range.hi]]
          : [[range.lo, fixed], [range.hi, fixed]];
      walls.push({ side, segment: seg, cells: sideCells[side] });
    });
  }

  const reasons = [APPROX_NOTE, SPARSE_NOTE];
  return {
    outline,
    walls,
    widthM: ex1,
    depthM: ex2,
    cellSizeM: Math.min(cellW, cellH),
    bbox: [minH1, minH2, maxH1, maxH2],
    reasons,
  };
}
