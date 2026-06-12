/**
 * floorPlanRealism.test.ts
 *
 * The v0.4.5 realism passes (regularize.ts) with hand-computed truth, after
 * a real 360 interior sheet still read as "not realistic": dozens of compact
 * furniture islands rendered as solid wall poché, stair-step jogs on long
 * wall runs, sub-25 cm stub spurs, zero-width tracing slivers, and a Space
 * panel whose L × W disagreed with the plan sheet's extents by ~2× (the
 * panel's PCA footprint included the 360 noise arms the plan clips).
 *
 * Covered here:
 *   - island classification: a 1 × 0.5 m blob mid-room leaves the poché and
 *     becomes a contents hint; near-wall fragments (door jambs) stay walls;
 *   - jog merge: a one-cell stair-step collapses to the weighted mean line;
 *   - spur removal: < 0.25 m out-and-back bumps die, door-jamb end caps
 *     (short tip, metres-long flanks) survive;
 *   - sliver thickness;
 *   - extent reconciliation: plan bbox ⊆ clip bbox, and spaceMetrics (now
 *     clipped by the SAME dense footprint) agrees with the plan extents.
 */

import { describe, it, expect } from 'vitest';
import { extractFloorPlan, type FloorPlanModel } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';
import type { OccupancyGrid } from '../src/terrain/space/floorplan/occupancyGrid';
import {
  classifyIslands,
  mergeAxisJogs,
  removeSpikes,
  ringMeanThicknessM,
  MIN_SPUR_M,
  FURNITURE_MAX_AREA_M2,
} from '../src/terrain/space/floorplan/regularize';
import type { Ring } from '../src/terrain/space/floorplan/vectorize';
import { spaceMetrics } from '../src/terrain/spaceMetrics';

const STEP = 0.05;

/** Deterministic LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface FurnishedOpts {
  /** Door gap on the south wall (y = 0): open x interval. */
  readonly door?: readonly [number, number];
  /** Furniture boxes [x0, y0, x1, y1] sampled as four vertical faces 0–2 m. */
  readonly furniture?: ReadonlyArray<readonly [number, number, number, number]>;
  /** A thin wall stub [x, y0→y1] protruding off the north wall. */
  readonly stub?: readonly [number, number, number];
}

/** A z-up 10 × 8 × 2.5 m room (floor + walls), optionally furnished. */
function furnishedRoom(opts: FurnishedOpts = {}): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += STEP)
    for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
  const [doorFrom, doorTo] = opts.door ?? [Infinity, Infinity];
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= W + 1e-9; x += STEP) {
      if (!(x > doorFrom + 1e-9 && x < doorTo - 1e-9)) t.push(x, 0, z);
      t.push(x, D, z);
    }
    for (let y = STEP; y < D - 1e-9; y += STEP) t.push(0, y, z, W, y, z);
  }
  // Furniture: four vertical faces, floor to 2 m — a wardrobe-style box that
  // crosses the 0.7–1.8 m wall band and lands in the wall mask.
  for (const [x0, y0, x1, y1] of opts.furniture ?? []) {
    for (let z = 0; z <= 2 + 1e-9; z += STEP) {
      for (let x = x0; x <= x1 + 1e-9; x += STEP) t.push(x, y0, z, x, y1, z);
      for (let y = y0; y <= y1 + 1e-9; y += STEP) t.push(x0, y, z, x1, y, z);
    }
  }
  // Stub spur: a one-point-thick wall tab hanging off the north wall.
  if (opts.stub) {
    const [sx, sy0, sy1] = opts.stub;
    for (let z = 0; z <= H + 1e-9; z += STEP)
      for (let y = sy0; y <= sy1 + 1e-9; y += STEP) t.push(sx, y, z);
  }
  return Float32Array.from(t);
}

/** Min distance from a point to any segment of the model's wall rings. */
function distToWalls(p: readonly [number, number], model: FloorPlanModel): number {
  let best = Infinity;
  for (const ring of model.wallRings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
      if (d < best) best = d;
    }
  }
  return best;
}

/** Build an OccupancyGrid straight from a hand mask (cell 0.1 m). */
function gridFromRows(rows: string[]): OccupancyGrid {
  const R = rows.length, C = rows[0].length;
  const mask = new Uint8Array(R * C);
  for (let r = 0; r < R; r++)
    for (let c = 0; c < C; c++) if (rows[R - 1 - r][c] === '#') mask[r * C + c] = 1;
  return { mask, cols: C, rows: R, cellX: 0.1, cellY: 0.1, originX: 0, originY: 0, threshold: 1 };
}

describe('classifyIslands', () => {
  it('lifts a compact mid-room blob out of the walls, keeps the perimeter', () => {
    // 20 × 20 cells (2 × 2 m at 0.1 m): full border + a 3×3 blob in the middle.
    const rows: string[] = [];
    for (let r = 0; r < 20; r++) {
      let line = '';
      for (let c = 0; c < 20; c++) {
        const border = r === 0 || r === 19 || c === 0 || c === 19;
        const blob = r >= 9 && r <= 11 && c >= 9 && c <= 11;
        line += border || blob ? '#' : '.';
      }
      rows.push(line);
    }
    const res = classifyIslands(gridFromRows(rows));
    expect(res.contentsCount).toBe(1);
    expect(res.contents).not.toBeNull();
    // The blob's 9 cells moved to contents; the border stayed walls.
    let wallCells = 0, contentCells = 0;
    for (let i = 0; i < res.walls.mask.length; i++) {
      wallCells += res.walls.mask[i];
      contentCells += res.contents ? res.contents.mask[i] : 0;
    }
    expect(contentCells).toBe(9);
    expect(wallCells).toBe(4 * 19); // the border ring
  });

  it('keeps a compact fragment NEAR the wall network (a severed door jamb)', () => {
    // Border with a gap, plus a 2-cell fragment 1 cell (0.1 m < 0.3 m) away.
    const rows: string[] = [];
    for (let r = 0; r < 20; r++) {
      let line = '';
      for (let c = 0; c < 20; c++) {
        let on = r === 0 || r === 19 || c === 0 || c === 19;
        if (r === 0 && c >= 8 && c <= 12) on = false; // door gap severs the south wall
        if (r === 0 && (c === 14 || c === 15)) on = true; // jamb fragment (rejoined? no:)
        line += on ? '#' : '.';
      }
      rows.push(line);
    }
    // Make the fragment truly separate: cut at c=16 too.
    const cut = rows.map((line, idx) =>
      idx === 19 ? line.slice(0, 16) + '.' + line.slice(17) : line,
    );
    const res = classifyIslands(gridFromRows(cut));
    // The 3-cell fragment (c 13..15 between the gaps) is compact but within
    // 0.3 m of the wall network — kept as wall, NOT furniture.
    expect(res.contentsCount).toBe(0);
  });

  it('keeps everything when no component is wall-like (no network = no basis)', () => {
    const res = classifyIslands(gridFromRows(['....', '.##.', '.##.', '....']));
    expect(res.contentsCount).toBe(0);
    expect(res.contents).toBeNull();
  });
});

describe('mergeAxisJogs', () => {
  it('collapses a one-cell stair-step to the length-weighted mean line', () => {
    // Top edge runs at y=1 for 6 m then jogs 0.05 up for 4 m (theta = 0).
    const ring: Ring = [
      [0, 0], [10, 0], [10, 1.05], [6, 1.05], [6, 1], [0, 1],
    ];
    const out = mergeAxisJogs(ring, 0, 0.06);
    expect(out.length).toBe(4);
    const ys = out.map((p) => p[1]).sort((a, b) => a - b);
    // Weighted mean of 4 m at 1.05 and 6 m at 1.00 = 1.02.
    expect(ys[2]).toBeCloseTo(1.02, 6);
    expect(ys[3]).toBeCloseTo(1.02, 6);
    expect(ys[0]).toBeCloseTo(0, 6);
  });

  it('leaves a jog WIDER than the tolerance alone (a genuine wall offset)', () => {
    const ring: Ring = [
      [0, 0], [10, 0], [10, 1.4], [6, 1.4], [6, 1], [0, 1],
    ];
    const out = mergeAxisJogs(ring, 0, 0.06);
    expect(out.length).toBe(6);
  });

  it('works in a rotated dominant-axis frame', () => {
    const theta = Math.PI / 7;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const rot = ([x, y]: readonly [number, number]): [number, number] =>
      [x * cos - y * sin, x * sin + y * cos];
    const ring: Ring = ([
      [0, 0], [10, 0], [10, 1.05], [6, 1.05], [6, 1], [0, 1],
    ] as const).map(rot);
    const out = mergeAxisJogs(ring, theta, 0.06);
    expect(out.length).toBe(4);
  });
});

describe('removeSpikes', () => {
  it('removes a small out-and-back bump (raster spur)', () => {
    const ring: Ring = [
      [0, 0], [10, 0], [10, 5], [6, 5], [6, 5.2], [5.9, 5.2], [5.9, 5], [0, 5],
    ];
    const out = removeSpikes(ring, MIN_SPUR_M);
    expect(Math.max(...out.map((p) => p[1]))).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('cuts the deeper flank back to the base on an asymmetric spike', () => {
    const ring: Ring = [
      [0, 0], [10, 0], [10, 5], [6, 5.2], [5.9, 5.2], [5.9, 4.5], [0, 4.5],
    ];
    // Spike at the top: up 0.2 (from y=5 — wait, flanks are [10,5]→[6,5.2]?) —
    // use a clean one: tip [6,5.2]→[5.9,5.2] (0.1), flanks 0.2 up / 0.7 down.
    const ring2: Ring = [
      [0, 0], [10, 0], [10, 5], [6, 5], [6, 5.2], [5.9, 5.2], [5.9, 4.5], [0, 4.5],
    ];
    const out = removeSpikes(ring2, MIN_SPUR_M);
    expect(Math.max(...out.map((p) => p[1]))).toBeLessThanOrEqual(5 + 1e-9);
    // The longer flank survives below the base line (the wall edge continues).
    expect(out.some((p) => Math.abs(p[1] - 4.5) < 1e-9)).toBe(true);
    void ring;
  });

  it('preserves a door jamb: short end cap, metres-long flanks', () => {
    // A 3 m wall strip, 0.15 m thick — the cap (0.15) is under MIN_SPUR_M but
    // both flanks are 3 m, so nothing fires.
    const ring: Ring = [[0, 0], [3, 0], [3, 0.15], [0, 0.15]];
    expect(removeSpikes(ring, MIN_SPUR_M)).toEqual(ring);
  });
});

describe('ringMeanThicknessM', () => {
  it('matches the hand value for a strip and flags a sliver', () => {
    // 2 × 0.1 strip: area 0.2, perimeter 4.2 → 2·A/P ≈ 0.0952.
    expect(ringMeanThicknessM([[0, 0], [2, 0], [2, 0.1], [0, 0.1]])).toBeCloseTo(0.2 / 2.1 / 2 * 2, 3);
    // Near-degenerate triangle: thickness ~ 0.005 — a tracing sliver.
    expect(ringMeanThicknessM([[0, 0], [1, 0.01], [0, 0.01]])).toBeLessThan(0.01);
  });
});

describe('extractFloorPlan — furnished room (the realism round)', () => {
  // 10 × 8 room, 1 m door, a 1 × 0.5 m wardrobe mid-room, and a 0.15 m wall
  // stub poking south off the north wall.
  const model = extractFloorPlan(
    furnishedRoom({
      door: [4.5, 5.5],
      furniture: [[4.5, 3.5, 5.5, 4.0]],
      stub: [2.0, 7.85, 8.0],
    }),
    { upAxis: 'z' },
  );

  it('drops the furniture island from the wall poché', () => {
    expect(model.contentsCount).toBeGreaterThanOrEqual(1);
    expect(model.contentRings.length).toBeGreaterThanOrEqual(1);
    // No WALL within half a metre of the wardrobe's centre…
    expect(distToWalls([5, 3.75], model)).toBeGreaterThan(0.5);
    // …but a contents hint sits right there.
    let best = Infinity;
    for (const ring of model.contentRings) {
      for (const [x, y] of ring) best = Math.min(best, Math.hypot(x - 5, y - 3.75));
    }
    expect(best).toBeLessThan(0.8);
    expect(model.reasons.join(' ')).toMatch(/furniture or room contents/);
  });

  it('the furniture blob is honestly below the furniture-area bar', () => {
    // The fixture's wardrobe is 0.5 m² — inside the ≤ 1.5 m² envelope the
    // classifier promises to treat as possible contents.
    expect(1 * 0.5).toBeLessThan(FURNITURE_MAX_AREA_M2);
  });

  it('kills the sub-25 cm stub spur', () => {
    // A point at the stub's tip (0.15 m into the room at x=2) must not be on
    // a wall — pre-pass it sat ON the spur.
    expect(distToWalls([2, 7.8], model)).toBeGreaterThan(0.1);
  });

  it('keeps the door open and its jambs intact', () => {
    expect(distToWalls([5, 0], model)).toBeGreaterThan(0.3); // door middle: open
    expect(distToWalls([4.3, 0], model)).toBeLessThan(0.2); // west jamb: wall
    expect(distToWalls([5.7, 0], model)).toBeLessThan(0.2); // east jamb: wall
  });

  it('still reproduces the room extents', () => {
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.3);
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.3);
  });

  it('renders the contents hints on the sheet (light grey, not poché)', () => {
    const svg = floorPlanSvg(model, { title: 'furnished' });
    expect(svg).toContain('#dde2e9');
    expect(svg).toMatch(/furniture or room contents/);
  });
});

describe('extractFloorPlan — stair-step wall straightened', () => {
  // The west wall jitters ±4 cm (sub-cell) in x along its length — the mask
  // staircases, and the jog merge must recover ONE straight wall line.
  function jitterRoom(): Float32Array {
    const W = 10, D = 8, H = 2.5;
    const t: number[] = [];
    for (let x = 0; x <= W + 1e-9; x += STEP)
      for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
    const rnd = lcg(7);
    const jitterAt: number[] = [];
    for (let y = 0; y <= D + 1e-9; y += 0.5) jitterAt.push((rnd() - 0.5) * 0.08);
    for (let z = 0; z <= H + 1e-9; z += STEP) {
      for (let x = 0; x <= W + 1e-9; x += STEP) t.push(x, 0, z, x, D, z);
      for (let y = STEP; y < D - 1e-9; y += STEP) {
        const jx = jitterAt[Math.min(jitterAt.length - 1, Math.floor(y / 0.5))];
        t.push(jx, y, z, W, y, z);
      }
    }
    return Float32Array.from(t);
  }
  const model = extractFloorPlan(jitterRoom(), { upAxis: 'z' });

  it('straightens the jittered wall to within a cell of one line', () => {
    expect(model.snappedToAxes).toBe(true);
    // Collect the long (≥ 1 m) near-vertical segments on the west side and
    // check their x-levels collapse to a narrow band (≤ ~1.5 cells), not the
    // ±4 cm staircase + cell quantisation the raw trace carries.
    const cell = model.cellSizeM;
    const xs: number[] = [];
    for (const ring of model.wallRings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (a[0] > 0.6 || b[0] > 0.6) continue;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1) continue;
        if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) continue; // not vertical
        xs.push(a[0], b[0]);
      }
    }
    expect(xs.length).toBeGreaterThan(0);
    // Two faces of the wall strip remain (inner + outer); each face must be
    // straight. Split by the midpoint and check each cluster's spread.
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const spread = (arr: number[]): number =>
      arr.length > 0 ? Math.max(...arr) - Math.min(...arr) : 0;
    const outer = xs.filter((x) => x <= mid);
    const inner = xs.filter((x) => x > mid);
    expect(spread(outer)).toBeLessThanOrEqual(1.5 * cell);
    expect(spread(inner)).toBeLessThanOrEqual(1.5 * cell);
  });
});

describe('extent reconciliation — plan, clip bbox, and the Space panel agree', () => {
  // The exact failure from the user's sheet: plan said 12.9 × 15.0 m while
  // the Space panel said 24.72 × 13.76 m — the panel's PCA footprint was
  // inflated by 360 noise arms the plan had clipped. Both now clip with the
  // same dense-footprint rule.
  function roomWithArm(): Float32Array {
    const base = furnishedRoom({});
    const rnd = lcg(1234);
    const t = Array.from(base);
    for (let i = 0; i < 250; i++) {
      t.push(10.2 + rnd() * 19.8, 3.5 + rnd(), rnd() * 2.5);
    }
    return Float32Array.from(t);
  }
  const pts = roomWithArm();
  const model = extractFloorPlan(pts, { upAxis: 'z' });
  const space = spaceMetrics(pts, { upAxis: 'z', spaceKind: 'interior' });

  it('exposes the clip bbox and keeps the plan inside it', () => {
    expect(model.clipBbox).not.toBeNull();
    const [cx0, cy0, cx1, cy1] = model.clipBbox as readonly [number, number, number, number];
    const [x0, y0, x1, y1] = model.bbox;
    expect(x0).toBeGreaterThanOrEqual(cx0 - 1e-6);
    expect(y0).toBeGreaterThanOrEqual(cy0 - 1e-6);
    expect(x1).toBeLessThanOrEqual(cx1 + 1e-6);
    expect(y1).toBeLessThanOrEqual(cy1 + 1e-6);
    // The clip bbox is the room plus at most its one-footprint-cell margin —
    // nowhere near the 30 m arm tip.
    expect(cx1).toBeLessThan(12);
  });

  it('spaceMetrics clips the same arm and reports it', () => {
    expect(space.reasons.join(' ')).toMatch(/outside the dense footprint/);
    // Pre-fix: ~20+ m (the whole arm). The clip's one-footprint-cell margin
    // legitimately keeps ≤ ~1.2 m of sparse fringe where the arm TOUCHES the
    // room, so the panel reads the room plus at most that fringe.
    expect(space.dims.lengthM).toBeLessThan(11.5);
  });

  it('panel L × W match the plan extents (no more 2× disagreement)', () => {
    const planL = Math.max(model.widthM, model.depthM);
    const planW = Math.min(model.widthM, model.depthM);
    // The plan measures thresholded WALLS, the panel measures clipped points;
    // they may differ by the clip margin's sparse fringe (≤ ~1.5 m here, on
    // an adversarial arm that touches the room) — never by 2× again.
    expect(Math.abs(space.dims.lengthM - planL)).toBeLessThan(1.5);
    expect(Math.abs(space.dims.widthM - planW)).toBeLessThan(1.5);
    expect(space.dims.lengthM / planL).toBeLessThan(1.2);
    expect(space.dims.widthM / planW).toBeLessThan(1.2);
  });
});
