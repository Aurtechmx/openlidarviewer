/**
 * floorPlanRooms.test.ts
 *
 * The v0.4.6 room segmentation (roomDetect.ts) — flood fill bounded by walls
 * + closed doorway spans — plus its end-to-end wiring through
 * extractFloorPlan and the SVG sheet. Hand-computed synthetic truth:
 *
 *   - UNIT, two rooms + door: outer 2-cell walls on a 42×22 grid (0.1 m
 *     cells) with a 2-cell divider and a 4-cell door gap. Each room interior
 *     is exactly 18 × 18 cells = 3.24 m²; closing the door span must yield
 *     TWO rooms of exactly that area; an empty doorway list (open-plan)
 *     floods them into ONE region of 324 + 324 + 8 gap cells = 6.56 m².
 *   - UNIT, exterior leak: unenclosed walls produce NO rooms (free space
 *     reaches the border) — no synthetic enclosure;
 *   - UNIT, sliver filter: an enclosure under 1 m² is not a room;
 *   - END-TO-END, two-room scan with a 0.9 m door: exactly 2 rooms, each
 *     within ±2% of the hand-computed interior (left 4.95 × 7.9 = 39.105 m²,
 *     right 4.90 × 7.9 = 38.71 m²);
 *   - END-TO-END, open plan with a 2 m UNKNOWN gap: the regions merge into
 *     one room (no fake wall, no fake second room);
 *   - END-TO-END, L-shaped room: ONE room at the hand-counted cell area;
 *   - SHEET: room labels + footer schedule render (claim-accurate wording).
 */

import { describe, it, expect } from 'vitest';
import {
  detectRooms,
  ROOM_MIN_AREA_M2,
  ROOM_COVERAGE_MIN_FRAC,
  OPEN_SPACE_MIN_FRAC,
} from '../src/terrain/space/floorplan/roomDetect';
import type { PlanGap } from '../src/terrain/space/floorplan/centerline';
import type { OccupancyGrid } from '../src/terrain/space/floorplan/occupancyGrid';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';

/** Blank canvas painter (cell coords). */
function blank(cols: number, rows: number): {
  mask: Uint8Array;
  box: (c0: number, r0: number, c1: number, r1: number) => void;
} {
  const mask = new Uint8Array(cols * rows);
  return {
    mask,
    box: (c0, r0, c1, r1) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) mask[r * cols + c] = 1;
    },
  };
}

function toGrid(mask: Uint8Array, cols: number, rows: number, cellM = 0.1): OccupancyGrid {
  return { mask, cols, rows, cellX: cellM, cellY: cellM, originX: 0, originY: 0, threshold: 1 };
}

const door = (a: readonly [number, number], b: readonly [number, number]): PlanGap => ({
  a,
  b,
  widthM: Math.hypot(b[0] - a[0], b[1] - a[1]),
  kind: 'door',
});

describe('detectRooms — flood fill against walls + closed doorway spans', () => {
  /** 42×22 grid, 0.1 m cells: outer 2-cell walls, 2-cell divider at cols
   * 20–21 with a 4-cell door gap at rows 9–12. Rooms are 18×18 cells. */
  function twoRoomGrid(): OccupancyGrid {
    const { mask, box } = blank(42, 22);
    box(0, 0, 41, 1); box(0, 20, 41, 21); box(0, 0, 1, 21); box(40, 0, 41, 21);
    box(20, 2, 21, 8); box(20, 13, 21, 19); // divider with rows 9–12 open
    return toGrid(mask, 42, 22);
  }
  /** The divider door span, jamb to jamb (x at the divider centre 2.05 m). */
  const dividerDoor = door([2.05, 0.9], [2.05, 1.3]);

  it('two rooms + closed door: exactly two rooms at the hand-computed cells', () => {
    // The synthetic rooms are 3.24 m² each — below the architectural
    // ROOM_MIN_AREA_M2 (4 m²) floor. Pass a small override so this test
    // exercises the flood-fill MECHANICS, not the architectural threshold
    // (which has its own test); production uses the default floor.
    const res = detectRooms(twoRoomGrid(), [dividerDoor], null, { minRoomAreaM2: 1.0 });
    expect(res.closedDoorways).toBe(1);
    expect(res.rooms.length).toBe(2);
    // Hand truth: 18 × 18 = 324 free cells per side. The door barrier
    // (radius 1.1 cells, so a DIAGONAL span can never be slipped by the
    // 4-connected flood) provably also paints col 19, rows 9–12: distance
    // √(1² + d²) ≤ 1.1 holds only for the four d = 0 rows. So the left room
    // reads 324 − 4 = 320 cells and the right room (col 22 is 1.5 cells from
    // the span — out of reach) the full 324.
    const cells = res.rooms.map((r) => r.cellCount).sort((a, b) => a - b);
    expect(cells).toEqual([320, 324]);
    expect(res.rooms[0].areaM2 + res.rooms[1].areaM2).toBeCloseTo(6.44, 10);
    // Label anchors are inside their rooms (one left of 2 m, one right).
    const xs = res.rooms.map((r) => r.label[0]).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(2);
    expect(xs[1]).toBeGreaterThan(2.1);
  });

  it('open-plan (no classified door): ONE merged region — no fake wall', () => {
    const res = detectRooms(twoRoomGrid(), []);
    expect(res.rooms.length).toBe(1);
    // 324 + 324 + the 2×4-cell gap corridor = 656 cells = 6.56 m².
    expect(res.rooms[0].cellCount).toBe(656);
    expect(res.rooms[0].areaM2).toBeCloseTo(6.56, 10);
  });

  it("an 'unknown' gap is never closed (kind filter, not just absence)", () => {
    const unknownGap: PlanGap = { ...dividerDoor, kind: 'unknown' };
    const res = detectRooms(twoRoomGrid(), [unknownGap]);
    expect(res.closedDoorways).toBe(0);
    expect(res.rooms.length).toBe(1);
  });

  it('unenclosed walls yield no rooms (free space leaks to the border)', () => {
    const { mask, box } = blank(40, 20);
    box(0, 0, 39, 1); box(0, 18, 39, 19); // two parallel walls, open ends
    const res = detectRooms(toGrid(mask, 40, 20), []);
    expect(res.rooms.length).toBe(0);
  });

  it(`enclosures under ${ROOM_MIN_AREA_M2} m² are slivers, not rooms`, () => {
    // 0.6 × 0.6 m interior (6×6 cells = 0.36 m² < 1 m²).
    const { mask, box } = blank(12, 12);
    box(0, 0, 11, 1); box(0, 10, 11, 11); box(0, 0, 1, 11); box(10, 0, 11, 11);
    const res = detectRooms(toGrid(mask, 12, 12), []);
    expect(res.rooms.length).toBe(0);
  });

  it('an L-shaped enclosure is one room with the exact cell-count area', () => {
    // 32×32 grid: outer 2-cell ring walls; the top-right 14×14 block is
    // solid wall mass, leaving an L of 28×28 − 14×14 = 588 cells = 5.88 m².
    const { mask, box } = blank(32, 32);
    box(0, 0, 31, 1); box(0, 30, 31, 31); box(0, 0, 1, 31); box(30, 0, 31, 31);
    box(16, 16, 31, 31);
    const res = detectRooms(toGrid(mask, 32, 32), []);
    expect(res.rooms.length).toBe(1);
    expect(res.rooms[0].cellCount).toBe(28 * 28 - 14 * 14);
    expect(res.rooms[0].areaM2).toBeCloseTo(5.88, 10);
    // The pole-of-inaccessibility label sits in free space inside the L.
    const [lx, ly] = res.rooms[0].label;
    expect(lx).toBeGreaterThan(0.2);
    expect(ly).toBeGreaterThan(0.2);
    expect(lx < 1.6 || ly < 1.6).toBe(true); // not inside the solid block
  });
});

// ── End-to-end: point cloud → extractFloorPlan → rooms → sheet ─────────────

const STEP = 0.05;

/** A z-up 10 × 8 × 2.5 m two-room scan: divider plane at x = 5 with a gap
 * `gapY` (metres) in it. floor + four outer walls sampled at 5 cm. */
function twoRoomCloud(gapY: readonly [number, number]): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += STEP)
    for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= W + 1e-9; x += STEP) { t.push(x, 0, z); t.push(x, D, z); }
    for (let y = STEP; y < D - 1e-9; y += STEP) {
      t.push(0, y, z); t.push(W, y, z);
      if (y < gapY[0] - 1e-9 || y > gapY[1] + 1e-9) t.push(5, y, z); // divider
    }
  }
  return Float32Array.from(t);
}

describe('extractFloorPlan — rooms end-to-end', () => {
  it('two rooms + 0.9 m door: 2 rooms within ±2% of the hand-computed areas', () => {
    const model = extractFloorPlan(twoRoomCloud([3.5, 4.4]), { upAxis: 'z' });
    expect(model.doorways.length).toBeGreaterThanOrEqual(1); // door classified
    expect(model.fromWallGraph).toBe(true);
    expect(model.rooms.length).toBe(2);
    // Hand truth (200×160 grid, 5 cm cells, walls on cols 0 / 100 / 199):
    // left interior 99 × 158 cells = 39.105 m², right 98 × 158 = 38.71 m².
    const areas = model.rooms.map((r) => r.areaM2).sort((a, b) => b - a);
    expect(Math.abs(areas[0] - 39.105)).toBeLessThan(0.02 * 39.105);
    expect(Math.abs(areas[1] - 38.71)).toBeLessThan(0.02 * 38.71);
  });

  it('open plan with a 2 m unknown gap: regions merge into ONE open space', () => {
    const model = extractFloorPlan(twoRoomCloud([3, 5]), { upAxis: 'z' });
    // The 2 m gap is wider than any door — never classified as one. The two
    // halves merge into one connected, unpartitioned region: FIX 1 reports
    // that honestly as a single OPEN SPACE, not "Room 1" of a schedule.
    expect(model.doorways.length).toBe(0);
    expect(model.rooms.length).toBe(0); // no numbered room
    expect(model.roomSegmentation).toBe('open-space');
    // The open space spans both halves (≈ 78 m² minus the divider stubs).
    expect(model.openSpaceAreaM2).toBeGreaterThan(70);
  });

  it('an L-shaped room is one open space at the hand-counted area', () => {
    // L perimeter: (0,0)→(10,0)→(10,4)→(5,4)→(5,8)→(0,8). Free cells on the
    // 200×160 / 5 cm grid: 79·198 + 79·99 = 23 463 cells = 58.66 m².
    const t: number[] = [];
    const inside = (x: number, y: number): boolean => y <= 4 || x <= 5;
    for (let x = 0; x <= 10 + 1e-9; x += STEP)
      for (let y = 0; y <= 8 + 1e-9; y += STEP) if (inside(x, y)) t.push(x, y, 0);
    for (let z = 0; z <= 2.5 + 1e-9; z += STEP) {
      for (let x = 0; x <= 10 + 1e-9; x += STEP) {
        t.push(x, 0, z);
        if (x <= 5 + 1e-9) t.push(x, 8, z); else t.push(x, 4, z);
      }
      for (let y = STEP; y < 8 - 1e-9; y += STEP) {
        t.push(0, y, z);
        if (y <= 4 - 1e-9) t.push(10, y, z);
        else if (y > 4 + 1e-9) t.push(5, y, z);
      }
    }
    const model = extractFloorPlan(Float32Array.from(t), { upAxis: 'z' });
    // One connected, unpartitioned region → reported as a single open space
    // (FIX 1), with the open-space area at the hand-counted cell area.
    expect(model.rooms.length).toBe(0);
    expect(model.roomSegmentation).toBe('open-space');
    expect(Math.abs(model.openSpaceAreaM2 - 58.66)).toBeLessThan(0.02 * 58.66);
  });
});

describe('floorPlanSvg — rooms on the sheet', () => {
  const model = extractFloorPlan(twoRoomCloud([3.5, 4.4]), { upAxis: 'z' });
  const svg = floorPlanSvg(model, { title: 'two rooms', unitSystem: 'metric' });

  it('labels every room "Room N · area" and prints the footer schedule', () => {
    expect(svg).toMatch(/Room 1 · [\d.]+ m²/);
    expect(svg).toMatch(/Room 2 · [\d.]+ m²/);
    expect(svg).toMatch(/Room schedule \(flood-fill of the wall graph, approx\.\): Room 1 [\d.]+ m² · Room 2 [\d.]+ m²/);
  });

  it('says "wall-graph reconstruction" only because it is one', () => {
    expect(model.fromWallGraph).toBe(true);
    expect(svg).toContain('wall-graph reconstruction');
    expect(svg).toMatch(/Walls reconstructed from the centerline wall graph \(\d+ node/);
    // The honest fallback wording survives for non-graph models.
    const noGraph = { ...model, fromWallGraph: false };
    expect(floorPlanSvg(noGraph, {})).toContain('approximate wall-trace sketch');
  });

  it('keeps the standing preview / experimental caveats', () => {
    expect(svg).toContain('Experimental — requires visual validation.');
    expect(svg).toMatch(/not for construction, survey, or legal use/);
  });
});

// ── FIX 1: the honesty guard — no fake room schedule on a leaking open plan ──

describe('detectRooms — architectural min-room-area floor (ROOM_MIN_AREA_M2)', () => {
  it(`drops sub-${ROOM_MIN_AREA_M2} m² flood pockets instead of numbering them`, () => {
    // Threshold is architecturally honest: a 1–3 m² pocket is not a room.
    expect(ROOM_MIN_AREA_M2).toBeGreaterThanOrEqual(4);
    // A 3×3 m enclosure (9 m²) is a room; a 1.8×1.8 m one (3.24 m²) is not.
    // 5 cm cells (matching the production wall mask), outer 2-cell walls.
    const big = blank(64, 64); // 60×60 free = 3×3 m at 5 cm = 9 m²
    big.box(0, 0, 63, 1); big.box(0, 62, 63, 63); big.box(0, 0, 1, 63); big.box(62, 0, 63, 63);
    const resBig = detectRooms(toGrid(big.mask, 64, 64, 0.05), []);
    expect(resBig.rooms.length).toBe(1);
    expect(resBig.rooms[0].areaM2).toBeCloseTo(9.0, 1);

    const small = blank(40, 40); // 36×36 free = 1.8×1.8 m = 3.24 m² < 4 m²
    small.box(0, 0, 39, 1); small.box(0, 38, 39, 39); small.box(0, 0, 1, 39); small.box(38, 0, 39, 39);
    const resSmall = detectRooms(toGrid(small.mask, 40, 40, 0.05), []);
    expect(resSmall.rooms.length).toBe(0); // dropped, not "Room 1 · 3.2 m²"
  });
});

describe('detectRooms — coverage guard (open-space vs unsegmented)', () => {
  /**
   * A real-world sheet pathology, in miniature: a large open floor whose
   * boundary LEAKS to the grid border (one wall run missing), so the flood
   * classifies the whole interior as exterior and the only enclosed regions
   * are tiny pockets between wall fragments. With a real floor area supplied,
   * the guard must NOT report those pockets as a room schedule.
   *
   * 80×80 grid @ 0.05 m (4×4 m bbox = 16 m² floor). Outer walls, but the
   * RIGHT wall is missing (cols 78–79 left open) so the interior floods to
   * the border = exterior. Two tiny 6×6-cell sealed pockets (0.09 m² each)
   * are the only enclosed regions.
   */
  function leakyGrid(): OccupancyGrid {
    const { mask, box } = blank(80, 80);
    box(0, 0, 79, 1); box(0, 78, 79, 79); box(0, 0, 1, 79); // NO right wall
    // Two tiny sealed pockets near the top-left, fully walled (slivers).
    box(8, 8, 15, 8); box(8, 8, 8, 15); box(15, 8, 15, 15); box(8, 15, 15, 15);
    box(20, 8, 27, 8); box(20, 8, 20, 15); box(27, 8, 27, 15); box(20, 15, 27, 15);
    return toGrid(mask, 80, 80, 0.05);
  }

  it('leaking open plan + small pockets → NOT a room schedule (unsegmented)', () => {
    const floorAreaM2 = 16; // the scanned floor — pockets cover ~1% of it
    const res = detectRooms(leakyGrid(), [], floorAreaM2);
    expect(res.rooms.length).toBe(0); // no fake "Room 1..N"
    expect(res.segmentation).toBe('unsegmented');
    expect(res.roomCoverageFrac).toBeLessThan(ROOM_COVERAGE_MIN_FRAC);
  });

  it('without a floor area the guard is skipped (back-compat)', () => {
    // No floor area → pockets are still below the min-area floor, so they
    // drop anyway, but segmentation stays the default 'rooms' (no guard).
    const res = detectRooms(leakyGrid(), [], null);
    expect(res.segmentation).toBe('rooms');
  });

  it('one unpartitioned region covering most of the floor → open-space', () => {
    // 80×80 grid @ 5 cm, outer 2-cell walls → free interior is cols/rows
    // 2..77 = 76×76 cells = 5776 cells = 14.44 m² inside a 16 m² floor.
    // One connected region, no interior partition (no doorway, not ≥2 rooms):
    // FIX 1 reports it as a single OPEN SPACE, not "Room 1" of a schedule.
    const { mask, box } = blank(80, 80);
    box(0, 0, 79, 1); box(0, 78, 79, 79); box(0, 0, 1, 79); box(78, 0, 79, 79);
    const res = detectRooms(toGrid(mask, 80, 80, 0.05), [], 16);
    expect(res.rooms.length).toBe(0); // not numbered
    expect(res.segmentation).toBe('open-space');
    expect(res.dominantRegionAreaM2).toBeCloseTo(14.44, 2);
  });

  it('thresholds are ordered sanely (coverage floor < open-space floor)', () => {
    expect(ROOM_COVERAGE_MIN_FRAC).toBeGreaterThan(0);
    expect(ROOM_COVERAGE_MIN_FRAC).toBeLessThan(OPEN_SPACE_MIN_FRAC);
    expect(OPEN_SPACE_MIN_FRAC).toBeLessThan(1);
  });
});
