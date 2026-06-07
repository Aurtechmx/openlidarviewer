/**
 * scanTypeMatrix.test.ts — the scan-type classifier decision matrix.
 *
 * Deterministic, synthetic fixtures that stand in for the real COPC scans that
 * cannot be loaded in CI: a bare drone terrain, a classified drone-forest, the
 * multi-room HOUSE 360 that regressed (misread as terrain), a clean single
 * room, a SLAM corridor, an iPhone object, and a drone-over-urban scan.
 *
 * Each asserts the decisive `nonTerrain` + `spaceKind` verdict (and, where it
 * matters, the detected up axis). These are the contract the viewer routes on.
 */

import { describe, it, expect } from 'vitest';
import { classifyScanShape } from '../src/terrain/scanShape';

/** Interleave xyz triples into a Float32Array. */
function pts(triples: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
}

/** A deterministic pseudo-random in [0,1) from an integer seed (no Math.random). */
function rnd(seed: number): number {
  const s = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

// ── 1. bare drone terrain: one wide, gently sloped + rippled surface. ────────
function bareTerrain(): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= 200; x += 2)
    for (let y = 0; y <= 200; y += 2)
      t.push([x, y, 0.04 * x + 2 * Math.sin(x / 25) + 1.5 * Math.cos(y / 30)]);
  return pts(t);
}

// ── 2. classified forest: full ground plane (class 2) + a spatially-VARYING
//    canopy (class 5) at 8–30 m over a wide footprint. The canopy gives high
//    overhang AND a full-height span, so geometry alone reads "interior"; only
//    the vegetation classification breaks the tie back to terrain.
function forest(): { positions: Float32Array; classification: Uint8Array } {
  const t: Array<[number, number, number]> = [];
  const cls: number[] = [];
  let k = 0;
  for (let x = 0; x <= 120; x += 2)
    for (let y = 0; y <= 120; y += 2) {
      // Ground return (class 2), slightly rough.
      t.push([x, y, 0.3 * Math.sin(x / 18) + 0.3 * Math.cos(y / 22)]);
      cls.push(2);
      // Canopy returns (class 5) at varying heights 8..30 m — several per cell.
      const base = 8 + 22 * rnd(k++);
      for (let j = 0; j < 3; j++) {
        const h = base - j * (2 + 2 * rnd(k++));
        if (h > 6) { t.push([x + rnd(k++) - 0.5, y + rnd(k++) - 0.5, h]); cls.push(5); }
      }
    }
  return { positions: pts(t), classification: Uint8Array.from(cls) };
}

// ── 3. HOUSE 360 (the key regression): full floor, floor-to-ceiling WALLS
//    around several rooms, a PARTIAL multi-height ceiling (~30% of footprint,
//    occluded elsewhere), and mid-height furniture clutter. NO classification.
function house360(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: Array<[number, number, number]> = [];
  const wallX = (x: number, y0: number, y1: number): void => {
    for (let y = y0; y <= y1; y += step)
      for (let z = 0; z <= H; z += step) t.push([x, y, z]);
  };
  const wallY = (y: number, x0: number, x1: number): void => {
    for (let x = x0; x <= x1; x += step)
      for (let z = 0; z <= H; z += step) t.push([x, y, z]);
  };
  // Full floor.
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) t.push([x, y, 0]);
  // Perimeter walls.
  wallX(0, 0, D); wallX(W, 0, D); wallY(0, 0, W); wallY(D, 0, W);
  // Interior partitions → several rooms.
  wallX(7, 0, D);          // central spine
  wallY(10, 0, W);         // crosswall
  wallY(20, 0, 7);         // partial crosswall
  // PARTIAL ceiling: only over y∈[0,9] (~31% of the footprint) — the rest is
  // occluded / open to a higher void, so the top band never spans the floor.
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= 9; y += step) t.push([x, y, H]);
  // Furniture clutter (mid heights ~0.4..1.1 m), a few scattered blocks.
  const blocks: Array<[number, number]> = [[3, 14], [10, 16], [4, 24], [11, 25]];
  for (const [bx, by] of blocks)
    for (let dx = 0; dx <= 1.5; dx += step)
      for (let dy = 0; dy <= 1.5; dy += step)
        for (let z = 0.4; z <= 1.1; z += step) t.push([bx + dx, by + dy, z]);
  return pts(t);
}

// ── 4. clean single room: closed floor + ceiling + perimeter walls. ──────────
function room(W = 12, D = 18, H = 3, step = 0.5): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { t.push([x, y, 0]); t.push([x, y, H]); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { t.push([x, 0, z]); t.push([x, D, z]); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { t.push([0, y, z]); t.push([W, y, z]); }
  return pts(t);
}

// ── 5. SLAM corridor: long, thin, enclosed (floor + ceiling + walls). ────────
function corridor(W = 2, D = 40, H = 2.5, step = 0.25): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { t.push([x, y, 0]); t.push([x, y, H]); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { t.push([0, y, z]); t.push([W, y, z]); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { t.push([x, 0, z]); t.push([x, D, z]); }
  return pts(t);
}

// ── 6. iPhone object: a compact paraboloid dome on a flat base, Y-up. The flat
//    base is the widest/flattest low surface, so the up axis must resolve to Y.
function iphoneObject(R = 0.15, Hy = 0.4, step = 0.01): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = -R; x <= R; x += step)
    for (let z = -R; z <= R; z += step) {
      const r = Math.hypot(x, z);
      if (r > R) continue;
      t.push([x, 0, z]);                                 // flat base (y=0)
      t.push([x, Hy * (1 - (r / R) * (r / R)), z]);      // dome surface (y up)
    }
  return pts(t);
}

// ── 7. drone urban: wide ground + sparse solid building blocks (minority of
//    the footprint, full height). Should read as terrain, not interior.
function droneUrban(): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= 200; x += 2)
    for (let y = 0; y <= 200; y += 2) t.push([x, y, 0.02 * x]);
  // A handful of 24×24 m blocks, 18 m tall — ~12% of the footprint.
  const blocks: Array<[number, number]> = [[30, 30], [120, 40], [60, 130], [150, 150]];
  for (const [bx, by] of blocks)
    for (let dx = 0; dx <= 24; dx += 2)
      for (let dy = 0; dy <= 24; dy += 2)
        for (let z = 0; z <= 18; z += 2) t.push([bx + dx, by + dy, z]);
  return pts(t);
}

describe('scan-type matrix', () => {
  it('1. bare drone terrain → terrain', () => {
    const s = classifyScanShape(bareTerrain());
    expect(s.up).toBe('z');
    expect(s.nonTerrain).toBe(false);
    expect(s.spaceKind).toBe('terrain');
    expect(s.wallCoverage).toBeLessThan(0.1);
  });

  it('2. classified forest → terrain (vegetation tiebreaker)', () => {
    const { positions, classification } = forest();
    const s = classifyScanShape(positions, { classification });
    expect(s.up).toBe('z');
    expect(s.topVegFraction).toBeGreaterThan(0.55);
    expect(s.nonTerrain).toBe(false);
    expect(s.spaceKind).toBe('terrain');
  });

  it('3. HOUSE 360 → non-terrain interior (walls carry it; ceiling is partial)', () => {
    const s = classifyScanShape(house360());
    expect(s.up).toBe('z');
    expect(s.aspect).toBeLessThan(0.65);
    // The ceiling is deliberately partial — the OLD test (floor AND ceiling each
    // ≥45%) fails here, which is the regression. Walls must carry it instead.
    expect(s.ceilingCoverage).toBeLessThan(0.45);
    expect(s.floorCoverage).toBeGreaterThan(0.6);
    expect(s.wallCoverage).toBeGreaterThan(0.25);
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('interior');
  });

  it('4. clean single room → interior', () => {
    const s = classifyScanShape(room());
    expect(s.up).toBe('z');
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('interior');
  });

  it('5. SLAM corridor → interior', () => {
    const s = classifyScanShape(corridor());
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('interior');
  });

  it('6. iPhone object → non-terrain object, up=y', () => {
    const s = classifyScanShape(iphoneObject());
    expect(s.up).toBe('y');
    expect(s.nonTerrain).toBe(true);
    expect(s.spaceKind).toBe('object');
  });

  it('7. drone urban → terrain (sparse blocks, not an enclosure)', () => {
    const s = classifyScanShape(droneUrban());
    expect(s.up).toBe('z');
    expect(s.nonTerrain).toBe(false);
    expect(s.spaceKind).toBe('terrain');
  });
});
