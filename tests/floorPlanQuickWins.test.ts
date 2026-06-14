/**
 * floorPlanQuickWins.test.ts — the v0.4.5 pre-release sheet wins (presentation
 * + threading over already-computed data; the wall-graph / room-segmentation
 * engine itself stays v0.4.6):
 *
 *   1. ARCHITECTURAL SHEET: near-black #111 poché, door-leaf swing arcs (one
 *      quarter-circle arc per CLASSIFIED doorway, radius = clear gap width),
 *      and a bottom-right title block (title / dims / area / scale / date).
 *   2. APPROXIMATE REGION AREAS: each floor-fill region's polygon area,
 *      labelled in-plan when ≥ 3 m² and the text fits, listed in the footer,
 *      and honestly called scanned-floor extents, not wall-measured rooms.
 *   3. WALL CONFIDENCE: per-ring observed fraction sampled against the
 *      PRE-CLOSE mask; rings under OBSERVED_FRAC_MIN render as yellow-tinted
 *      poché with a footer note.
 *   4. SNAP_MODE constant: 'auto' (default, gated) / 'off' / 'strong'
 *      (forced strongest axis when the auto gates fail).
 */

import { describe, it, expect } from 'vitest';
import {
  extractFloorPlan,
  ringObservedFraction,
  OBSERVED_FRAC_MIN,
  type FloorPlanModel,
} from '../src/terrain/space/floorplan/extractFloorPlan';
import {
  floorPlanSvg,
  MIN_ROOM_LABEL_M2,
  regionAreaReconcileScale,
} from '../src/terrain/space/floorplan/floorPlanSvg';
import {
  resolveSnapAxes,
  detectDominantAxes,
  ringSignedArea,
  SNAP_MODE,
  type Ring,
} from '../src/terrain/space/floorplan/vectorize';
import type { OccupancyGrid } from '../src/terrain/space/floorplan/occupancyGrid';

const STEP = 0.05;

/** A z-up 10 × 8 × 2.5 m room sampled at 5 cm, with optional south-wall door gaps. */
function rectRoom(doors: ReadonlyArray<readonly [number, number]> = []): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += STEP)
    for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
  const inDoor = (x: number): boolean =>
    doors.some(([a, b]) => x > a + 1e-9 && x < b - 1e-9);
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= W + 1e-9; x += STEP) {
      if (!inDoor(x)) t.push(x, 0, z); // south wall (door gaps)
      t.push(x, D, z); // north
    }
    for (let y = STEP; y < D - 1e-9; y += STEP) {
      t.push(0, y, z);
      t.push(W, y, z);
    }
  }
  return Float32Array.from(t);
}

/** A z-up 10 × 8 × 2.5 m two-room scan: divider plane at x = 5 with a door
 * gap `gapY` (metres). floor + four outer walls + divider sampled at 5 cm —
 * a genuinely PARTITIONED interior (FIX 1: yields two distinct rooms). */
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

/** Minimal model stub — only what floorPlanSvg reads. */
function stubModel(overrides: Partial<FloorPlanModel>): FloorPlanModel {
  return {
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
    wallThicknessM: 0.2,
    thicknessNormalized: false,
    widthM: 10,
    depthM: 4,
    bbox: [0, 0, 10, 4],
    cellSizeM: 0.05,
    floorAreaM2: null,
    usedWallBand: true,
    floorBasis: 'histogram',
    bandBasis: 'fixed',
    bandLowUsedM: 0.7,
    bandHighUsedM: 1.8,
    clippedCount: 0,
    clipBbox: null,
    snappedToAxes: true,
    reasons: [],
    ...overrides,
  };
}

/** Hand-built occupancy grid (0.1 m cells at the origin). */
function grid(mask: number[], cols: number, rows: number): OccupancyGrid {
  return {
    mask: Uint8Array.from(mask),
    cols,
    rows,
    cellX: 0.1,
    cellY: 0.1,
    originX: 0,
    originY: 0,
    threshold: 2,
  };
}

// ── 1. Door-leaf arcs + title block ─────────────────────────────────────────

describe('door-leaf arcs — one swing symbol per classified doorway', () => {
  const model = extractFloorPlan(rectRoom([[4.5, 5.5]]), { upAxis: 'z' });
  const svg = floorPlanSvg(model, { title: 'door room', unitSystem: 'metric' });

  it('the pipeline classified the 1 m gap as a doorway (precondition)', () => {
    expect(model.doorways.length).toBeGreaterThanOrEqual(1);
  });

  it('renders exactly one door-arc path per classified doorway', () => {
    const arcs = svg.match(/class="door-arc"/g) ?? [];
    expect(arcs.length).toBe(model.doorways.length);
    // Each symbol is leaf line + quarter arc: M …  L … A r r 0 0 s …
    const ds = [...svg.matchAll(/class="door-arc" d="M[^"]*L[^"]*A([\d.]+) ([\d.]+) 0 0 [01][^"]*"/g)];
    expect(ds.length).toBe(model.doorways.length);
  });

  it('the arc radius equals the doorway clear width at sheet scale', () => {
    // Recover the sheet scale from the scale bar (px / labelled metres).
    const bar = svg.match(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="6"/);
    const barLabel = svg.match(/>(\d+) m<\/text>/);
    const scale = Number(bar![1]) / Number(barLabel![1]);
    const arc = svg.match(/class="door-arc" d="M[^"]*A([\d.]+) /);
    expect(arc).not.toBeNull();
    const radiusM = Number(arc![1]) / scale;
    expect(radiusM).toBeCloseTo(model.doorways[0].widthM, 1);
  });

  it('draws two arcs for two doors', () => {
    const two = extractFloorPlan(rectRoom([[2.0, 3.0], [6.5, 7.5]]), { upAxis: 'z' });
    expect(two.doorways.length).toBe(2);
    const svg2 = floorPlanSvg(two, { unitSystem: 'metric' });
    expect((svg2.match(/class="door-arc"/g) ?? []).length).toBe(2);
  });

  it('no door symbols without classified doorways', () => {
    const plain = extractFloorPlan(rectRoom(), { upAxis: 'z' });
    expect(plain.doorways.length).toBe(0);
    expect(floorPlanSvg(plain, {})).not.toContain('door-arc');
  });

  it('renders the title block bottom-right with dims, area, scale, and date', () => {
    const dated = floorPlanSvg(model, {
      title: 'door room',
      unitSystem: 'metric',
      dateText: '2026-06-12',
    });
    expect(dated).toContain('class="title-block"');
    expect(dated).toMatch(/title-block[\s\S]*Overall 10\.0 m \(32\.8 ft\) x 8\.0 m \(26\.2 ft\)/);
    expect(dated).toMatch(/title-block[\s\S]*Floor area .*\(approx\.\)/);
    expect(dated).toMatch(/Scale ~1:\d+ \(nominal\) · bar 2 m/);
    expect(dated).toMatch(/2026-06-12 · Floor plan preview — not for construction/);
  });

  it('the honest empty sheet carries no title block', () => {
    const empty = extractFloorPlan(Float32Array.from([0, 0, 0, 1, 1, 1]), { upAxis: 'z' });
    expect(floorPlanSvg(empty, {})).not.toContain('title-block');
  });
});

// ── 2. Approximate region areas ─────────────────────────────────────────────

describe('region area labels — floor-fill polygon areas, honestly approximate', () => {
  const model = extractFloorPlan(rectRoom(), { upAxis: 'z' });
  // The v0.4.6 room segmentation supersedes the scanned-floor region labels
  // whenever real rooms exist; the region-label path is the 'unsegmented'
  // fallback (rooms could not be reliably separated). It is pinned via a model
  // with the rooms stripped AND the segmentation forced to 'unsegmented' (the
  // FIX-1 outcome that owns the approximate region-area labels). A single
  // open room like rectRoom() is itself reported as 'open-space' now, so the
  // stub must override the outcome to exercise the fallback path.
  const noRooms: FloorPlanModel = { ...model, rooms: [], roomSegmentation: 'unsegmented' };
  const svg = floorPlanSvg(noRooms, { unitSystem: 'metric' });

  it('labels each large floor region with its own polygon area (±2%)', () => {
    const big = model.floorRings.filter((r) => ringSignedArea(r) >= MIN_ROOM_LABEL_M2);
    expect(big.length).toBeGreaterThanOrEqual(1);
    const labels = [...svg.matchAll(/<text[^>]*>≈ ([\d.]+) m²<\/text>/g)].map((m) =>
      Number(m[1]),
    );
    expect(labels.length).toBeGreaterThanOrEqual(1);
    // Every printed label matches SOME region's polygon area within ±2%.
    for (const printed of labels) {
      const match = big.some(
        (r) => Math.abs(printed - ringSignedArea(r)) <= 0.02 * ringSignedArea(r),
      );
      expect(match).toBe(true);
    }
  });

  it('lists the per-region areas in the footer with the honesty wording', () => {
    expect(svg).toMatch(
      /Approx\. region areas \(scanned-floor extents, not wall-measured rooms\): [\d.]+ m²/,
    );
  });

  it('room labels supersede the region labels when rooms were segmented', () => {
    // FIX 1: a single open room like rectRoom() reads as 'open-space' now, so
    // the multi-room schedule is exercised with a genuinely PARTITIONED scan
    // (a divider + door → two distinct rooms). The room labels + schedule then
    // supersede the approximate region labels exactly as before.
    const twoRoom = extractFloorPlan(twoRoomCloud([3.5, 4.4]), { upAxis: 'z' });
    expect(twoRoom.roomSegmentation).toBe('rooms');
    expect(twoRoom.rooms.length).toBe(2); // the engine partitioned the space
    const withRooms = floorPlanSvg(twoRoom, { unitSystem: 'metric' });
    expect(withRooms).toContain('class="room-labels"');
    expect(withRooms).toMatch(/Room 1 · [\d.]+ m²/);
    expect(withRooms).not.toContain('≈ '); // no double labelling
    expect(withRooms).not.toMatch(/Approx\. region areas/);
    expect(withRooms).toMatch(/Room schedule \(flood-fill of the wall graph, approx\.\)/);
  });

  it('skips the in-plan label for regions under the 3 m² floor', () => {
    const tiny = stubModel({
      wallRings: [[[0, 0], [10, 0], [10, 4], [0, 4]]],
      wallRingObservedFrac: [1],
      // 1.5 × 1.5 m region (2.25 m² < 3 m²): footer yes, in-plan label no.
      floorRings: [[[1, 1], [2.5, 1], [2.5, 2.5], [1, 2.5]]],
    });
    const s = floorPlanSvg(tiny, { unitSystem: 'metric' });
    expect(s).not.toContain('class="room-areas"');
    expect(s).toMatch(/Approx\. region areas .*: 2\.3 m²/);
  });

  it('the region-area sum is reconciled to never exceed the stated floor area (v0.4.6)', () => {
    // Repro of the real 360 interior contradiction: the sheet said "Floor area
    // 94.4 m²" yet "Approx. region areas … 106.6 m²" — the region rings (from
    // the CLOSED, hole-healed, simplified floor mask) summed to MORE than the
    // net scanned floor area (the OPEN presence mask). Incoherent. Two
    // 60 m² floor rings (gross sum 120) reconciled against a 94.4 m² floor must
    // scale down so the footer sum equals the floor area, never exceeds it.
    const grossA = 60, grossB = 60, floor = 94.4;
    const ring = (a: number): Ring => {
      const s = Math.sqrt(a); // a square of the given area
      return [[0, 0], [s, 0], [s, s], [0, s]];
    };
    const model = stubModel({
      wallRings: [[[0, 0], [12, 0], [12, 12], [0, 12]]],
      wallRingObservedFrac: [1],
      floorRings: [ring(grossA), ring(grossB)],
      floorAreaM2: floor,
      roomSegmentation: 'unsegmented',
    });
    const svg = floorPlanSvg(model, { unitSystem: 'metric' });
    // Flatten wrapped <text> spans, then take the region-areas clause up to the
    // terminating ". " (a region value like "47.2 m²" contains a '.', so the
    // clause must end at the period-then-space, not the first period).
    const flat = svg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const footer = flat.match(/Approx\. region areas[^:]*: (.*?)\. /)?.[1] ?? '';
    const sum = [...footer.matchAll(/([\d.]+) m²/g)].reduce((acc, m) => acc + Number(m[1]), 0);
    expect(sum).toBeGreaterThan(0);
    // The reconciled region sum must be ≤ the headline floor area (with a tiny
    // rounding tolerance), not the un-reconciled 120 m².
    expect(sum).toBeLessThanOrEqual(floor + 0.2);
    // The reconcile is proportional (not a clamp-to-zero): both regions survive.
    expect([...footer.matchAll(/m²/g)].length).toBe(2);

    // Pure helper contract: scale ≤ 1, makes the sum equal the floor area, and
    // never scales UP when the raw sum already fits.
    expect(regionAreaReconcileScale([grossA, grossB], floor)).toBeCloseTo(floor / 120, 5);
    expect(regionAreaReconcileScale([10, 20], 94.4)).toBe(1); // already fits → no scaling
    expect(regionAreaReconcileScale([10], null)).toBe(1); // no floor area → no scaling
  });

  it('uses sq ft labels under the imperial unit system', () => {
    const imp = floorPlanSvg(noRooms, { unitSystem: 'imperial' });
    expect(imp).toMatch(/≈ \d+ sq ft</);
    expect(imp).toMatch(/Approx\. region areas .*: \d+ sq ft/);
    // Room labels and the schedule follow the unit system too (partitioned
    // scan — FIX 1: a single open room reads as 'open-space' instead).
    const impRooms = floorPlanSvg(extractFloorPlan(twoRoomCloud([3.5, 4.4]), { upAxis: 'z' }), {
      unitSystem: 'imperial',
    });
    expect(impRooms).toMatch(/Room 1 · \d+ sq ft/);
    expect(impRooms).toMatch(/Room schedule .*Room 1 \d+ sq ft/);
  });
});

// ── 3. Wall confidence (observed fraction vs the pre-close mask) ───────────

describe('ringObservedFraction — outline support in the pre-close mask', () => {
  // A 2 m × 0.2 m wall strip (20 × 2 cells at 0.1 m); the ring outlines it.
  const strip: Ring = [[0, 0], [2, 0], [2, 0.2], [0, 0.2]];
  const full = (): number[] => Array(40).fill(1);

  it('a fully observed outline reads 1', () => {
    expect(ringObservedFraction(strip, grid(full(), 20, 2))).toBe(1);
  });

  it('a closing-bridged gap lowers the fraction (gap cells unobserved)', () => {
    const m = full();
    for (const r of [0, 1]) for (let c = 8; c <= 11; c++) m[r * 20 + c] = 0;
    const f = ringObservedFraction(strip, grid(m, 20, 2));
    expect(f).toBeLessThan(1);
    expect(f).toBeGreaterThan(0.8); // a small healed dropout stays confident
  });

  it('a mostly-interpolated ring falls under the 60% threshold', () => {
    const m = Array(40).fill(0);
    for (const r of [0, 1]) for (let c = 0; c <= 3; c++) m[r * 20 + c] = 1;
    const f = ringObservedFraction(strip, grid(m, 20, 2));
    expect(f).toBeLessThan(OBSERVED_FRAC_MIN);
    expect(OBSERVED_FRAC_MIN).toBe(0.6);
  });

  it('the real pipeline threads per-ring fractions aligned with wallRings', () => {
    const model = extractFloorPlan(rectRoom(), { upAxis: 'z' });
    expect(model.wallRingObservedFrac.length).toBe(model.wallRings.length);
    // A cleanly sampled synthetic room is solidly observed.
    expect(Math.max(...model.wallRingObservedFrac)).toBeGreaterThan(OBSERVED_FRAC_MIN);
    for (const f of model.wallRingObservedFrac) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

describe('wall confidence styling — tinted poché under the threshold', () => {
  const rings: Ring[] = [
    [[0, 0], [4, 0], [4, 4], [0, 4]],
    [[6, 0], [10, 0], [10, 4], [6, 4]],
  ];

  it('rings under the threshold render as the yellow-tinted poché + note', () => {
    const svg = floorPlanSvg(
      stubModel({ wallRings: rings, wallRingObservedFrac: [0.95, 0.3] }),
      { unitSystem: 'metric' },
    );
    expect(svg).toContain('class="wall-weak"');
    expect(svg).toContain('class="wall-poche"');
    expect(svg).toMatch(/Tinted walls: interpolated from sparse evidence/);
    expect(svg).toMatch(/under 60% of their outline/);
  });

  it('fully observed plans render one ink poché and no tint note', () => {
    const svg = floorPlanSvg(
      stubModel({ wallRings: rings, wallRingObservedFrac: [0.95, 0.85] }),
      { unitSystem: 'metric' },
    );
    expect(svg).not.toContain('wall-weak');
    expect(svg).not.toMatch(/Tinted walls/);
    expect(svg).toContain('class="wall-poche"');
  });

  it('exactly at the threshold counts as observed (strict <)', () => {
    const svg = floorPlanSvg(
      stubModel({ wallRings: rings, wallRingObservedFrac: [OBSERVED_FRAC_MIN, 1] }),
      { unitSystem: 'metric' },
    );
    expect(svg).not.toContain('wall-weak');
  });

  it('a hole ring follows its weak outer so the poché stays punched', () => {
    const withHole = stubModel({
      wallRings: [
        [[0, 0], [4, 0], [4, 4], [0, 4]], // weak outer (CCW)
        [[1, 1], [1, 3], [3, 3], [3, 1]], // its hole (CW)
      ],
      wallRingObservedFrac: [0.3, 1],
    });
    const svg = floorPlanSvg(withHole, { unitSystem: 'metric' });
    const weak = svg.match(/class="wall-weak" d="([^"]+)"/);
    expect(weak).not.toBeNull();
    // Both subpaths (outer + hole) live in the weak path: 2 closed loops.
    expect((weak![1].match(/Z/g) ?? []).length).toBe(2);
    expect(svg).not.toContain('class="wall-poche"');
  });
});

// ── 4. SNAP_MODE ────────────────────────────────────────────────────────────

describe('SNAP_MODE — auto | off | strong', () => {
  const rect: Ring = [[0, 0], [10, 0], [10, 8], [0, 8]];
  const oct: Ring = Array.from({ length: 8 }, (_, k) => {
    const a = (Math.PI / 4) * k + Math.PI / 8;
    return [Math.cos(a) * 5, Math.sin(a) * 5] as const;
  });

  it('ships with auto as the documented default', () => {
    expect(SNAP_MODE).toBe('auto');
  });

  it('auto mirrors detectDominantAxes (gated)', () => {
    const onRect = resolveSnapAxes([rect], 'auto');
    expect(onRect.axes).not.toBeNull();
    expect(onRect.forced).toBe(false);
    expect(onRect.axes!.thetaRad).toBeCloseTo(detectDominantAxes([rect])!.thetaRad, 10);
    const onOct = resolveSnapAxes([oct], 'auto');
    expect(onOct.axes).toBeNull(); // no Manhattan assumption on the octagon
  });

  it('off never snaps, even on a perfect rectangle', () => {
    const res = resolveSnapAxes([rect], 'off');
    expect(res.axes).toBeNull();
    expect(res.mode).toBe('off');
  });

  it('strong falls back to the forced strongest axis when auto declines', () => {
    const res = resolveSnapAxes([oct], 'strong');
    expect(res.axes).not.toBeNull();
    expect(res.forced).toBe(true);
    expect(res.axes!.thetaRad).toBeGreaterThanOrEqual(0);
    expect(res.axes!.thetaRad).toBeLessThan(Math.PI);
  });

  it('strong defers to the auto result when the gates pass (not forced)', () => {
    const res = resolveSnapAxes([rect], 'strong');
    expect(res.forced).toBe(false);
    expect(res.axes!.thetaRad).toBeCloseTo(detectDominantAxes([rect])!.thetaRad, 10);
  });

  it('degenerate input resolves to null in every mode', () => {
    for (const mode of ['auto', 'off', 'strong'] as const) {
      expect(resolveSnapAxes([], mode).axes).toBeNull();
    }
  });
});
