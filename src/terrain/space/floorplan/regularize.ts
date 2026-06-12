/**
 * regularize.ts
 *
 * Stage 3.5 of the floor-plan extraction pipeline: the REALISM passes that
 * turn an honest-but-raw wall trace into something that reads like an
 * architect's plan, without inventing geometry.
 *
 *   1. ISLAND CLASSIFICATION (mask level) — connected components of the wall
 *      mask that are compact little blobs (small area, low elongation, short
 *      extents) and sit away from the wall network are FURNITURE / room
 *      contents caught by the wall-height band (shelving, wardrobes, plants,
 *      people), not walls. A real plan never pochés a bookcase. They are
 *      lifted out of the wall mask and carried separately so the sheet can
 *      draw them as light "contents" hints (the architectural convention).
 *      Compact fragments NEAR the wall network are kept as walls — a short
 *      jamb return severed from its run by a door gap looks exactly like a
 *      blob, and erasing it would erase the door's jamb.
 *   2. JOG MERGE (vector level, post axis-snap) — adjacent collinear wall
 *      runs separated by a jog of at most ~one mask cell are one wall the
 *      raster split, not two walls: the jog is removed and both runs settle
 *      on their length-weighted mean line. Real walls do not stair-step at
 *      the centimetre scale.
 *   3. SPIKE / SPUR REMOVAL (vector level) — an out-and-back protrusion
 *      whose depth AND width are both under the minimum wall-segment length
 *      (~0.25 m) is raster noise, not a wall stub. Genuine door jambs are
 *      safe by construction: a jamb's end cap is short, but its flanks are
 *      the wall run itself (metres long), so the depth test never fires.
 *   4. SLIVER FILTER — a ring whose mean thickness (2·area / perimeter) is
 *      far below one mask cell is a tracing sliver (zero-width triangle
 *      echo), not a wall strip.
 *
 * NOT here: true wall-thickness normalisation (the centerline pass deferred
 * from this round) now lives in centerline.ts — distance transform, skeleton,
 * branch prune, re-extrusion at the measured median thickness, plus the
 * door-vs-data-gap jamb-evidence classifier. This module also hosts
 * {@link convexHullRing}, the contents-hint simplification.
 *
 * Pure data, deterministic. No DOM.
 */

import type { OccupancyGrid } from './occupancyGrid';
import { dilateMask } from './occupancyGrid';
import { dedupeRing, type Ring } from './vectorize';

/** Islands at most this big can be furniture (a wardrobe footprint ~1.2 m²). */
export const FURNITURE_MAX_AREA_M2 = 1.5;
/** A component spanning at least this far in some direction is a wall run. */
export const WALL_MIN_SIDE_M = 1.2;
/** Thin-and-long (max side / min side) components are wall-like at any size. */
export const WALL_MIN_ELONGATION = 3;
/** Compact fragments within this of the wall network stay walls (jambs). */
export const NEAR_WALL_M = 0.3;
/** Minimum believable wall segment — spurs under this (deep AND wide) die. */
export const MIN_SPUR_M = 0.25;
/** Sliver-ring filter: mean thickness below this fraction of a cell. */
export const SLIVER_THICKNESS_CELL_FRAC = 0.4;

export interface IslandClassification {
  /** The wall mask with furniture islands removed. */
  readonly walls: OccupancyGrid;
  /** Mask holding ONLY the furniture islands — null when there are none. */
  readonly contents: OccupancyGrid | null;
  /** How many furniture islands were lifted out. */
  readonly contentsCount: number;
}

/**
 * Split the closed wall mask into the wall network and furniture islands.
 *
 * A component is WALL-LIKE when it spans ≥ {@link WALL_MIN_SIDE_M} in some
 * direction, is elongated (≥ {@link WALL_MIN_ELONGATION}), or is simply too
 * big for furniture (≥ {@link FURNITURE_MAX_AREA_M2}). Everything else is a
 * furniture candidate — but candidates within {@link NEAR_WALL_M} of a
 * wall-like component are kept as walls, because a door gap severs short
 * jamb returns into exactly such fragments. When NO component is wall-like
 * (degenerate tiny input) everything is kept: with no wall network there is
 * no basis for calling anything furniture.
 */
export function classifyIslands(grid: OccupancyGrid): IslandClassification {
  const { mask, cols, rows, cellX, cellY } = grid;
  const cellM = Math.max(cellX, cellY);
  const n = cols * rows;
  const label = new Int32Array(n).fill(-1);
  interface Comp { cells: number; minC: number; maxC: number; minR: number; maxR: number; wallLike: boolean }
  const comps: Comp[] = [];

  // 8-connected components (matches the morphological closing's connectivity).
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = comps.length;
    const comp: Comp = { cells: 0, minC: cols, maxC: -1, minR: rows, maxR: -1, wallLike: false };
    label[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const r = (i / cols) | 0;
      const c = i - r * cols;
      comp.cells++;
      if (c < comp.minC) comp.minC = c;
      if (c > comp.maxC) comp.maxC = c;
      if (r < comp.minR) comp.minR = r;
      if (r > comp.maxR) comp.maxR = r;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = r + dr;
        if (rr < 0 || rr >= rows) continue;
        for (let dc = -1; dc <= 1; dc++) {
          const cc = c + dc;
          if (cc < 0 || cc >= cols) continue;
          const j = rr * cols + cc;
          if (mask[j] && label[j] < 0) { label[j] = id; stack.push(j); }
        }
      }
    }
    const wM = (comp.maxC - comp.minC + 1) * cellX;
    const hM = (comp.maxR - comp.minR + 1) * cellY;
    const maxSide = Math.max(wM, hM);
    const minSide = Math.max(Math.min(wM, hM), cellM);
    const areaM2 = comp.cells * cellX * cellY;
    comp.wallLike =
      maxSide >= WALL_MIN_SIDE_M ||
      maxSide / minSide >= WALL_MIN_ELONGATION ||
      areaM2 >= FURNITURE_MAX_AREA_M2;
    comps.push(comp);
  }

  const anyWall = comps.some((c) => c.wallLike);
  if (!anyWall || comps.every((c) => c.wallLike)) {
    return { walls: grid, contents: null, contentsCount: 0 };
  }

  // Wall-only mask, dilated by the near-wall margin: furniture candidates
  // overlapping it are wall fragments (jamb returns across door gaps).
  let wallMask: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (mask[i] && comps[label[i]].wallLike) wallMask[i] = 1;
  const wallsOnly = wallMask.slice();
  const nearCells = Math.max(1, Math.ceil(NEAR_WALL_M / cellM));
  for (let k = 0; k < nearCells; k++) wallMask = dilateMask(wallMask, cols, rows);
  const keepNear = new Uint8Array(comps.length);
  for (let i = 0; i < n; i++) {
    if (mask[i] && !comps[label[i]].wallLike && wallMask[i]) keepNear[label[i]] = 1;
  }

  const walls = wallsOnly;
  const contents = new Uint8Array(n);
  let contentsCount = 0;
  const counted = new Uint8Array(comps.length);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const id = label[i];
    if (comps[id].wallLike || keepNear[id]) {
      walls[i] = 1;
    } else {
      contents[i] = 1;
      if (!counted[id]) { counted[id] = 1; contentsCount++; }
    }
  }
  if (contentsCount === 0) return { walls: grid, contents: null, contentsCount: 0 };
  return {
    walls: { ...grid, mask: walls },
    contents: { ...grid, mask: contents },
    contentsCount,
  };
}

/**
 * Convex hull of a ring's vertices (Andrew monotone chain), CCW. The
 * CONTENTS-HINT simplification: a furniture blob traced from a wall-height
 * raster is a ragged splatter of concavities that reads as noise on the
 * sheet; its convex hull is the honest "something stands here, about this
 * big" footprint — the architectural hint convention. Walls NEVER come
 * through here (a hull would seal every doorway and room).
 */
export function convexHullRing(ring: Ring): Ring {
  if (ring.length <= 3) return ring;
  const pts = [...ring].sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const cross = (
    o: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number],
  ): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Array<readonly [number, number]> = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: Array<readonly [number, number]> = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  const hull = dedupeRing([...lower, ...upper]);
  return hull.length >= 3 ? hull : ring;
}

/** Mean thickness of a ring interpreted as a strip: 2·|area| / perimeter. */
export function ringMeanThicknessM(ring: Ring): number {
  if (ring.length < 3) return 0;
  let a = 0, p = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p > 0 ? Math.abs(a) / p : 0; // |a/2| * 2 / p
}

const MAX_PASSES = 16;

/**
 * Merge collinear wall runs across small jogs, in the dominant-axis frame:
 * two near-axis segments separated by a perpendicular jog of at most
 * `jogTolM` (and offset by at most `jogTolM`) become ONE segment at their
 * length-weighted mean line. Only meaningful after {@link snapRingToAxes}
 * (segments are exactly axis-aligned in the theta frame); rings that were
 * not snapped must not be passed here.
 */
export function mergeAxisJogs(ring: Ring, thetaRad: number, jogTolM: number): Ring {
  if (ring.length < 5 || !(jogTolM > 0)) return ring;
  const cosT = Math.cos(-thetaRad), sinT = Math.sin(-thetaRad);
  let pts: Array<[number, number]> = ring.map(([x, y]) => [
    x * cosT - y * sinT,
    x * sinT + y * cosT,
  ]);
  const EPS = 1e-6;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    let i = 0;
    while (pts.length >= 5 && i < pts.length) {
      const n = pts.length;
      const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n], d = pts[(i + 3) % n];
      // Horizontal run | jog | horizontal run (and the vertical mirror).
      const tryMerge = (ax: 0 | 1): boolean => {
        const co = 1 - ax; // the pinned coordinate's index
        const abAxis = Math.abs(b[co] - a[co]) <= EPS;
        const cdAxis = Math.abs(d[co] - c[co]) <= EPS;
        if (!abAxis || !cdAxis) return false;
        const jog = Math.hypot(c[0] - b[0], c[1] - b[1]);
        if (jog > jogTolM) return false;
        if (Math.abs(c[co] - b[co]) > jogTolM) return false;
        const dirAB = Math.sign(b[ax] - a[ax]);
        const dirCD = Math.sign(d[ax] - c[ax]);
        if (dirAB === 0 || dirAB !== dirCD) return false;
        const lenAB = Math.abs(b[ax] - a[ax]);
        const lenCD = Math.abs(d[ax] - c[ax]);
        if (lenAB + lenCD <= EPS) return false;
        const mean = (a[co] * lenAB + d[co] * lenCD) / (lenAB + lenCD);
        a[co] = mean;
        d[co] = mean;
        return true;
      };
      if (tryMerge(0) || tryMerge(1)) {
        // Drop b and c — a now connects straight to d on the merged line.
        const i1 = (i + 1) % pts.length;
        const i2 = (i + 2) % pts.length;
        pts = pts.filter((_, k) => k !== i1 && k !== i2);
        changed = true;
        // Re-examine from just before the merge point.
        i = Math.max(0, i - 1);
      } else {
        i++;
      }
    }
    if (!changed) break;
  }

  // Remove vertices that became collinear with their neighbours.
  pts = pts.filter((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length];
    const next = pts[(i + 1) % pts.length];
    const cross = (p[0] - prev[0]) * (next[1] - p[1]) - (p[1] - prev[1]) * (next[0] - p[0]);
    const dot = (p[0] - prev[0]) * (next[0] - p[0]) + (p[1] - prev[1]) * (next[1] - p[1]);
    return !(Math.abs(cross) <= EPS && dot > 0);
  });

  const cosB = Math.cos(thetaRad), sinB = Math.sin(thetaRad);
  return dedupeRing(pts.map(([x, y]) => [x * cosB - y * sinB, x * sinB + y * cosB] as const));
}

/** Cosine of the spike angle gate (flanks within ~20° of antiparallel). */
const SPIKE_ANTIPARALLEL_COS = -0.94;

/**
 * Remove out-and-back spikes, in two shapes:
 *
 *   - FLAT-TIP: three consecutive segments where the first and third are
 *     antiparallel, the middle (the tip) is shorter than `minLenM`, AND the
 *     protrusion depth (the SHORTER flank) is also under `minLenM`;
 *   - V-SPIKE: two consecutive segments that nearly reverse at a shared
 *     apex (base |a–c| well under the shorter flank) with depth ≤ `minLenM`.
 *
 * Both gates matter: a door jamb's end cap is a short tip with metres-long
 * flanks and must survive; only small bumps (≤ minLen deep and wide) are
 * raster noise.
 */
export function removeSpikes(ring: Ring, minLenM: number): Ring {
  if (ring.length < 4 || !(minLenM > 0)) return ring;
  let pts: Array<readonly [number, number]> = ring.slice();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    let i = 0;
    while (pts.length >= 4 && i < pts.length) {
      const n = pts.length;
      const a = pts[i], b = pts[(i + 1) % n], c = pts[(i + 2) % n], d = pts[(i + 3) % n];
      const ux = b[0] - a[0], uy = b[1] - a[1];
      const vx = c[0] - b[0], vy = c[1] - b[1];
      const wx = d[0] - c[0], wy = d[1] - c[1];
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy), lw = Math.hypot(wx, wy);
      // ── V-spike at apex b: a→b out, b→c (nearly) straight back. ──
      if (lu > 0 && lv > 0 && Math.min(lu, lv) <= minLenM) {
        const base = Math.hypot(c[0] - a[0], c[1] - a[1]);
        if (base <= 0.8 * Math.min(lu, lv)) {
          // Cut the apex back to the shorter flank's base level.
          const nb: readonly [number, number] =
            lv >= lu
              ? [b[0] + (vx / lv) * lu, b[1] + (vy / lv) * lu]
              : [b[0] - (ux / lu) * lv, b[1] - (uy / lu) * lv];
          const i1 = (i + 1) % n;
          pts = pts.map((pt, k) => (k === i1 ? nb : pt));
          pts = dedupeRing(pts).slice();
          changed = true;
          i = Math.max(0, i - 1);
          continue;
        }
      }
      // ── Flat-tip spike across b→c. ──
      if (lu > 0 && lw > 0 && lv <= minLenM && Math.min(lu, lw) <= minLenM) {
        const cos = (ux * wx + uy * wy) / (lu * lw);
        if (cos <= SPIKE_ANTIPARALLEL_COS) {
          const depth = Math.min(lu, lw);
          let nb: readonly [number, number] | null = null;
          let nc: readonly [number, number] | null = null;
          if (lw > lu + 1e-9) {
            // Deeper on the w side: cut c back to the u-flank's base level.
            nc = [c[0] + (wx / lw) * depth, c[1] + (wy / lw) * depth];
          } else if (lu > lw + 1e-9) {
            // Deeper on the u side: cut b back by the w-flank's depth.
            nb = [b[0] - (ux / lu) * depth, b[1] - (uy / lu) * depth];
          }
          const i1 = (i + 1) % n, i2 = (i + 2) % n;
          const next: Array<readonly [number, number]> = [];
          for (let k = 0; k < n; k++) {
            if (k === i1) { if (nb) next.push(nb); continue; }
            if (k === i2) { if (nc) next.push(nc); continue; }
            next.push(pts[k]);
          }
          pts = next;
          changed = true;
          i = Math.max(0, i - 1);
          continue;
        }
      }
      i++;
    }
    if (!changed) break;
  }
  return dedupeRing(pts);
}
