/**
 * floorPlanPipeline.test.ts
 *
 * End-to-end floor-plan extraction on synthetic rooms with hand-computed
 * truth: a 10 × 8 m rectangular room with a 1 m door gap (walls within 5 cm
 * + one mask cell, the door preserved, floor area within ±2%), an L-shaped
 * room (inner corner found, L area), 50% wall dropout (morphology still
 * closes the walls), the no-floor full-height fallback, and the honest empty
 * result for degenerate input. Plus the architectural SVG sheet: wall poché,
 * unit-system-aware dimensions and scale bar, local-frame note, suitability
 * caveat, XML escaping.
 */

import { describe, it, expect } from 'vitest';
import { extractFloorPlan, type FloorPlanModel } from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg, escapeXml } from '../src/terrain/space/floorplan/floorPlanSvg';

const STEP = 0.05;

/** Deterministic LCG in [0, 1) for reproducible dropout / noise. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface RoomOpts {
  /** Door gap on the south wall (y = 0): open interval in x, full height. */
  readonly door?: readonly [number, number];
  /** Keep probability for WALL points (floor stays complete). Default 1. */
  readonly wallKeep?: number;
  readonly withFloor?: boolean;
  readonly withCeiling?: boolean;
}

/** A z-up 10 × 8 × 2.5 m room sampled at 5 cm. */
function rectRoom(opts: RoomOpts = {}): Float32Array {
  const W = 10, D = 8, H = 2.5;
  const keep = opts.wallKeep ?? 1;
  const rnd = lcg(42);
  const t: number[] = [];
  if (opts.withFloor !== false) {
    for (let x = 0; x <= W + 1e-9; x += STEP)
      for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
  }
  if (opts.withCeiling === true) {
    for (let x = 0; x <= W + 1e-9; x += STEP)
      for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, H);
  }
  const wall = (x: number, y: number, z: number): void => {
    if (keep >= 1 || rnd() < keep) t.push(x, y, z);
  };
  const [doorFrom, doorTo] = opts.door ?? [Infinity, Infinity];
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= W + 1e-9; x += STEP) {
      if (!(x > doorFrom + 1e-9 && x < doorTo - 1e-9)) wall(x, 0, z); // south (door)
      wall(x, D, z); // north
    }
    for (let y = STEP; y < D - 1e-9; y += STEP) {
      wall(0, y, z); // west
      wall(W, y, z); // east
    }
  }
  return Float32Array.from(t);
}

/** An L-shaped room: 10 × 8 outline minus the [6,10] × [5,8] notch. */
function lRoom(): Float32Array {
  const H = 2.5;
  const t: number[] = [];
  const inL = (x: number, y: number): boolean => y <= 5 + 1e-9 || x <= 6 + 1e-9;
  for (let x = 0; x <= 10 + 1e-9; x += STEP)
    for (let y = 0; y <= 8 + 1e-9; y += STEP) {
      if (inL(x, y)) t.push(x, y, 0);
    }
  // Perimeter wall segments of the L (axis-aligned runs).
  const runs: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0, 10, 0],  // south
    [10, 0, 10, 5], // east (short)
    [6, 5, 10, 5],  // notch south edge
    [6, 5, 6, 8],   // notch west edge
    [0, 8, 6, 8],   // north (short)
    [0, 0, 0, 8],   // west
  ];
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (const [x1, y1, x2, y2] of runs) {
      const len = Math.hypot(x2 - x1, y2 - y1);
      const n = Math.round(len / STEP);
      for (let k = 0; k <= n; k++) {
        t.push(x1 + ((x2 - x1) * k) / n, y1 + ((y2 - y1) * k) / n, z);
      }
    }
  }
  return Float32Array.from(t);
}

/** Min distance from a point to any segment of any wall ring. */
function distToRings(p: readonly [number, number], model: FloorPlanModel): number {
  let best = Infinity;
  for (const ring of model.wallRings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
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

describe('extractFloorPlan — rectangular room with a 1 m door', () => {
  const model = extractFloorPlan(rectRoom({ door: [4.5, 5.5] }), { upAxis: 'z' });

  it('uses the wall band and snaps to the two dominant axes', () => {
    expect(model.usedWallBand).toBe(true);
    expect(model.snappedToAxes).toBe(true);
    expect(model.wallRings.length).toBeGreaterThanOrEqual(1);
  });

  it('reproduces the room extents', () => {
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.1);
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.1);
  });

  it('places every long wall segment within 5 cm + one cell of a true wall plane', () => {
    // Wall strips are one mask cell (~5 cm) thick: both strip edges must hug
    // one of the four wall planes x ∈ {0, 10} / y ∈ {0, 8}. Short segments
    // (door jambs, strip end caps) are excluded — they run ACROSS the strip.
    let checked = 0;
    for (const ring of model.wallRings) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.5) continue;
        checked++;
        const off = Math.min(
          ...[a, b].map((p) =>
            Math.min(
              Math.abs(p[0]), Math.abs(p[0] - 10),
              Math.abs(p[1]), Math.abs(p[1] - 8),
            ),
          ),
        );
        expect(off).toBeLessThanOrEqual(0.06);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8); // outer + inner edge of 4 walls
  });

  it('keeps the 1 m door open', () => {
    // No wall geometry may come near the door's midpoint: the closing radius
    // is capped (keepOpenM / 3) so a 1 m gap can never be bridged.
    expect(distToRings([5.0, 0.025], model)).toBeGreaterThan(0.3);
    // The jambs themselves exist: wall geometry close to both door edges.
    expect(distToRings([4.45, 0.025], model)).toBeLessThan(0.15);
    expect(distToRings([5.55, 0.025], model)).toBeLessThan(0.15);
  });

  it('measures the scanned floor area within ±2%', () => {
    expect(model.floorAreaM2).not.toBeNull();
    expect(model.floorAreaM2 as number).toBeGreaterThan(80 * 0.98);
    expect(model.floorAreaM2 as number).toBeLessThan(80 * 1.02);
    expect(model.floorRings.length).toBeGreaterThanOrEqual(1);
  });

  it('carries the honest basis + suitability caveats', () => {
    const all = model.reasons.join(' ');
    expect(all).toMatch(/0\.7–1\.8 m above the detected floor/);
    expect(all).toMatch(/snapped to the two dominant perpendicular axes/);
    expect(all).toMatch(/not for construction, survey, or legal use/);
  });
});

describe('extractFloorPlan — L-shaped room', () => {
  const model = extractFloorPlan(lRoom(), { upAxis: 'z' });

  it('traces the L outline including the inner (reflex) corner', () => {
    expect(model.wallRings.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.1);
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.1);
    // Some wall vertex sits at the notch corner (6, 5) — the L is real,
    // not a convex-hull-style blob.
    let bestCorner = Infinity;
    for (const ring of model.wallRings) {
      for (const [x, y] of ring) {
        bestCorner = Math.min(bestCorner, Math.hypot(x - 6, y - 5));
      }
    }
    expect(bestCorner).toBeLessThan(0.15);
  });

  it('measures the L floor area (68 m²) within ±2%', () => {
    expect(model.floorAreaM2 as number).toBeGreaterThan(68 * 0.98);
    expect(model.floorAreaM2 as number).toBeLessThan(68 * 1.02);
  });

  it('keeps the notch interior wall-free', () => {
    // The notch centre (8, 6.5) is OUTSIDE the room — at least 1 m from any
    // wall (the nearest walls are the notch edges at y=5 / x=6... 1.5 m off).
    expect(distToRings([8, 6.5], model)).toBeGreaterThan(1);
  });
});

describe('extractFloorPlan — robustness and fallbacks', () => {
  it('survives 50% wall dropout (morphology closes the scan gaps)', () => {
    const model = extractFloorPlan(rectRoom({ wallKeep: 0.5 }), { upAxis: 'z' });
    expect(model.wallRings.length).toBeGreaterThanOrEqual(1);
    // Walk each wall plane: every probe must still find wall geometry nearby
    // — the dropped-out cells were healed by the morphological close.
    let probes = 0, hits = 0;
    for (let x = 0.5; x <= 9.5; x += 0.25) {
      for (const y of [0, 8]) {
        probes++;
        if (distToRings([x, y], model) < 0.15) hits++;
      }
    }
    for (let y = 0.5; y <= 7.5; y += 0.25) {
      for (const x of [0, 10]) {
        probes++;
        if (distToRings([x, y], model) < 0.15) hits++;
      }
    }
    expect(hits / probes).toBeGreaterThanOrEqual(0.95);
  });

  it('anchors the band on a robust low percentile when no floor plane exists', () => {
    // Walls-only capture (no floor): the dominant-peak rule finds no floor —
    // pre-fix this fell back to FULL HEIGHT. Now the lowest dense returns
    // (the 5th percentile of z ≈ the wall bottoms at ~0.125 m) anchor the
    // band, so the walls are still traced from a clean wall-height slice.
    // The floor FILL stays off — a percentile anchor never claims a floor.
    const model = extractFloorPlan(rectRoom({ withFloor: false }), { upAxis: 'z' });
    expect(model.usedWallBand).toBe(true);
    expect(model.floorBasis).toBe('percentile');
    expect(model.floorAreaM2).toBeNull();
    expect(model.floorRings.length).toBe(0);
    expect(model.wallRings.length).toBeGreaterThanOrEqual(1);
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.2);
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.2);
    expect(model.reasons.join(' ')).toMatch(/No dominant floor plane/);
    expect(model.reasons.join(' ')).toMatch(/lowest dense returns/);
  });

  it('retries a widened band before surrendering to full height', () => {
    // Floor + stub walls only 0.55 m tall: the standard 0.7–1.8 m band is
    // empty, but the widened 0.4–2.4 m band catches the wall tops (z 0.4–
    // 0.55), so the plan still comes from a wall slice, not a full-height
    // smear of the floor.
    const t: number[] = [];
    for (let x = 0; x <= 10 + 1e-9; x += STEP)
      for (let y = 0; y <= 8 + 1e-9; y += STEP) t.push(x, y, 0);
    for (let z = 0; z <= 0.55 + 1e-9; z += STEP) {
      for (let x = 0; x <= 10 + 1e-9; x += STEP) { t.push(x, 0, z); t.push(x, 8, z); }
      for (let y = STEP; y < 8 - 1e-9; y += STEP) { t.push(0, y, z); t.push(10, y, z); }
    }
    const model = extractFloorPlan(Float32Array.from(t), { upAxis: 'z' });
    expect(model.usedWallBand).toBe(true);
    expect(model.floorBasis).toBe('histogram');
    expect(model.reasons.join(' ')).toMatch(/0\.4–2\.4 m/);
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.2);
  });

  it('falls back to full height only when even the widened band is empty', () => {
    // Floor-only capture (nothing above 0.15 m): no band can be cut at all.
    const t: number[] = [];
    for (let x = 0; x <= 10 + 1e-9; x += STEP)
      for (let y = 0; y <= 8 + 1e-9; y += STEP) t.push(x, y, 0);
    const model = extractFloorPlan(Float32Array.from(t), { upAxis: 'z' });
    expect(model.usedWallBand).toBe(false);
    expect(model.floorBasis).toBe('none');
    expect(model.reasons.join(' ')).toMatch(/full-height point density/);
  });

  it('returns an honest empty model below the point floor (no fabrication)', () => {
    const rnd = lcg(7);
    const t: number[] = [];
    for (let i = 0; i < 150; i++) t.push(rnd() * 10, rnd() * 8, rnd() * 2.5);
    const model = extractFloorPlan(Float32Array.from(t), { upAxis: 'z' });
    expect(model.wallRings.length).toBe(0);
    expect(model.floorRings.length).toBe(0);
    expect(model.floorAreaM2).toBeNull();
    expect(model.widthM).toBe(0);
    expect(model.reasons[0]).toMatch(/Too few points/);
  });

  it('plumbs the v0.4.6 options: bandBasis surfaced, snapMode off respected', () => {
    // A high-clerestory room (walls only 2.0–3.2 m) extracted with the adaptive
    // band ON exposes an adaptive bandBasis and the honest re-centre note; the
    // same scan with snapMode 'off' must report axis snapping disabled.
    const W = 6, D = 4;
    const t: number[] = [];
    for (let x = 0; x <= W + 1e-9; x += STEP)
      for (let y = 0; y <= D + 1e-9; y += STEP) t.push(x, y, 0);
    for (let z = 2.0; z <= 3.2 + 1e-9; z += STEP) {
      for (let x = 0; x <= W + 1e-9; x += STEP) { t.push(x, 0, z); t.push(x, D, z); }
      for (let y = STEP; y < D - 1e-9; y += STEP) { t.push(0, y, z); t.push(W, y, z); }
    }
    const cloud = Float32Array.from(t);
    const adapt = extractFloorPlan(cloud, { upAxis: 'z', adaptiveBand: true });
    expect(adapt.bandBasis).toBe('adaptive');
    expect(adapt.bandLowUsedM).toBeGreaterThanOrEqual(1.5);
    expect(adapt.reasons.join(' ')).toMatch(/re-centred on the densest wall-return height/);

    const noSnap = extractFloorPlan(cloud, { upAxis: 'z', snapMode: 'off' });
    expect(noSnap.snappedToAxes).toBe(false);
    expect(noSnap.reasons.join(' ')).toMatch(/Axis snapping disabled \(SNAP_MODE off\)/);

    // adaptiveBand:false pins the fixed band wording (no re-centre note).
    const fixed = extractFloorPlan(cloud, { upAxis: 'z', adaptiveBand: false });
    expect(fixed.bandBasis).toBe('fixed');
    expect(fixed.reasons.join(' ')).not.toMatch(/re-centred on the densest/);
  });
});

// ── v0.4.5 hardening: the real-scan failure modes (multi-room 360 interior,
// sparse strided gather, scanner noise arms) reproduced synthetically with
// hand-computed truth. ──

/**
 * Two 5 × 8 m rooms separated by the sealed wall x = 5, fully enclosed.
 * Full floors, walls 2.5 m, 5 cm sampling — a minimal multi-room interior
 * whose two interiors are DISJOINT empty regions (two hole loops). Any open
 * door would merge a room's interior with its neighbour (or the outside),
 * which is correct topology but hides the failure this test exists to catch:
 * a "keep only the largest loop" pipeline silently dropping a room. (Door
 * preservation is pinned by the rectangular-room suite above.)
 */
function twoRooms(): Float32Array {
  const H = 2.5;
  const t: number[] = [];
  for (let x = 0; x <= 10 + 1e-9; x += STEP)
    for (let y = 0; y <= 8 + 1e-9; y += STEP) t.push(x, y, 0);
  for (let z = 0; z <= H + 1e-9; z += STEP) {
    for (let x = 0; x <= 10 + 1e-9; x += STEP) { t.push(x, 0, z); t.push(x, 8, z); }
    for (let y = STEP; y < 8 - 1e-9; y += STEP) {
      t.push(0, y, z);
      t.push(10, y, z);
      t.push(5, y, z); // sealed shared wall
    }
  }
  return Float32Array.from(t);
}

describe('extractFloorPlan — multi-room interior', () => {
  const model = extractFloorPlan(twoRooms(), { upAxis: 'z' });

  it('keeps EVERY loop above the speckle floor — both room interiors survive', () => {
    // One connected wall mask ⇒ one outer boundary + one hole PER ROOM:
    // at least three rings. A largest-loop-only pipeline would drop a room.
    expect(model.wallRings.length).toBeGreaterThanOrEqual(3);
    // Exactly two of the loops are holes (CW, negative signed area in the
    // y-up frame): the two disjoint room interiors.
    const holes = model.wallRings.filter((r) => {
      let a = 0;
      for (let i = 0; i < r.length; i++) {
        const [x1, y1] = r[i];
        const [x2, y2] = r[(i + 1) % r.length];
        a += x1 * y2 - x2 * y1;
      }
      return a < 0;
    });
    expect(holes.length).toBe(2);
  });

  it('traces the shared wall and both far walls', () => {
    expect(distToRings([5, 2], model)).toBeLessThan(0.15); // shared wall
    expect(distToRings([0, 4], model)).toBeLessThan(0.15); // room A far wall
    expect(distToRings([10, 4], model)).toBeLessThan(0.15); // room B far wall
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.1);
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.1);
  });

  it('keeps both room interiors wall-free', () => {
    expect(distToRings([2.5, 4], model)).toBeGreaterThan(1); // room A interior
    expect(distToRings([7.5, 4], model)).toBeGreaterThan(1); // room B interior
  });
});

describe('extractFloorPlan — sparse strided gather (the 360 multi-room case)', () => {
  // Walls thinned to 4% keep — the wall band holds ~650 points over a 36 m
  // perimeter (≈ 18 returns/m), the regime of a 58 k routing gather over a
  // multi-room scan. At the old fixed ≤ 5 cm cell that is ~1 return per wall
  // cell: the ≥ 2 density threshold starved the mask into speckle and the
  // plan fragmented. The cell must GROW to carry the threshold.
  const model = extractFloorPlan(rectRoom({ wallKeep: 0.04 }), { upAxis: 'z' });

  it('grows the mask cell beyond 5 cm instead of fragmenting', () => {
    expect(model.wallRings.length).toBeGreaterThanOrEqual(1);
    expect(model.cellSizeM).toBeGreaterThan(0.05);
    expect(model.cellSizeM).toBeLessThanOrEqual(0.3);
  });

  it('still reproduces the room extents (coarser, but not fragmented)', () => {
    expect(model.usedWallBand).toBe(true);
    expect(Math.abs(model.widthM - 10)).toBeLessThan(0.5);
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.5);
  });

  it('keeps most of each wall traceable at the coarser cell', () => {
    let probes = 0, hits = 0;
    for (let x = 0.5; x <= 9.5; x += 0.5) {
      for (const y of [0, 8]) { probes++; if (distToRings([x, y], model) < 0.3) hits++; }
    }
    for (let y = 0.5; y <= 7.5; y += 0.5) {
      for (const x of [0, 10]) { probes++; if (distToRings([x, y], model) < 0.3) hits++; }
    }
    expect(hits / probes).toBeGreaterThanOrEqual(0.85);
  });
});

describe('extractFloorPlan — 360 noise arm (outlier tail)', () => {
  // A dense 10 × 8 room plus a sparse 20 m arm of stray returns trailing
  // east — the classic 360-scanner tail. Pre-fix the arm inflated the slice
  // bbox (an observed sheet claimed 14 × 25 m for a ~14 × 10 m interior).
  function roomWithArm(): Float32Array {
    const base = rectRoom({});
    const rnd = lcg(1234);
    const t = Array.from(base);
    for (let i = 0; i < 250; i++) {
      const x = 10.2 + rnd() * 19.8; // 10.2 .. 30 m
      const y = 3.5 + rnd();         // thin arm around y ≈ 4
      const z = rnd() * 2.5;
      t.push(x, y, z);
    }
    return Float32Array.from(t);
  }
  const model = extractFloorPlan(roomWithArm(), { upAxis: 'z' });

  it('clips the arm: the plan extents are the ROOM, not the tail', () => {
    expect(model.widthM).toBeLessThan(11);
    expect(model.bbox[2]).toBeLessThan(11); // maxX — the arm reached 30 m
    expect(Math.abs(model.depthM - 8)).toBeLessThan(0.5);
  });

  it('reports the excluded strays honestly', () => {
    expect(model.clippedCount).toBeGreaterThan(150);
    expect(model.reasons.join(' ')).toMatch(/outside the dense footprint/);
  });

  it('still traces the room walls normally', () => {
    expect(model.usedWallBand).toBe(true);
    expect(distToRings([0, 4], model)).toBeLessThan(0.15);
    expect(distToRings([10, 4], model)).toBeLessThan(0.15);
  });
});

describe('floorPlanSvg', () => {
  const model = extractFloorPlan(rectRoom({ door: [4.5, 5.5] }), { upAxis: 'z' });

  it('renders the architectural sheet with metric-first labels', () => {
    const svg = floorPlanSvg(model, { title: 'My Room', unitSystem: 'metric' });
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('My Room');
    // Wall poché (near-black architectural ink) + floor fill paths.
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('fill="#f1f3f6"');
    // Metric primary, imperial in parentheses; metre scale bar (10/4 → 2 m).
    expect(svg).toContain('Overall 10.0 m (32.8 ft)');
    expect(svg).toContain('8.0 m (26.2 ft)');
    expect(svg).toContain('>2 m</text>');
    expect(svg).toMatch(/local scan frame — not aligned to true north/);
    expect(svg).toMatch(/not for construction, survey, or legal use/);
  });

  it('flips to imperial-first labels and a feet scale bar', () => {
    const svg = floorPlanSvg(model, { unitSystem: 'imperial' });
    expect(svg).toContain('Overall 32.8 ft (10.0 m)');
    expect(svg).toContain('26.2 ft (8.0 m)');
    expect(svg).toContain('>5 ft</text>');
  });

  it('XML-escapes the title', () => {
    const svg = floorPlanSvg(model, { title: 'A & B <bad> "x"' });
    expect(svg).toContain('A &amp; B &lt;bad&gt; &quot;x&quot;');
    expect(svg).not.toContain('<bad>');
  });

  it('states the empty case instead of drawing a fake plan', () => {
    const empty = extractFloorPlan(Float32Array.from([0, 0, 0, 1, 1, 1]), { upAxis: 'z' });
    const svg = floorPlanSvg(empty, { title: 'Empty' });
    expect(svg).toContain('No wall structure could be traced');
    expect(svg).toMatch(/Too few points/);
    // No fabricated figures on the empty sheet: the "Overall W x D" dims line
    // and the scale bar (which would read a nonsense "2e-7 m" off the
    // degenerate-bbox guard) must be absent when no walls were traced.
    expect(svg).not.toContain('Overall');
    expect(svg).not.toMatch(/e-\d+ m</);
    expect(svg).not.toContain('height="6"'); // the scale-bar rect
  });

  it('escapeXml handles the metacharacters', () => {
    expect(escapeXml('<a>&"\'')).toBe('&lt;a&gt;&amp;&quot;&#39;');
  });
});
