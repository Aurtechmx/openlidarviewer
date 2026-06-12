/**
 * floorPlanCenterline.test.ts
 *
 * The v0.4.5 second realism round (centerline.ts + the contents hull):
 * wall-thickness normalisation — the pass the first round deferred — plus
 * door-vs-data-gap classification by jamb evidence and the contents-hint
 * convex-hull simplification. Synthetic truth per pass:
 *
 *   - chamfer distance: hand-computed cell distances on strips;
 *   - skeletonize: a fat strip thins to a 1-cell line, a closed ring of wall
 *     keeps its loop (door gaps must never be sealed by the thinning);
 *   - pruneSkeleton: medial-axis spurs of a fat blob die, real branches live;
 *   - normalizeWallThickness: clean thin walls round-trip (subset, ~no loss),
 *     an echo-fattened run collapses to the measured median thickness, a
 *     free-standing fat mass is demoted to contents;
 *   - classifyWallGaps: square jambs across a door-width gap = 'door';
 *     ragged (skewed) ends or non-door widths = 'unknown'; wide holes and
 *     L-corners are no gap at all;
 *   - convexHullRing: concave blob outlines become their convex hull;
 *   - the pipeline + SVG: double-wall echo collapses end-to-end, unknown
 *     gaps render dashed, doorways stay genuine openings.
 */

import { describe, it, expect } from 'vitest';
import {
  chamferDistanceCells,
  skeletonize,
  pruneSkeleton,
  normalizeWallThickness,
  classifyWallGaps,
  GAP_MAX_M,
  DOOR_MIN_M,
  DOOR_MAX_M,
} from '../src/terrain/space/floorplan/centerline';
import { convexHullRing } from '../src/terrain/space/floorplan/regularize';
import type { OccupancyGrid } from '../src/terrain/space/floorplan/occupancyGrid';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';
import { ringSignedArea, type Ring } from '../src/terrain/space/floorplan/vectorize';

const STEP = 0.05;

/** Build an OccupancyGrid straight from a hand mask (top row = highest y). */
function gridFromRows(rows: string[], cellM = 0.1): OccupancyGrid {
  const R = rows.length, C = rows[0].length;
  const mask = new Uint8Array(R * C);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) if (rows[R - 1 - r][c] === '#') mask[r * C + c] = 1;
  return { mask, cols: C, rows: R, cellX: cellM, cellY: cellM, originX: 0, originY: 0, threshold: 1 };
}

/** Blank canvas painter: rows × cols, fill rectangles in cell coords. */
function blank(cols: number, rows: number): { mask: Uint8Array; box: (c0: number, r0: number, c1: number, r1: number) => void } {
  const mask = new Uint8Array(cols * rows);
  return {
    mask,
    box: (c0, r0, c1, r1) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
    },
  };
}

function toGrid(mask: Uint8Array, cols: number, rows: number, cellM = 0.05): OccupancyGrid {
  return { mask, cols, rows, cellX: cellM, cellY: cellM, originX: 0, originY: 0, threshold: 1 };
}

const count = (m: Uint8Array): number => m.reduce((a, b) => a + b, 0);

/** 8-neighbour degree of cell i in mask. */
function degree(mask: Uint8Array, cols: number, rows: number, i: number): number {
  const r = (i / cols) | 0, c = i - r * cols;
  let n = 0;
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols && mask[rr * cols + cc]) n++;
    }
  return n;
}

describe('chamferDistanceCells', () => {
  it('reads 1 on wall faces, grows toward the strip core, 0 on background', () => {
    // A 3-row strip in a 7-row grid: middle row is 1 step from background.
    const g = gridFromRows([
      '........',
      '........',
      '########',
      '########',
      '########',
      '........',
      '........',
    ]);
    const d = chamferDistanceCells(g.mask, g.cols, g.rows);
    for (let c = 0; c < 8; c++) {
      expect(d[2 * 8 + c]).toBeCloseTo(1, 5); // bottom face
      expect(d[4 * 8 + c]).toBeCloseTo(1, 5); // top face
      expect(d[0 * 8 + c]).toBe(0); // background
    }
    // Core row: 2 away from background — except at the grid border, which
    // itself counts as a wall face (the grid is fitted to the wall bbox).
    for (let c = 1; c < 7; c++) expect(d[3 * 8 + c]).toBeCloseTo(2, 5);
    expect(d[3 * 8]).toBeCloseTo(1, 5);
    expect(d[3 * 8 + 7]).toBeCloseTo(1, 5);
  });

  it('treats the grid border as a wall face (the grid is fitted to the walls)', () => {
    const g = gridFromRows(['###', '###', '###']);
    const d = chamferDistanceCells(g.mask, g.cols, g.rows);
    expect(d[0]).toBeCloseTo(1, 5); // corner cell: border = background
    expect(d[4]).toBeCloseTo(2, 5); // centre
  });
});

describe('skeletonize', () => {
  it('thins a fat strip to a 1-cell line spanning its extent', () => {
    const { mask, box } = blank(40, 20);
    box(2, 7, 37, 13); // a 7-cell-thick horizontal run
    const skel = skeletonize(mask, 40, 20);
    expect(count(skel)).toBeGreaterThan(0);
    // 1-cell wide: no skeleton cell may have a filled 2×2 square around it.
    for (let r = 0; r + 1 < 20; r++)
      for (let c = 0; c + 1 < 40; c++) {
        const full =
          skel[r * 40 + c] && skel[r * 40 + c + 1] && skel[(r + 1) * 40 + c] && skel[(r + 1) * 40 + c + 1];
        expect(full).toBeFalsy();
      }
    // Extent preserved: the line still spans most of the strip's length
    // (thinning erodes the ends by about the half-thickness).
    let minC = 40, maxC = -1;
    for (let i = 0; i < skel.length; i++)
      if (skel[i]) { const c = i % 40; if (c < minC) minC = c; if (c > maxC) maxC = c; }
    expect(maxC - minC).toBeGreaterThan(25);
  });

  it('preserves a wall loop (holes stay holes — door gaps are never sealed)', () => {
    // A closed ring of 2-thick wall around a room.
    const { mask, box } = blank(30, 30);
    box(2, 2, 27, 3); box(2, 26, 27, 27); box(2, 2, 3, 27); box(26, 2, 27, 27);
    const skel = skeletonize(mask, 30, 30);
    // A loop has NO endpoints: every skeleton cell keeps ≥ 2 neighbours.
    for (let i = 0; i < skel.length; i++) {
      if (skel[i]) expect(degree(skel, 30, 30, i)).toBeGreaterThanOrEqual(2);
    }
    expect(count(skel)).toBeGreaterThan(40);
  });
});

describe('pruneSkeleton', () => {
  it('removes a junction spur shorter than the local half-thickness', () => {
    // Hand skeleton: a horizontal line with a 3-cell spur off its middle,
    // pretending the region was fat there (dist = 4 around the junction).
    const cols = 21, rows = 9;
    const skel = new Uint8Array(cols * rows);
    for (let c = 1; c < 20; c++) skel[4 * cols + c] = 1;
    skel[5 * cols + 10] = 1;
    skel[6 * cols + 10] = 1;
    skel[7 * cols + 10] = 1;
    const dist = new Float64Array(cols * rows).fill(4);
    const pruned = pruneSkeleton(skel, dist, cols, rows);
    // The branch beyond the junction-adjacent cell dies (L = 2 ≤ R + 2 = 6);
    // the cell 8-adjacent to the main run reads as part of the junction and
    // may survive as a 1-cell bump — harmless to the re-extrusion.
    expect(pruned[6 * cols + 10]).toBe(0);
    expect(pruned[7 * cols + 10]).toBe(0);
    // The main run survives untouched.
    for (let c = 1; c < 20; c++) expect(pruned[4 * cols + c]).toBe(1);
  });

  it('keeps a branch longer than the local thickness (a genuine wall stub)', () => {
    const cols = 21, rows = 12;
    const skel = new Uint8Array(cols * rows);
    for (let c = 1; c < 20; c++) skel[2 * cols + c] = 1;
    for (let r = 3; r < 11; r++) skel[r * cols + 10] = 1; // 8-cell branch
    const dist = new Float64Array(cols * rows).fill(2); // thin region
    const pruned = pruneSkeleton(skel, dist, cols, rows);
    expect(pruned[10 * cols + 10]).toBe(1); // branch tip survives
  });
});

describe('normalizeWallThickness', () => {
  /** A 2-thick rectangular wall ring on a 60×40 canvas (cell 0.05 m). */
  function roomMask(): { mask: Uint8Array; cols: number; rows: number } {
    const { mask, box } = blank(60, 40);
    box(2, 2, 57, 3); box(2, 36, 57, 37); box(2, 2, 3, 37); box(56, 2, 57, 37);
    return { mask, cols: 60, rows: 40 };
  }

  it('round-trips clean thin walls (output ⊆ input, ~no mass removed)', () => {
    const { mask, cols, rows } = roomMask();
    const res = normalizeWallThickness(toGrid(mask, cols, rows));
    const inCount = count(mask);
    for (let i = 0; i < mask.length; i++) {
      expect(res.walls.mask[i] <= mask[i]).toBe(true); // subset guarantee
    }
    expect(res.removedCells).toBeLessThan(0.05 * inCount);
    expect(res.demotedCount).toBe(0);
  });

  it('collapses an echo-fattened run onto its centerline at the median thickness', () => {
    const { mask, cols, rows } = roomMask();
    // Fatten the south wall to 10 cells (0.5 m) — a double-wall echo fused.
    for (let r = 2; r <= 11; r++) for (let c = 2; c <= 57; c++) mask[r * cols + c] = 1;
    const res = normalizeWallThickness(toGrid(mask, cols, rows));
    expect(res.removedCells).toBeGreaterThan(100);
    // The fat run's surviving thickness: count filled cells per column.
    let maxThick = 0;
    for (let c = 10; c <= 50; c++) {
      let t = 0;
      for (let r = 2; r <= 11; r++) t += res.walls.mask[r * cols + c];
      if (t > maxThick) maxThick = t;
    }
    // Median wall is 2 cells; the cap allows ~2·cap+1 — far under 10.
    expect(maxThick).toBeLessThanOrEqual(5);
    expect(res.medianThicknessM).toBeLessThanOrEqual(0.2);
    // The other walls survive intact enough to keep tracing.
    let north = 0;
    for (let c = 2; c <= 57; c++) for (let r = 36; r <= 37; r++) north += res.walls.mask[r * cols + c];
    expect(north).toBeGreaterThan(40);
  });

  it('demotes a free-standing fat mass (furniture, not wall) to contents', () => {
    const { mask, cols, rows } = roomMask();
    // A 12×12 solid blob mid-room, detached from the wall network.
    for (let r = 14; r <= 25; r++) for (let c = 24; c <= 35; c++) mask[r * cols + c] = 1;
    const res = normalizeWallThickness(toGrid(mask, cols, rows));
    expect(res.demotedCount).toBe(1);
    expect(res.demoted).not.toBeNull();
    expect(res.demoted!.mask[20 * cols + 30]).toBe(1); // blob → contents
    expect(res.walls.mask[20 * cols + 30]).toBe(0); // …and out of the walls
  });
});

describe('classifyWallGaps', () => {
  /** Two horizontal 3-thick runs on one line with a gap between their ends.
   * `skewRows` shifts the right-hand run vertically (ragged jambs). */
  function gapGrid(gapCells: number, skewRows = 0): OccupancyGrid {
    const cols = 80, rows = 40 + Math.abs(skewRows);
    const { mask, box } = blank(cols, rows);
    const lEnd = 38 - Math.ceil(gapCells / 2);
    const rStart = lEnd + gapCells + 1;
    box(2, 19, lEnd, 21);
    box(rStart, 19 + skewRows, 76, 21 + skewRows);
    return toGrid(mask, cols, rows);
  }

  function gapsOf(grid: OccupancyGrid) {
    const norm = normalizeWallThickness(grid);
    return classifyWallGaps(norm.walls, norm.skeleton, norm.distances);
  }

  it('square jambs across a door-width gap classify as a door', () => {
    const gaps = gapsOf(gapGrid(18)); // 0.9 m at 0.05 m cells
    expect(gaps.length).toBe(1);
    expect(gaps[0].kind).toBe('door');
    expect(gaps[0].widthM).toBeGreaterThanOrEqual(DOOR_MIN_M);
    expect(gaps[0].widthM).toBeLessThanOrEqual(DOOR_MAX_M);
    // The threshold segment sits across the actual gap.
    const midX = (gaps[0].a[0] + gaps[0].b[0]) / 2;
    expect(midX).toBeGreaterThan(1.4);
    expect(midX).toBeLessThan(2.4);
  });

  it('skewed (ragged) facing ends classify as an unknown gap, not a door', () => {
    // Same door-width gap, right run shifted 12 cells: cos ≈ 0.6 — ragged.
    const gaps = gapsOf(gapGrid(14, 12));
    expect(gaps.length).toBe(1);
    expect(gaps[0].kind).toBe('unknown');
  });

  it('a wider-than-door gap with square ends is unknown (not claimed as a door)', () => {
    const gaps = gapsOf(gapGrid(36)); // 1.8 m: square but not door width
    expect(gaps.length).toBe(1);
    expect(gaps[0].kind).toBe('unknown');
    expect(gaps[0].widthM).toBeGreaterThan(DOOR_MAX_M);
  });

  it('holes wider than GAP_MAX_M are no gap at all (honest missing data)', () => {
    const gaps = gapsOf(gapGrid(Math.ceil(GAP_MAX_M / 0.05) + 14));
    expect(gaps.length).toBe(0);
  });

  it('an L-corner is not a gap (the runs do not face each other)', () => {
    const { mask, box } = blank(60, 60);
    box(2, 28, 26, 30); // horizontal run ending mid-canvas
    box(34, 36, 36, 58); // vertical run starting offset diagonally
    const gaps = gapsOf(toGrid(mask, 60, 60));
    expect(gaps.every((g) => g.kind !== 'door')).toBe(true);
  });
});

describe('convexHullRing', () => {
  it('wraps a concave outline in its convex hull (containment + convexity)', () => {
    const ring: Ring = [
      [0, 0], [4, 0], [4, 3], [3, 3], [3, 1], [1, 1], [1, 3], [0, 3],
    ];
    const hull = convexHullRing(ring);
    // Convex: every cross product of consecutive edges has one sign (CCW).
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length], c = hull[(i + 2) % hull.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      expect(cross).toBeGreaterThanOrEqual(0);
    }
    // The hull is the 4-corner bounding rectangle here.
    expect(hull.length).toBe(4);
    expect(Math.abs(ringSignedArea(hull))).toBeCloseTo(12, 5);
    expect(Math.abs(ringSignedArea(hull))).toBeGreaterThan(Math.abs(ringSignedArea(ring)));
  });

  it('leaves a triangle (already convex) unchanged in area', () => {
    const tri: Ring = [[0, 0], [2, 0], [1, 2]];
    expect(convexHullRing(tri)).toEqual(tri);
  });
});

// ── End-to-end: the pipeline + the sheet ────────────────────────────────────

/** A z-up room (10 × 8 × 2.5 m) whose south wall is scanned DOUBLE (an echo
 * pair 0.15 m apart), with a 1 m door through both leaves. */
function echoRoom(): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += STEP)
    for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
  const door = (x: number): boolean => x > 4.5 + 1e-9 && x < 5.5 - 1e-9;
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= W + 1e-9; x += STEP) {
      if (!door(x)) { t.push(x, 0, z); t.push(x, 0.15, z); } // double south wall
      t.push(x, D, z);
    }
    for (let y = STEP; y < D - 1e-9; y += STEP) t.push(0, y, z, W, y, z);
  }
  return Float32Array.from(t);
}

describe('extractFloorPlan — centerline pass end-to-end', () => {
  const model = extractFloorPlan(echoRoom(), { upAxis: 'z' });

  it('collapses the double-wall echo and says so', () => {
    expect(model.thicknessNormalized).toBe(true);
    expect(model.wallThicknessM).not.toBeNull();
    expect(model.wallThicknessM!).toBeLessThanOrEqual(0.35);
    expect(model.reasons.some((r) => /collapsed onto its centerline/i.test(r))).toBe(true);
  });

  it('classifies the 1 m door by its square jambs and keeps it open', () => {
    expect(model.doorways.length).toBeGreaterThanOrEqual(1);
    const south = model.doorways.find(
      (g) => Math.abs((g.a[1] + g.b[1]) / 2) < 0.6 && (g.a[0] + g.b[0]) / 2 > 4 && (g.a[0] + g.b[0]) / 2 < 6,
    );
    expect(south).toBeDefined();
    expect(south!.widthM).toBeGreaterThan(0.6);
    expect(south!.widthM).toBeLessThan(1.4);
  });

  it('keeps the model fields coherent on a clean room (no echo)', () => {
    const clean = extractFloorPlan(
      (() => {
        const t: number[] = [];
        for (let x = 0; x <= 10 + 1e-9; x += STEP)
          for (let y = 0; y <= 8 + 1e-9; y += STEP) t.push(x, y, 0);
        for (let z = 0; z <= 2.5 + 1e-9; z += STEP) {
          for (let x = 0; x <= 10 + 1e-9; x += STEP) t.push(x, 0, z, x, 8, z);
          for (let y = STEP; y < 8 - 1e-9; y += STEP) t.push(0, y, z, 10, y, z);
        }
        return Float32Array.from(t);
      })(),
      { upAxis: 'z' },
    );
    expect(clean.thicknessNormalized).toBe(false);
    expect(clean.reasons.some((r) => /collapsed onto its centerline/i.test(r))).toBe(false);
    expect(clean.unknownGaps.length).toBe(0);
  });
});

describe('floorPlanSvg — gap rendering', () => {
  const model = extractFloorPlan(echoRoom(), { upAxis: 'z' });

  it('renders unknown gaps as a dashed line and doorways as open gaps', () => {
    const withUnknown = {
      ...model,
      unknownGaps: [{ a: [1, 0] as const, b: [2, 0] as const, widthM: 1, kind: 'unknown' as const }],
    };
    const svg = floorPlanSvg(withUnknown, { title: 'gaps' });
    expect(svg).toContain('stroke-dasharray');
    // Doorways draw nothing: with no unknown gaps there is no dashed path.
    const noUnknown = { ...model, unknownGaps: [] };
    expect(floorPlanSvg(noUnknown, { title: 'gaps' })).not.toContain('stroke-dasharray');
  });

  it('mentions the jamb-evidence classification in the footer', () => {
    const svg = floorPlanSvg(model, { title: 'gaps' });
    expect(svg).toMatch(/jamb evidence/);
  });
});
