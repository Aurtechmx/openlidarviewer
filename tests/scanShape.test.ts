/**
 * scanShape.test.ts — terrain (2.5-D height field) vs object (compact 3-D).
 */

import { describe, it, expect } from 'vitest';
import { classifyScanShape } from '../src/terrain/scanShape';

/** Interleave xyz triples into a Float32Array. */
function pts(triples: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
}

/**
 * A synthetic interior: a flat floor grid (z=0) + flat ceiling grid (z=H) over
 * a 14×29 footprint, with four perimeter wall strips spanning floor→ceiling.
 * This mirrors the iPhone-LiDAR room scan that wrongly read as terrain.
 */
function room(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) {
      t.push([x, y, 0]); // floor
      t.push([x, y, H]); // ceiling
    }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) {
      t.push([x, 0, z]); // wall y=0
      t.push([x, D, z]); // wall y=D
    }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) {
      t.push([0, y, z]); // wall x=0
      t.push([W, y, z]); // wall x=W
    }
  return pts(t);
}

describe('classifyScanShape', () => {
  it('flat, wide, single-surface terrain → terrain', () => {
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 100; x += 2)
      for (let y = 0; y <= 100; y += 2) t.push([x, y, 2 * Math.sin(x / 20) + Math.cos(y / 25)]);
    const s = classifyScanShape(pts(t));
    expect(s.kind).toBe('terrain');
    expect(s.up).toBe('z');
    expect(s.aspect).toBeLessThan(0.2);
    expect(s.overhangFraction).toBeLessThan(0.1);
    expect(s.nonTerrain).toBe(false);
    expect(s.spaceKind).toBe('terrain');
  });

  it('an iPhone-LiDAR room (floor+ceiling+walls) → non-terrain interior', () => {
    // The core regression: low aspect (~0.17) like terrain, but a detected
    // floor + ceiling enclosure must route it to the space analysis, not
    // contours. Up is the true vertical (z) even though a closed box reads
    // ~1.0 overhang on every axis.
    const s = classifyScanShape(room());
    expect(s.up).toBe('z');
    expect(s.aspect).toBeLessThan(0.65);
    expect(s.ceilingCoverage).toBeGreaterThan(0.45);
    expect(s.floorCoverage).toBeGreaterThan(0.45);
    // New signal: a closed box is full-height in every column → very high wall
    // coverage, and no classification means the veg tiebreaker stays inert.
    expect(s.wallCoverage).toBeGreaterThan(0.9);
    expect(s.topVegFraction).toBe(0);
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('interior');
  });

  it('a big open interior with a SPARSE high ceiling → non-terrain interior', () => {
    // Reproduces the real 125.5 M-pt 360 industrial-interior streamed scan
    // (360-for-you.small.copc, ~11.8 × 15.0 m footprint, ~4 m ceiling) that
    // the "Treat as" control would NOT auto-commit to Interior. Root cause
    // (pre-fix): a 360 scanner sees a HIGH ceiling only at grazing angle, so
    // `ceilingCoverage` and full-height `wallCoverage` both sit ~12–22% — under
    // the old WALL_INTERIOR (0.25) AND ENCLOSURE_COVER (0.45) bars — and the
    // densely-sampled floor (≈100%) was read as flat TERRAIN. The planner
    // then refused the mid-session terrain flip and the pill stayed on Auto.
    //
    // The fix accepts a much lower wall-OR-ceiling presence on the open-
    // interior path, safe because floorCoverage ≥ 50% and overhang ≥ 15%
    // BOTH independently exclude terrain (which reads ~10–15% floor, ~0%
    // overhang — asserted in the terrain tests below).
    const bigOpenInterior = (
      W = 11.8, D = 15.0, H = 4.0, step = 0.25, ceilDensity = 0.15,
    ): Float32Array => {
      const t: Array<[number, number, number]> = [];
      for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) t.push([x, y, 0]); // dense floor
      // Sparse, partial ceiling (deterministic hash so the test is stable).
      let k = 0;
      for (let x = 0; x <= W; x += step)
        for (let y = 0; y <= D; y += step) {
          k++;
          if (((k * 2654435761) >>> 0) / 4294967296 < ceilDensity) t.push([x, y, H]);
        }
      // Full-height perimeter walls.
      for (let z = 0; z <= H; z += step)
        for (let x = 0; x <= W; x += step) { t.push([x, 0, z]); t.push([x, D, z]); }
      for (let z = 0; z <= H; z += step)
        for (let y = 0; y <= D; y += step) { t.push([0, y, z]); t.push([W, y, z]); }
      // A few partial-height furniture columns mid-floor (some real overhang).
      for (const [cx, cy] of [[3, 4], [7, 9], [9, 12], [2, 11]] as Array<[number, number]>)
        for (let z = 0; z <= 1.0; z += step)
          for (const dx of [-0.3, 0, 0.3]) for (const dy of [-0.3, 0, 0.3]) t.push([cx + dx, cy + dy, z]);
      return pts(t);
    };

    const s = classifyScanShape(bigOpenInterior());
    expect(s.up).toBe('z');
    expect(s.aspect).toBeLessThan(0.65);
    expect(s.floorCoverage).toBeGreaterThan(0.5);
    // The defining hard case: ceiling + full-height walls are BOTH sparse
    // (well under the strict 0.25 / 0.45 bars) — yet it must still route
    // interior, not terrain.
    expect(s.ceilingCoverage).toBeLessThan(0.25);
    expect(s.wallCoverage).toBeLessThan(0.25);
    expect(s.overhangFraction).toBeGreaterThan(0.15);
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('interior');
  });

  it('detects a Y-up flat terrain (phone/glTF frame) without being told', () => {
    // Same flat field but with Y as the vertical axis — the up-axis must be
    // detected from geometry, not assumed to be Z.
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 100; x += 2)
      for (let z = 0; z <= 100; z += 2) t.push([x, 2 * Math.sin(x / 20) + Math.cos(z / 25), z]);
    const s = classifyScanShape(pts(t));
    expect(s.up).toBe('y');
    expect(s.kind).toBe('terrain');
  });

  it('a full cube shell → object regardless of detected up axis', () => {
    // All six faces: every axis sees two stacked faces, so the object verdict
    // doesn't depend on which axis is picked as up.
    const t: Array<[number, number, number]> = [];
    for (let u = 0; u <= 10; u += 0.5)
      for (let w = 0; w <= 10; w += 0.5) {
        t.push([u, w, 0], [u, w, 10]); // z faces
        t.push([u, 0, w], [u, 10, w]); // y faces
        t.push([0, u, w], [10, u, w]); // x faces
      }
    const s = classifyScanShape(pts(t));
    expect(s.kind).toBe('object');
    expect(s.aspect).toBeGreaterThan(0.65);
    expect(s.overhangFraction).toBeGreaterThan(0.2);
    // A compact object stays non-terrain, but routed as object (not interior):
    // its enclosure exists yet its aspect is high, so it is not a wide space.
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('object');
  });

  it('a steep single-surface dome is ambiguous (one signal only)', () => {
    // Compact aspect (tall relative to footprint) but a single surface with no
    // overhangs — could be a steep hill or an object, so don't claim terrain.
    const t: Array<[number, number, number]> = [];
    for (let x = -10; x <= 10; x += 0.5)
      for (let y = -10; y <= 10; y += 0.5) {
        const r = Math.hypot(x, y);
        if (r <= 10) t.push([x, y, 15 * (1 - r / 10)]); // cone, height 15, footprint 20
      }
    const s = classifyScanShape(pts(t));
    expect(s.aspect).toBeGreaterThan(0.65);
    expect(s.overhangFraction).toBeLessThan(0.2);
    expect(s.kind).toBe('ambiguous');
  });

  it('keeps z up for a z-thin 360 interior with dense walls and a sparse floor', () => {
    // The v0.4.4 live bug (V045_WORKPLAN.md, Workstream A1): a dense flat
    // wall scores as a perfect "floor field" (fill 1.0, flatness ~1.0) and
    // the enclosure hint rewards the two opposing walls, so detection used to
    // pick up = 'x' on exactly this shape. The gravity prior (z incumbent,
    // 1.25× margin) + the wall-as-floor penalty must keep z.
    let s0 = 7;
    const rnd = () => { s0 = (s0 * 1103515245 + 12345) & 0x7fffffff; return s0 / 0x7fffffff; };
    const t: Array<[number, number, number]> = [];
    const W = 14.1, D = 28.8, H = 5.1;
    for (let x = 0; x <= W; x += 0.6)
      for (let y = 0; y <= D; y += 0.6) t.push([x, y, rnd() * 0.5]); // sparse cluttered floor
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
    const s = classifyScanShape(pts(t));
    expect(s.up).toBe('z');
    // Extent must read in the upright frame: footprint 14.1 × 28.8, height 5.1.
    expect(s.extent[2]).toBeGreaterThan(4.8);
    expect(s.extent[2]).toBeLessThan(5.5);
  });

  it('an explicit verticalAxis override is honoured', () => {
    // Force Z-up on a Y-up flat field: now the (wrong) axis sees the lateral
    // extent stacked, so it no longer reads as clean terrain.
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 100; x += 2)
      for (let z = 0; z <= 100; z += 2) t.push([x, Math.sin(x / 20), z]);
    const forced = classifyScanShape(pts(t), { verticalAxis: 'z' });
    expect(forced.up).toBe('z');
    expect(forced.kind).not.toBe('terrain');
  });

  it('too few points is ambiguous', () => {
    expect(classifyScanShape(pts([[0, 0, 0], [1, 1, 1]])).kind).toBe('ambiguous');
  });
});
