/**
 * spaceMetricsAxis.test.ts — vertical-axis truth tests for the Space panel.
 *
 * Born from a confirmed live bug (v0.4.4): a z-thin interior (extent
 * 14.1 × 28.8 × 5.1 m) reported H = 23.26 m, floor 55 m², enclosed volume
 * 1,750 m³ and 3 storeys DESPITE "ceiling not detected", and its floor-plan
 * sketch was actually a side elevation. Two distinct mechanisms compose it:
 *
 *   1. CONTAINED (fixed in this cycle, pinned here): `spaceMetrics` printed a
 *      confident enclosed volume (the OBB-envelope fallback) and a multi-storey
 *      count on the same report that said "no ceiling captured". Volume and
 *      storeys are now gated on a DETECTED ceiling for interiors, and wall-top
 *      mass on perimeter cells can no longer read as a ceiling.
 *
 *   2. DEEP (fixed v0.4.5, pinned by the last test below): `classifyScanShape`
 *      up-axis detection picked a HORIZONTAL axis as up on 360-style interiors
 *      whose walls are densely sampled and whose floor is sparse/cluttered —
 *      every downstream figure (H, footprint, floor plan, storeys) was then
 *      computed in a sideways frame. Fixed by the gravity prior (z incumbent,
 *      1.25× override margin) + the wall-as-floor penalty in scanShape.ts.
 *
 * Geometry is jittered with a deterministic LCG so the synthetic room has
 * continuous wall sampling like a real scan — a perfectly regular grid stacks
 * wall returns into single histogram bins and trips the ceiling-peak detector
 * for reasons real data wouldn't.
 */

import { describe, it, expect } from 'vitest';
import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { classifyScanShape } from '../src/terrain/scanShape';

function pts(triples: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
}

/** Deterministic LCG in [0, 1) so the jitter is reproducible run to run. */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Open-top room, z up: floor + four walls, NO ceiling. Wall z-positions are
 * jittered (continuous sampling, like a real scanner) so no synthetic z-banding
 * can masquerade as a horizontal plane.
 */
function openTopRoom(W: number, D: number, H: number): Float32Array {
  const rnd = makeRng(42);
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= W; x += 0.25)
    for (let y = 0; y <= D; y += 0.25) t.push([x, y, 0.02 * rnd()]);
  for (let z = 0; z <= H; z += 0.1) {
    for (let x = 0; x <= W; x += 0.25) { t.push([x, 0, z + 0.08 * rnd()]); t.push([x, D, z + 0.08 * rnd()]); }
    for (let y = 0; y <= D; y += 0.25) { t.push([0, y, z + 0.08 * rnd()]); t.push([W, y, z + 0.08 * rnd()]); }
  }
  return pts(t);
}

describe('spaceMetrics — vertical-axis truth (10 × 8 × 3 m room, z up, no ceiling)', () => {
  const cloud = openTopRoom(10, 8, 3);
  const m = spaceMetrics(cloud, { upAxis: 'z', spaceKind: 'interior' });

  it('orients the frame correctly: L ≈ 10, W ≈ 8, H ≈ 3', () => {
    expect(m.dims.lengthM).toBeGreaterThan(9.5);
    expect(m.dims.lengthM).toBeLessThan(10.5);
    expect(m.dims.widthM).toBeGreaterThan(7.5);
    expect(m.dims.widthM).toBeLessThan(8.5);
    expect(m.dims.heightM).toBeGreaterThan(2.8);
    expect(m.dims.heightM).toBeLessThan(3.3);
  });

  it('footprint is the horizontal occupied-cell projection: ≈ 80 m²', () => {
    expect(m.floorAreaM2).toBeGreaterThan(80 * 0.85);
    expect(m.floorAreaM2).toBeLessThan(80 * 1.15);
  });

  it('no ceiling plane ⇒ no ceiling height and NO enclosed volume', () => {
    // The live v0.4.4 panel printed 1,750 m³ next to "ceiling not detected" —
    // the OBB-envelope fallback leaking into the interior path. An interior
    // without a captured ceiling has no honest volume; it must be null.
    expect(m.planes.ceilingPresent).toBe(false);
    expect(m.ceilingHeightM).toBeNull();
    expect(m.enclosedVolumeM3).toBeNull();
  });

  it('never claims multiple storeys without a ceiling', () => {
    // Live bug: 3 storeys reported on an open-top space. With no top surface
    // the histogram peaks are wall/clutter mass — one floor ⇒ at most one storey.
    expect(m.storyCount).toBeLessThanOrEqual(1);
  });

  it('wall tops on a regularly-banded scan do not read as a ceiling', () => {
    // The same room with walls sampled at exact z-steps: every wall slice
    // stacks into a single histogram bin, which used to clear the ceiling-peak
    // mass threshold and fabricate a 1.75 m "ceiling" inside a 3 m room. The
    // interior-cell evidence gate rejects it: top-band returns that live ONLY
    // on perimeter cells are walls, not a ceiling.
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 10; x += 0.25)
      for (let y = 0; y <= 8; y += 0.25) t.push([x, y, 0]);
    for (let z = 0; z <= 3; z += 0.25) {
      for (let x = 0; x <= 10; x += 0.25) { t.push([x, 0, z]); t.push([x, 8, z]); }
      for (let y = 0; y <= 8; y += 0.25) { t.push([0, y, z]); t.push([10, y, z]); }
    }
    const banded = spaceMetrics(pts(t), { upAxis: 'z', spaceKind: 'interior' });
    expect(banded.planes.ceilingPresent).toBe(false);
    expect(banded.ceilingHeightM).toBeNull();
    expect(banded.enclosedVolumeM3).toBeNull();
  });

  it('detects z as up for this room (sanity pin on the wiring contract)', () => {
    // main.ts feeds `classifyScanShape(...).up` into spaceMetrics — for a room
    // with a coherent floor the detector must agree with ground truth.
    expect(classifyScanShape(cloud).up).toBe('z');
  });

  // DEEP FIX (landed v0.4.5 — gravity prior + wall-as-floor penalty in
  // `classifyScanShape`; spec in V045_WORKPLAN.md P0). Reproduction of the
  // live misroute: a z-thin 360-style interior with densely-sampled walls
  // (step 0.12, jittered) and a SPARSE rough floor (step 0.6, clutter to
  // 0.5 m), extent 14.1 × 28.8 × 5.1. Pre-fix the dense flat wall made a
  // better "floor field" than the sparse real floor (x-score 0.77 vs
  // z-score 0.60, hand-measured) and the enclosure hint rewarded the two
  // opposing walls — up = 'x', H = 14.1, floor plan = side elevation. The
  // wall-as-floor penalty (full-height columns on ~0.9 of the sideways
  // frame's cells vs ~0.19 upright) plus the 1.25× gravity margin now keeps
  // z; the assertions below pin BOTH the axis and the downstream frame.
  it('detects z as up for a z-thin 360-style interior (dense walls, sparse floor)', () => {
    const rnd = makeRng(7);
    const t: Array<[number, number, number]> = [];
    const W = 14.1, D = 28.8, H = 5.1;
    // Sparse, cluttered floor — clutter up to 0.5 m, like furniture/debris.
    for (let x = 0; x <= W; x += 0.6)
      for (let y = 0; y <= D; y += 0.6) t.push([x, y, rnd() * 0.5]);
    // Densely-sampled walls (terrestrial 360 scanner), jittered so no
    // synthetic banding helps or hurts either axis.
    for (let z = 0; z <= H; z += 0.12) {
      for (let x = 0; x <= W; x += 0.12) {
        t.push([x, 0.05 * rnd(), z + 0.05 * rnd()]);
        t.push([x, D - 0.05 * rnd(), z + 0.05 * rnd()]);
      }
      for (let y = 0; y <= D; y += 0.12) {
        t.push([0.05 * rnd(), y, z + 0.05 * rnd()]);
        t.push([W - 0.05 * rnd(), y, z + 0.05 * rnd()]);
      }
    }
    const cloud360 = pts(t);
    const shape = classifyScanShape(cloud360);
    expect(shape.up).toBe('z');
    // Downstream truth: in the upright frame the space is 28.8 long, 14.1
    // wide and ≈ 5.1 tall — never the sideways H = 14.1 the live bug printed.
    const space = spaceMetrics(cloud360, { upAxis: shape.up, spaceKind: 'interior' });
    expect(space.dims.heightM).toBeGreaterThan(4.8);
    expect(space.dims.heightM).toBeLessThan(5.4);
    expect(space.dims.lengthM).toBeGreaterThan(27.5);
    expect(space.dims.lengthM).toBeLessThan(30);
  });
});
