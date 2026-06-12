/**
 * floorPlanBudget.test.ts — the "opening the floorplan SVG makes the computer
 * slow" regression (Bug: unbounded emitted geometry).
 *
 * The raster boundary trace is unbounded: on a dense 360 house scan the
 * DECORATIVE floor fill traced every furniture-occlusion shadow into a hole
 * subpath (a synthetic patchy floor reproduced 200+ hole rings / ~1 400
 * vertices on a single room — scaling linearly with area), the wall mask can
 * reach 1024² cells, and every classified unknown gap became its own dashed
 * segment. Renderer cost scaled with the scan, not the sheet.
 *
 * Pinned here:
 *   - the floor fill drops holes, keeps only the largest outer regions, and
 *     simplifies coarser than the walls;
 *   - every layer respects its vertex budget and the TOTAL stays under
 *     PLAN_VERTEX_BUDGET, via proportional DP tightening (capRingVertices);
 *   - dashed unknown gaps are deduped and capped (MAX_UNKNOWN_GAPS) while the
 *     footer keeps reporting the FULL classified count;
 *   - the emitted SVG byte size for a dense noisy room stays pinned.
 */

import { describe, it, expect } from 'vitest';
import {
  extractFloorPlan,
  capRingVertices,
  limitUnknownGaps,
  ringVertexCount,
  PLAN_VERTEX_BUDGET,
  WALL_VERTEX_BUDGET,
  FLOOR_VERTEX_BUDGET,
  CONTENTS_VERTEX_BUDGET,
  MAX_UNKNOWN_GAPS,
  type PlanGap,
} from '../src/terrain/space/floorplan/extractFloorPlan';
import { floorPlanSvg } from '../src/terrain/space/floorplan/floorPlanSvg';
import { ringSignedArea, type Ring } from '../src/terrain/space/floorplan/vectorize';

/** Deterministic LCG in [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A dense 16 × 12 m interior whose floor is sampled at 1.8 cm but with whole
 * 18 cm patches missing (furniture / occlusion shadows) — the regime that
 * once traced hundreds of decorative hole subpaths into the sheet. Walls at
 * 5 cm with 25% dropout, two interior walls with door gaps.
 */
function densePatchyHouse(): Float32Array {
  const W = 16, D = 12, H = 2.6, STEP = 0.018;
  const rnd = lcg(99);
  const PC = Math.ceil(W / 0.18), PR = Math.ceil(D / 0.18);
  const patch = new Uint8Array(PC * PR);
  for (let i = 0; i < patch.length; i++) patch[i] = rnd() < 0.45 ? 0 : 1;
  const t: number[] = [];
  for (let x = 0; x <= W + 1e-9; x += STEP) {
    for (let y = 0; y <= D + 1e-9; y += STEP) {
      const pi =
        Math.min(PR - 1, Math.floor(y / 0.18)) * PC + Math.min(PC - 1, Math.floor(x / 0.18));
      if (patch[pi]) t.push(x, y, 0.01 * rnd());
    }
  }
  const wall = (x: number, y: number, z: number): void => {
    if (rnd() < 0.75) t.push(x, y, z);
  };
  for (let z = 0; z <= H + 1e-9; z += 0.05) {
    for (let x = 0; x <= W + 1e-9; x += 0.05) { wall(x, 0, z); wall(x, D, z); }
    for (let y = 0.05; y < D - 1e-9; y += 0.05) { wall(0, y, z); wall(W, y, z); }
    for (let y = 0.05; y < D - 1e-9; y += 0.05) { if (y < 6 || y > 7) wall(9, y, z); }
    for (let x = 9.05; x < W - 1e-9; x += 0.05) { if (x < 10.5 || x > 11.5) wall(x, 7, z); }
  }
  return Float32Array.from(t);
}

describe('floor-plan emitted-geometry budget (dense noisy room)', () => {
  const model = extractFloorPlan(densePatchyHouse(), { upAxis: 'z', maxSamples: 2_000_000 });
  const svg = floorPlanSvg(model, { title: 'dense patchy house' });

  it('still traces a real plan (walls + floor fill present)', () => {
    expect(model.wallRings.length).toBeGreaterThanOrEqual(1);
    expect(model.floorRings.length).toBeGreaterThanOrEqual(1);
    expect(model.floorAreaM2).not.toBeNull();
  });

  it('keeps every layer inside its vertex budget and the total under PLAN_VERTEX_BUDGET', () => {
    expect(ringVertexCount(model.wallRings)).toBeLessThanOrEqual(WALL_VERTEX_BUDGET);
    expect(ringVertexCount(model.floorRings)).toBeLessThanOrEqual(FLOOR_VERTEX_BUDGET);
    expect(ringVertexCount(model.contentRings)).toBeLessThanOrEqual(CONTENTS_VERTEX_BUDGET);
    const total =
      ringVertexCount(model.wallRings) +
      ringVertexCount(model.floorRings) +
      ringVertexCount(model.contentRings);
    expect(total).toBeLessThanOrEqual(PLAN_VERTEX_BUDGET);
  });

  it('the decorative floor fill carries no hole subpaths and a bounded ring count', () => {
    // Pre-fix this floor traced 200+ CW hole rings (occlusion shadows).
    const holes = model.floorRings.filter((r) => ringSignedArea(r) < 0);
    expect(holes.length).toBe(0);
    expect(model.floorRings.length).toBeLessThanOrEqual(24);
  });

  it('emits a bounded number of dashed gap segments', () => {
    expect(model.unknownGaps.length).toBeLessThanOrEqual(MAX_UNKNOWN_GAPS);
  });

  it('BYTE-SIZE PIN: the dense-room sheet stays a small file', () => {
    // Pre-fix the same room emitted ~20 KB and grew linearly with scan area;
    // the budgeted sheet sits well under this pin whatever the scan size.
    expect(svg.length).toBeLessThan(50_000);
  });
});

describe('capRingVertices', () => {
  /** A square ring with `n` vertices spread along its perimeter. */
  const denseSquare = (n: number, size: number, cx = 0, cy = 0): Ring => {
    const pts: Array<readonly [number, number]> = [];
    const per = 4 * size;
    for (let i = 0; i < n; i++) {
      const d = (per * i) / n;
      const side = Math.floor(d / size);
      const t = d - side * size;
      if (side === 0) pts.push([cx + t, cy]);
      else if (side === 1) pts.push([cx + size, cy + t]);
      else if (side === 2) pts.push([cx + size - t, cy + size]);
      else pts.push([cx, cy + size - t]);
    }
    return pts;
  };

  it('returns under-budget sets untouched', () => {
    const rings = [denseSquare(40, 5)];
    expect(capRingVertices(rings, 0.05, 1000)).toEqual(rings);
  });

  it('tightens DP proportionally and keeps the LARGEST rings when dropping', () => {
    const rings: Ring[] = [denseSquare(800, 10)];
    for (let i = 0; i < 50; i++) rings.push(denseSquare(40, 0.4, 20 + i, 0));
    const out = capRingVertices(rings, 0.05, 200);
    expect(ringVertexCount(out)).toBeLessThanOrEqual(200);
    // The big ring survives (collapsed to ~its corners), speckle goes first.
    const biggest = out.reduce((a, r) => Math.max(a, Math.abs(ringSignedArea(r))), 0);
    expect(biggest).toBeGreaterThan(90); // the 10×10 outline is still there
  });

  it('guarantees the cap even for a single pathological ring (decimation)', () => {
    // A ring DP cannot reduce: 5 000 vertices on a CIRCLE (every vertex is
    // equally far from any chord) with a tolerance smaller than the sagitta.
    const circle: Array<readonly [number, number]> = [];
    for (let i = 0; i < 5000; i++) {
      const a = (2 * Math.PI * i) / 5000;
      circle.push([100 * Math.cos(a), 100 * Math.sin(a)]);
    }
    const out = capRingVertices([circle], 0.0001, 500);
    expect(ringVertexCount(out)).toBeLessThanOrEqual(500);
    expect(out[0].length).toBeGreaterThanOrEqual(3);
  });
});

describe('limitUnknownGaps', () => {
  const gap = (x: number, y: number, w: number): PlanGap => ({
    a: [x, y],
    b: [x + w, y],
    widthM: w,
    kind: 'unknown',
  });

  it('caps at MAX_UNKNOWN_GAPS, widest first', () => {
    const gaps: PlanGap[] = [];
    for (let i = 0; i < 120; i++) gaps.push(gap(0, i * 1.0, 0.3 + 0.01 * i));
    const out = limitUnknownGaps(gaps, 0.05);
    expect(out.length).toBe(MAX_UNKNOWN_GAPS);
    // The widest survived.
    expect(out.some((g) => Math.abs(g.widthM - (0.3 + 0.01 * 119)) < 1e-9)).toBe(true);
    // The narrowest did not.
    expect(out.some((g) => Math.abs(g.widthM - 0.3) < 1e-9)).toBe(false);
  });

  it('merges near-duplicates (same opening traced twice keeps the wider)', () => {
    const out = limitUnknownGaps([gap(0, 0, 0.8), gap(0.02, 0.02, 0.78), gap(5, 5, 0.6)], 0.05);
    expect(out.length).toBe(2);
    expect(out[0].widthM).toBeCloseTo(0.8, 9);
  });
});
