/**
 * centerline.ts
 *
 * Stage 3.6 of the floor-plan extraction pipeline: WALL-THICKNESS
 * NORMALISATION and DOORWAY CLASSIFICATION — the centerline pass that
 * v0.4.5's first realism round deferred.
 *
 * The remaining artifact class on real 360 sheets after the island / jog /
 * spur round was WALL MASS: a wall scanned from both sides (or echoed by the
 * scanner) leaves two parallel return strips that the morphological closing
 * fuses into one strip 3–10× thicker than the building's real walls, and
 * clutter pressed against a wall (shelving, kitchen runs) merges into the
 * same component and pochés as more fake mass. The poché ends up blobby with
 * white voids punched where the echo gap survived. The fix, on the mask:
 *
 *   1. DISTANCE TRANSFORM (chamfer 3-4) — each wall cell's half-thickness;
 *   2. SKELETON (Zhang-Suen thinning) — the wall centerlines, topology
 *      preserved (loops stay loops, door gaps stay gaps);
 *   3. BRANCH PRUNE — medial-axis spurs whose length is on the order of the
 *      local half-thickness are shape noise of the fat region, not walls
 *      (significance test L ≤ R + 2 cells); genuine wall stubs are LONGER
 *      than the local thickness and survive;
 *   4. RE-EXTRUDE — each skeleton cell paints a disc of radius
 *      min(local half-thickness, the MEASURED median half-thickness), so
 *      normal walls reproduce themselves while echo-fattened runs collapse
 *      onto their centerline at the thickness the building actually
 *      measures. The result is clamped to the input mask — the pass only
 *      ever REMOVES poché, it never paints where the scan put nothing.
 *
 * It also DEMOTES standalone fat components (a free-standing mass much
 * thicker than the building's walls — a kitchen island, a sofa group) to the
 * room-contents layer: a strip that thick is not a wall, and tracing a fake
 * wall centerline through furniture would fabricate architecture.
 *
 * DOORWAY CLASSIFICATION reads the pruned skeleton's endpoints (free wall
 * ends): two ends whose runs face each other across a door-width gap
 * (0.55–1.4 m), collinearly, with no wall in between, are a doorway — the
 * jamb-evidence test. Everything else stays an honest unclassified gap
 * (unscanned, or simply not a door).
 *
 * Pure data, deterministic. No DOM.
 */

import type { OccupancyGrid } from './occupancyGrid';

/** Re-extrusion cap can never exceed this half-thickness (m) — even when the
 * median is inflated by a heavily echoed scan, walls stay plausible. */
export const MAX_WALL_HALF_M = 0.35;
/** Standalone components this many times thicker than the main wall network
 * are furniture mass, not walls — demoted to the contents layer. */
export const FAT_DEMOTE_FACTOR = 2.5;
/** Doorway width gates (clear width between the jamb faces), metres. */
export const DOOR_MIN_M = 0.55;
export const DOOR_MAX_M = 1.4;
/** Cosine gate for SQUARE jamb evidence: both wall-end runs must point at
 * each other within ~23° of the gap line. Ragged pairs (skewed ends) fail
 * this but can still register as 'unknown' gaps via the loose gate. */
const DOOR_FACING_COS = 0.92;

/**
 * Chamfer 3-4 distance transform: for every FILLED cell, the distance to the
 * nearest background cell in CELL units (orthogonal step = 1), where a
 * boundary cell (background 4-neighbour) reads 1. Cells outside the grid
 * count as background — the grid is fitted to the wall bbox, so the border
 * IS a wall face. Background cells read 0.
 */
export function chamferDistanceCells(mask: Uint8Array, cols: number, rows: number): Float64Array {
  const n = cols * rows;
  const INF = 1e9;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = mask[i] ? INF : 0;
  // Forward pass (top-left → bottom-right). Out-of-bounds neighbours are
  // background: their contribution is the plain step cost.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!mask[i]) continue;
      let v = d[i];
      const left = c > 0 ? d[i - 1] : 0;
      const up = r > 0 ? d[i - cols] : 0;
      const upLeft = r > 0 && c > 0 ? d[i - cols - 1] : 0;
      const upRight = r > 0 && c < cols - 1 ? d[i - cols + 1] : 0;
      v = Math.min(v, left + 3, up + 3, upLeft + 4, upRight + 4);
      d[i] = v;
    }
  }
  // Backward pass.
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (!mask[i]) continue;
      let v = d[i];
      const right = c < cols - 1 ? d[i + 1] : 0;
      const down = r < rows - 1 ? d[i + cols] : 0;
      const downRight = r < rows - 1 && c < cols - 1 ? d[i + cols + 1] : 0;
      const downLeft = r < rows - 1 && c > 0 ? d[i + cols - 1] : 0;
      v = Math.min(v, right + 3, down + 3, downRight + 4, downLeft + 4);
      d[i] = v;
    }
  }
  for (let i = 0; i < n; i++) if (mask[i]) d[i] /= 3;
  return d;
}

/**
 * Zhang-Suen thinning: reduce the mask to its 1-cell skeleton. Preserves
 * connectivity and holes (loops stay loops) and never deletes line ends, so
 * a wall strip thins to a centerline of the same extent. Returns a NEW mask.
 */
export function skeletonize(mask: Uint8Array, cols: number, rows: number): Uint8Array {
  const skel = mask.slice();
  const at = (c: number, r: number): number =>
    c >= 0 && c < cols && r >= 0 && r < rows ? skel[r * cols + c] : 0;
  const toClear: number[] = [];
  // Iterations bounded by the half-thickness of the fattest blob; the hard
  // cap keeps a pathological mask from spinning (each pass strictly shrinks).
  for (let pass = 0; pass < 512; pass++) {
    let changed = false;
    for (const step of [0, 1] as const) {
      toClear.length = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (!at(c, r)) continue;
          // Neighbours clockwise from north (p2..p9 in the classic paper).
          const p2 = at(c, r - 1), p3 = at(c + 1, r - 1), p4 = at(c + 1, r);
          const p5 = at(c + 1, r + 1), p6 = at(c, r + 1), p7 = at(c - 1, r + 1);
          const p8 = at(c - 1, r), p9 = at(c - 1, r - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let k = 0; k < 8; k++) if (seq[k] === 0 && seq[k + 1] === 1) a++;
          if (a !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(r * cols + c);
        }
      }
      for (const i of toClear) skel[i] = 0;
      if (toClear.length > 0) changed = true;
    }
    if (!changed) break;
  }
  return skel;
}

/** 8-neighbour indices of cell i that are set in `mask` (bounds-checked). */
function neighbours(mask: Uint8Array, cols: number, rows: number, i: number): number[] {
  const r = (i / cols) | 0;
  const c = i - r * cols;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= rows) continue;
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const cc = c + dc;
      if (cc < 0 || cc >= cols) continue;
      const j = rr * cols + cc;
      if (mask[j]) out.push(j);
    }
  }
  return out;
}

/**
 * Prune insignificant skeleton branches: walk from every endpoint toward the
 * network; a branch that REACHES A JUNCTION while still shorter than the
 * local half-thickness (+2 cells of raster slack) is a medial-axis spur of a
 * fat region's outline, not a wall — remove it. Free-standing runs (simple
 * paths, endpoint to endpoint) and branches longer than the local thickness
 * (genuine wall stubs, door-jamb returns) are kept. Iterates because a
 * removed spur can expose another. Returns a NEW mask.
 */
export function pruneSkeleton(
  skel: Uint8Array,
  dist: Float64Array,
  cols: number,
  rows: number,
): Uint8Array {
  const out = skel.slice();
  for (let pass = 0; pass < 8; pass++) {
    let removed = 0;
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      const nb = neighbours(out, cols, rows, i);
      if (nb.length !== 1) continue; // endpoints only
      // Walk the branch until a junction (≥3 neighbours) or another endpoint.
      const path: number[] = [i];
      let prev = i;
      let cur = nb[0];
      let maxR = dist[i];
      let endsAtJunction = false;
      for (let steps = 0; steps < out.length; steps++) {
        const curNb = neighbours(out, cols, rows, cur).filter((j) => j !== prev);
        if (dist[cur] > maxR) maxR = dist[cur];
        // Junction test counts ALL neighbours (incl. the one we came from).
        const degree = curNb.length + 1;
        if (degree >= 3) { endsAtJunction = true; break; }
        path.push(cur);
        if (curNb.length === 0) break; // simple path — a free-standing run
        prev = cur;
        cur = curNb[0];
      }
      if (!endsAtJunction) continue;
      if (path.length <= maxR + 2) {
        for (const j of path) out[j] = 0;
        removed++;
      }
    }
    if (removed === 0) break;
  }
  return out;
}

export interface ThicknessNormalization {
  /** The wall mask with thickness normalised (subset of the input mask). */
  readonly walls: OccupancyGrid;
  /** Standalone fat components demoted to contents — null when none. */
  readonly demoted: OccupancyGrid | null;
  /** How many components were demoted. */
  readonly demotedCount: number;
  /** The measured median wall thickness, metres (what the cap enforces). */
  readonly medianThicknessM: number;
  /** Cells removed from the wall mask by the collapse (0 = effectively a no-op). */
  readonly removedCells: number;
  /** The pruned skeleton (centerlines) of the kept wall mask, for reuse. */
  readonly skeleton: Uint8Array;
  /** The chamfer distances (cell units) of the INPUT mask, for reuse. */
  readonly distances: Float64Array;
}

/** Median of a numeric array (copy + sort); 0 on empty. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

/**
 * Normalise wall thickness around the mask's centerlines (see module doc).
 * The output mask is ALWAYS a subset of the input mask — the pass removes
 * echo/clutter mass, it never invents wall.
 */
export function normalizeWallThickness(grid: OccupancyGrid): ThicknessNormalization {
  const { mask, cols, rows, cellX, cellY } = grid;
  const cellM = Math.max(cellX, cellY);
  const n = cols * rows;
  const dist = chamferDistanceCells(mask, cols, rows);
  const rawSkel = skeletonize(mask, cols, rows);
  const skel = pruneSkeleton(rawSkel, dist, cols, rows);

  // ── Component labelling (of the INPUT mask) for the demotion test ──
  const label = new Int32Array(n).fill(-1);
  const compCells: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = compCells.length;
    compCells.push(0);
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      compCells[id]++;
      for (const j of neighbours(mask, cols, rows, i)) {
        if (label[j] < 0) { label[j] = id; stack.push(j); }
      }
    }
  }
  // Per-component skeleton radii; the main network = most cells.
  const radii: number[][] = compCells.map(() => []);
  for (let i = 0; i < n; i++) if (skel[i]) radii[label[i]].push(dist[i]);
  let main = 0;
  for (let id = 1; id < compCells.length; id++) if (compCells[id] > compCells[main]) main = id;
  const mainMedianR = Math.max(1, median(radii[main]));

  // ── Demote standalone fat components (furniture mass, not walls) ──
  const demotedComp = new Uint8Array(compCells.length);
  let demotedCount = 0;
  for (let id = 0; id < compCells.length; id++) {
    if (id === main) continue;
    const compMedianR = radii[id].length > 0 ? median(radii[id]) : 0;
    if (compMedianR > FAT_DEMOTE_FACTOR * mainMedianR) {
      demotedComp[id] = 1;
      demotedCount++;
    }
  }

  // ── Measured cap from the KEPT components' skeleton radii ──
  const keptRadii: number[] = [];
  for (let i = 0; i < n; i++) if (skel[i] && !demotedComp[label[i]]) keptRadii.push(dist[i]);
  const capCells = Math.min(Math.max(1, median(keptRadii)), Math.max(1, MAX_WALL_HALF_M / cellM));
  const medianThicknessM = Math.max(cellM, (2 * capCells - 1) * cellM);

  // ── Re-extrude: discs of min(local, cap) around the kept centerlines,
  //    clamped to the input mask (subset guarantee). The disc radius equals
  //    the LOCAL half-thickness up to the cap, so a wall at or under the
  //    measured median reproduces itself EXACTLY (the clamp stops the disc
  //    at the original faces) — only the EXCESS mass of echo-fattened runs
  //    is removed. The pass is a strict improvement: clean scans round-trip
  //    unchanged. ──
  const out = new Uint8Array(n);
  const maxRad = Math.ceil(capCells);
  for (let i = 0; i < n; i++) {
    if (!skel[i] || demotedComp[label[i]]) continue;
    const r = (i / cols) | 0;
    const c = i - r * cols;
    const rUsed = Math.min(dist[i], capCells);
    const reach = Math.min(maxRad, Math.ceil(rUsed));
    out[i] = 1;
    for (let dr = -reach; dr <= reach; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -reach; dc <= reach; dc++) {
        const cc = c + dc;
        if (cc < 0 || cc >= cols) continue;
        if (dr * dr + dc * dc > rUsed * rUsed + 1e-9) continue;
        const j = rr * cols + cc;
        if (mask[j]) out[j] = 1; // never paint beyond the traced mask
      }
    }
  }

  let removedCells = 0;
  let demotedMask: Uint8Array | null = null;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    if (demotedComp[label[i]]) {
      if (demotedMask === null) demotedMask = new Uint8Array(n);
      demotedMask[i] = 1;
    } else if (!out[i]) {
      removedCells++;
    }
  }

  // Skeleton restricted to kept components (the doorway pass reuses it).
  const keptSkel = skel.slice();
  for (let i = 0; i < n; i++) if (keptSkel[i] && demotedComp[label[i]]) keptSkel[i] = 0;

  return {
    walls: { ...grid, mask: out },
    demoted: demotedMask !== null ? { ...grid, mask: demotedMask } : null,
    demotedCount,
    medianThicknessM,
    removedCells,
    skeleton: keptSkel,
    distances: dist,
  };
}

/** Facing wall ends further apart than this are honest holes, not "a gap"
 * (dashing a 5 m missing run would fabricate enclosure). */
export const GAP_MAX_M = 2.5;
/** Looser facing gate for unknown gaps — ragged ends still roughly facing. */
const GAP_FACING_COS = 0.35;

export type PlanGapKind = 'door' | 'unknown';

/** A classified wall gap: the segment between the two facing wall-end faces. */
export interface PlanGap {
  /** Wall-end face points of the gap, plan metres. */
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
  /** Clear width between the faces, metres. */
  readonly widthM: number;
  /**
   * 'door' — BOTH flanking wall ends are square (collinear, facing) across a
   * door-width gap: jamb evidence. 'unknown' — the ends face each other but
   * the evidence is ragged (skewed ends, non-door width): an unscanned run
   * or simply not a door. The sheet renders 'unknown' as a dashed line and
   * leaves doors as genuine openings.
   */
  readonly kind: PlanGapKind;
}

/**
 * Classify gaps between FREE WALL ENDS — the jamb-evidence test.
 * A DOORWAY needs BOTH jambs: two skeleton endpoints whose runs point at
 * each other (collinear within the strict facing gate) across a clear gap of
 * 0.55–1.4 m with no wall in between. Facing end pairs WITHOUT that evidence
 * (ragged ends, non-door widths up to {@link GAP_MAX_M}) are honest UNKNOWN
 * gaps — unscanned or unclassifiable, never claimed as doors. Anything wider
 * or not even loosely facing stays out of the list entirely.
 */
export function classifyWallGaps(
  grid: OccupancyGrid,
  skeleton: Uint8Array,
  distances: Float64Array,
): PlanGap[] {
  const { mask, cols, rows, cellX, cellY, originX, originY } = grid;
  const cellM = Math.max(cellX, cellY);
  interface End {
    /** Cell index, world position (cell centre), outward unit direction. */
    i: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    /** Local half-thickness at the end, metres. */
    halfM: number;
    /** Run length backing this end, metres (jambs need a real wall run). */
    runM: number;
  }
  const ends: End[] = [];
  const world = (i: number): [number, number] => {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    return [originX + (c + 0.5) * cellX, originY + (r + 0.5) * cellY];
  };
  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i]) continue;
    let nb = neighbours(skeleton, cols, rows, i);
    if (nb.length !== 1) continue;
    // Walk back along the run to estimate the end's direction robustly.
    const K = Math.max(4, Math.round(0.4 / cellM));
    let prev = i;
    let cur = nb[0];
    let steps = 1;
    for (; steps < K; steps++) {
      const next = neighbours(skeleton, cols, rows, cur).filter((j) => j !== prev);
      if (next.length !== 1) break; // junction or end — stop here
      prev = cur;
      cur = next[0];
    }
    const [ex, ey] = world(i);
    const [bx, by] = world(cur);
    const len = Math.hypot(ex - bx, ey - by);
    if (len <= 0) continue;
    ends.push({
      i,
      x: ex,
      y: ey,
      dx: (ex - bx) / len,
      dy: (ey - by) / len,
      halfM: Math.max(0.5, distances[i]) * cellM,
      runM: steps * cellM,
    });
  }

  /**
   * True when the straight segment a→b crosses NO wall cell (clear gap).
   * Samples within `skipA` / `skipB` of the respective endpoint are the
   * flanking wall's OWN mass (on a skewed gap the segment exits diagonally
   * and clips the jamb's corner cells) and are not counted as obstruction.
   */
  const clear = (
    x1: number, y1: number, x2: number, y2: number,
    skipA: number, skipB: number,
  ): boolean => {
    const len = Math.hypot(x2 - x1, y2 - y1);
    const stepCount = Math.max(2, Math.ceil((len / cellM) * 2));
    for (let s = 1; s < stepCount; s++) {
      const t = s / stepCount;
      if (t * len <= skipA || (1 - t) * len <= skipB) continue;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      const c = Math.floor((x - originX) / cellX);
      const r = Math.floor((y - originY) / cellY);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      if (mask[r * cols + c]) return false;
    }
    return true;
  };

  // Candidate pairs; each end belongs to at most one gap. Doors are matched
  // first (then narrowest first), so an end with both a square door partner
  // and a ragged one is claimed by the door.
  interface Cand { ai: number; bi: number; widthM: number; a: [number, number]; b: [number, number]; kind: PlanGapKind }
  const cands: Cand[] = [];
  for (let ai = 0; ai < ends.length; ai++) {
    for (let bi = ai + 1; bi < ends.length; bi++) {
      const A = ends[ai], B = ends[bi];
      const gx = B.x - A.x, gy = B.y - A.y;
      const centreDist = Math.hypot(gx, gy);
      if (centreDist <= 0 || centreDist > GAP_MAX_M + A.halfM + B.halfM + 2 * cellM) continue;
      const ux = gx / centreDist, uy = gy / centreDist;
      // Facing: A's run points at B and B's run points back at A. The strict
      // gate is the SQUARE-JAMB (door) evidence; the loose gate admits the
      // pair as a candidate gap at all. An L-corner or a parallel-offset
      // pair fails even the loose gates.
      const cosA = A.dx * ux + A.dy * uy;
      const cosB = B.dx * -ux + B.dy * -uy;
      if (cosA < GAP_FACING_COS || cosB < GAP_FACING_COS) continue;
      // Both ends need a believable wall run behind them.
      if (A.runM < 2 * cellM || B.runM < 2 * cellM) continue;
      // The skeleton end sits ~half-thickness short of the wall-end FACE.
      const aFace: [number, number] = [A.x + A.dx * A.halfM, A.y + A.dy * A.halfM];
      const bFace: [number, number] = [B.x + B.dx * B.halfM, B.y + B.dy * B.halfM];
      const widthM = Math.hypot(bFace[0] - aFace[0], bFace[1] - aFace[1]);
      if (widthM < 2 * cellM || widthM > GAP_MAX_M) continue;
      if (!clear(aFace[0], aFace[1], bFace[0], bFace[1], A.halfM + cellM, B.halfM + cellM))
        continue;
      const square = cosA >= DOOR_FACING_COS && cosB >= DOOR_FACING_COS;
      const doorWidth = widthM >= DOOR_MIN_M && widthM <= DOOR_MAX_M;
      cands.push({
        ai,
        bi,
        widthM,
        a: aFace,
        b: bFace,
        kind: square && doorWidth ? 'door' : 'unknown',
      });
    }
  }
  cands.sort((p, q) =>
    p.kind !== q.kind ? (p.kind === 'door' ? -1 : 1) : p.widthM - q.widthM,
  );
  const used = new Uint8Array(ends.length);
  const gaps: PlanGap[] = [];
  for (const cand of cands) {
    if (used[cand.ai] || used[cand.bi]) continue;
    used[cand.ai] = 1;
    used[cand.bi] = 1;
    gaps.push({ a: cand.a, b: cand.b, widthM: cand.widthM, kind: cand.kind });
  }
  return gaps;
}
