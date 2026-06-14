/**
 * spaceMetrics.test.ts — interior / object measurements for non-terrain scans.
 */

import { describe, it, expect } from 'vitest';
import {
  spaceMetrics,
  metresToFeet,
  sqMetresToSqFeet,
  cubicMetresToCubicFeet,
} from '../src/terrain/spaceMetrics';

function pts(triples: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
}

/** Single room: floor + ceiling grids over W×D, plus perimeter walls. */
function room(W = 14, D = 29, H = 5, step = 0.5): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { t.push([x, y, 0]); t.push([x, y, H]); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { t.push([x, 0, z]); t.push([x, D, z]); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { t.push([0, y, z]); t.push([W, y, z]); }
  return pts(t);
}

/** One enclosed storey at vertical offset `base` with height `H`. */
function storey(out: Array<[number, number, number]>, base: number, W = 10, D = 10, H = 2.8, step = 0.5): void {
  for (let x = 0; x <= W; x += step)
    for (let y = 0; y <= D; y += step) { out.push([x, y, base]); out.push([x, y, base + H]); }
  for (let z = 0; z <= H; z += step)
    for (let x = 0; x <= W; x += step) { out.push([x, 0, base + z]); out.push([x, D, base + z]); }
  for (let z = 0; z <= H; z += step)
    for (let y = 0; y <= D; y += step) { out.push([0, y, base + z]); out.push([W, y, base + z]); }
}

/** Open dome (single surface, no ceiling): cone of height 15 over footprint 20. */
function dome(): Float32Array {
  const t: Array<[number, number, number]> = [];
  for (let x = -10; x <= 10; x += 0.4)
    for (let y = -10; y <= 10; y += 0.4) {
      const r = Math.hypot(x, y);
      if (r <= 10) t.push([x, y, 15 * (1 - r / 10)]);
    }
  return pts(t);
}

describe('spaceMetrics — interior', () => {
  const m = spaceMetrics(room(), { upAxis: 'z', spaceKind: 'interior' });

  it('recovers ceiling height ≈ constructed height', () => {
    expect(m.ceilingHeightM).not.toBeNull();
    expect(m.ceilingHeightM as number).toBeGreaterThan(4.4);
    expect(m.ceilingHeightM as number).toBeLessThan(5.6);
  });

  it('floor area ≈ footprint and dims ≈ 29 × 14 × 5', () => {
    expect(m.floorAreaM2).toBeGreaterThan(14 * 29 * 0.85);
    expect(m.floorAreaM2).toBeLessThan(14 * 29 * 1.15);
    expect(m.dims.lengthM).toBeGreaterThan(26);
    expect(m.dims.widthM).toBeGreaterThan(12);
    expect(m.dims.heightM).toBeCloseTo(5, 0);
  });

  it('enclosed volume ≈ floor area × ceiling height', () => {
    expect(m.enclosedVolumeM3).not.toBeNull();
    expect(m.enclosedVolumeM3 as number).toBeCloseTo(m.floorAreaM2 * (m.ceilingHeightM as number), 3);
  });

  it('detects floor, ceiling and walls; one storey', () => {
    expect(m.planes.floorPresent).toBe(true);
    expect(m.planes.ceilingPresent).toBe(true);
    expect(m.planes.floorAreaM2).not.toBeNull();
    expect(m.planes.ceilingAreaM2).not.toBeNull();
    expect(m.planes.wallCoveragePct).toBeGreaterThan(0);
    expect(m.planes.dominantWallDirections).toBeGreaterThanOrEqual(2);
    expect(m.storyCount).toBe(1);
  });

  it('reports honest capture quality with a streaming caveat', () => {
    expect(m.quality.sampledPointCount).toBeGreaterThan(0);
    expect(m.quality.densityPerM2).toBeGreaterThan(0);
    expect(m.quality.meanSpacingM).toBeGreaterThan(0);
    expect(m.quality.coveragePct).toBeGreaterThan(50);
    expect(m.quality.hasRgb).toBe(false);
    expect(m.reasons.some((r) => /currently loaded \/ streamed/.test(r))).toBe(true);
  });

  it('leads with a "Preliminary — partial stream" caveat when residentOnly', () => {
    const partial = spaceMetrics(room(), { upAxis: 'z', spaceKind: 'interior', residentOnly: true });
    // The partial-stream caveat is the FIRST reason (the panel leads with it).
    expect(partial.reasons[0]).toMatch(/^Preliminary —/);
    expect(partial.reasons[0]).toMatch(/will change as more loads/);
    // The generic "currently loaded" caveat is replaced, not stacked.
    expect(partial.reasons.some((r) => /currently loaded \/ streamed/.test(r))).toBe(false);
    // A full (non-resident) gather keeps the milder caveat, not "Preliminary".
    expect(m.reasons[0]).not.toMatch(/^Preliminary —/);
  });
});

describe('spaceMetrics — storeys & units & objects', () => {
  it('two stacked storeys → storyCount 2', () => {
    const out: Array<[number, number, number]> = [];
    storey(out, 0);   // storey 1: 0 → 2.8
    storey(out, 3.0); // storey 2: 3.0 → 5.8
    const m = spaceMetrics(pts(out), { upAxis: 'z', spaceKind: 'interior' });
    expect(m.storyCount).toBe(2);
  });

  it('unit conversions m↔ft are correct', () => {
    expect(metresToFeet(1)).toBeCloseTo(3.280839895, 6);
    expect(metresToFeet(3.048)).toBeCloseTo(10, 6);
    expect(sqMetresToSqFeet(1)).toBeCloseTo(10.7639104, 5);
    expect(cubicMetresToCubicFeet(1)).toBeCloseTo(35.3146667, 4);
  });

  it('unitToMetres scales source units into metres', () => {
    // Same room built in feet-like units, converted to metres.
    const r = room(14, 29, 5);
    const scaled = new Float32Array(r.length);
    for (let i = 0; i < r.length; i++) scaled[i] = r[i] / 0.3048; // pretend stored in feet
    const m = spaceMetrics(scaled, { upAxis: 'z', spaceKind: 'interior', unitToMetres: 0.3048 });
    expect(m.ceilingHeightM as number).toBeGreaterThan(4.4);
    expect(m.ceilingHeightM as number).toBeLessThan(5.6);
  });

  it('unitToMetres scales length, area AND volume consistently before the m→ft conversion', () => {
    // A foot-based capture (US survey-foot-ish): the SAME geometry stored once in
    // metres and once in feet must produce identical metric dimensions/area/volume
    // when the foot copy carries unitToMetres = 0.3048. This proves the factor is
    // applied to EVERY length/area/volume path, not just height.
    const FT = 0.3048;
    const rM = room(4, 6, 3, 0.25); // small dense room, in metres
    const rFt = new Float32Array(rM.length);
    for (let i = 0; i < rM.length; i++) rFt[i] = rM[i] / FT; // same room expressed in feet

    const inMetres = spaceMetrics(rM, { upAxis: 'z', spaceKind: 'interior', gridN: 24 });
    const inFeet = spaceMetrics(rFt, { upAxis: 'z', spaceKind: 'interior', gridN: 24, unitToMetres: FT });

    // Linear, areal and cubic measures all land back on the metre values.
    expect(inFeet.dims.lengthM).toBeCloseTo(inMetres.dims.lengthM, 6);
    expect(inFeet.dims.widthM).toBeCloseTo(inMetres.dims.widthM, 6);
    expect(inFeet.dims.heightM).toBeCloseTo(inMetres.dims.heightM, 6);
    expect(inFeet.floorAreaM2).toBeCloseTo(inMetres.floorAreaM2, 5);
    expect(inFeet.ceilingHeightM as number).toBeCloseTo(inMetres.ceilingHeightM as number, 6);
    // Cubic measure amplifies float32 storage rounding, so allow 4 places.
    expect(inFeet.enclosedVolumeM3 as number).toBeCloseTo(inMetres.enclosedVolumeM3 as number, 4);
  });

  it('a 10 ft extent reads ~3.05 m and ~10 ft after the m↔ft round-trip', () => {
    // A foot-stored extent: 10 ft along the room length. With unitToMetres=0.3048
    // the metric height reads ~3.05 m, and converting back to feet reads ~10 ft.
    const FT = 0.3048;
    const tenFtRoomMetres = room(3, 4, 10 * FT, 0.2); // 10 ft tall, in metres
    const tenFtRoomFeet = new Float32Array(tenFtRoomMetres.length);
    for (let i = 0; i < tenFtRoomMetres.length; i++) tenFtRoomFeet[i] = tenFtRoomMetres[i] / FT;
    const m = spaceMetrics(tenFtRoomFeet, { upAxis: 'z', spaceKind: 'interior', unitToMetres: FT });
    const h = m.ceilingHeightM as number;
    expect(h).toBeGreaterThan(10 * FT - 0.4); // ≈ 3.05 m
    expect(h).toBeLessThan(10 * FT + 0.4);
    expect(metresToFeet(h)).toBeGreaterThan(9.5);
    expect(metresToFeet(h)).toBeLessThan(10.5);
  });

  it('a single tall room is one storey, not two (a ceiling is not a second floor)', () => {
    // One enclosed room 0 → 4 m. The ceiling is a strong height peak, but it is
    // NOT a floor: there is no room (point mass) above it, and no real
    // floor-to-floor gap. Storey detection must read 1, never 2.
    const m = spaceMetrics(room(8, 8, 4, 0.3), { upAxis: 'z', spaceKind: 'interior' });
    expect(m.storyCount).toBe(1);
  });

  it('still detects the floor in a cluttered room (furniture mass above the floor band)', () => {
    // A room whose floor is partly occluded by clutter: the bare floor plane is
    // present, but a slab of "furniture" points sits 0.4–0.9 m above it across
    // much of the footprint, so a naive band-coverage test (does each cell have a
    // return near the floor?) is depressed. The density-weighted height peak still
    // finds the floor, so floorPresent stays true and a ceiling height is read.
    const t: Array<[number, number, number]> = [];
    const W = 12, D = 12, H = 4, step = 0.5;
    // Floor + ceiling, but the central footprint's floor is OCCLUDED — no bare
    // floor return there, only clutter sitting 0.4–0.9 m up. Ceiling stays full.
    const central = (x: number, y: number): boolean => x >= 2 && x <= W - 2 && y >= 2 && y <= D - 2;
    for (let x = 0; x <= W; x += step)
      for (let y = 0; y <= D; y += step) {
        if (!central(x, y)) t.push([x, y, 0]); // floor only at the perimeter ring
        t.push([x, y, H]); // ceiling everywhere
      }
    for (let z = 0; z <= H; z += step)
      for (let x = 0; x <= W; x += step) { t.push([x, 0, z]); t.push([x, D, z]); }
    for (let z = 0; z <= H; z += step)
      for (let y = 0; y <= D; y += step) { t.push([0, y, z]); t.push([W, y, z]); }
    // Clutter: a dense low slab over the central footprint, 0.4–0.9 m up — this
    // is the lowest return in those cells, so a raw band test misses the floor.
    for (let x = 2; x <= W - 2; x += step)
      for (let y = 2; y <= D - 2; y += step)
        for (let z = 0.4; z <= 0.9; z += 0.25) t.push([x, y, z]);
    const m = spaceMetrics(pts(t), { upAxis: 'z', spaceKind: 'interior' });
    expect(m.planes.floorPresent).toBe(true);
    expect(m.ceilingHeightM).not.toBeNull();
    expect(m.ceilingHeightM as number).toBeGreaterThan(3.4);
    expect(m.ceilingHeightM as number).toBeLessThan(4.6);
    expect(m.storyCount).toBe(1);
  });

  it('open object → no ceiling height, envelope-volume fallback', () => {
    const m = spaceMetrics(dome(), { upAxis: 'z', spaceKind: 'object' });
    expect(m.ceilingHeightM).toBeNull();
    expect(m.planes.ceilingPresent).toBe(false);
    expect(m.enclosedVolumeM3).not.toBeNull();
    expect(m.enclosedVolumeM3 as number).toBeGreaterThan(0);
  });

  it('density describes the SCAN: a 4×4 m-grid plane with sourcePointCount 10× reads 10× denser', () => {
    // Hand-computed: 16 points on a 4×4 grid over 3×3 m, all z = 0.
    // Footprint grid: floor-band points = 16, bbox area = 9 → target cell
    // 2·√(9/16) = 1.5 → cols = rows = max(4, round(3/1.5)) = 4, cell 0.75 m,
    // all 16 cells occupied → floorArea = 16 · 0.5625 = 9 m². With
    // sourcePointCount = 160 (a stride-10 gather) the scan density is
    // 160 / 9 ≈ 17.78 pts/m² — NOT the sample's 16 / 9.
    const t: Array<[number, number, number]> = [];
    for (let x = 0; x <= 3; x++) for (let y = 0; y <= 3; y++) t.push([x, y, 0]);
    const sampled = spaceMetrics(pts(t), {
      upAxis: 'z', spaceKind: 'interior', sourcePointCount: 160,
    });
    expect(sampled.quality.sampledPointCount).toBe(16);
    expect(sampled.quality.sourcePointCount).toBe(160);
    expect(sampled.quality.densityPerM2).toBeCloseTo(160 / 9, 6);
    expect(sampled.quality.meanSpacingM).toBeCloseTo(Math.sqrt(9 / 160), 6);
    expect(sampled.reasons.some((r) => /scaled from a/.test(r))).toBe(true);

    // Without a larger source count the figures describe the points given.
    const full = spaceMetrics(pts(t), { upAxis: 'z', spaceKind: 'interior' });
    expect(full.quality.densityPerM2).toBeCloseTo(16 / 9, 6);
    expect(full.reasons.some((r) => /scaled from a/.test(r))).toBe(false);
  });

  it('magnitude: a strided room sample with sourcePointCount lands near the full-cloud density', () => {
    // The full room is the truth; a stride-5 gather + the honest source count
    // must report a density close to the full run (same scan, same area), and
    // ~5× the dishonest unscaled figure.
    const full = room();
    const fullCount = full.length / 3;
    const strided: number[] = [];
    for (let i = 0; i < fullCount; i += 5) {
      strided.push(full[i * 3], full[i * 3 + 1], full[i * 3 + 2]);
    }
    const truth = spaceMetrics(full, { upAxis: 'z', spaceKind: 'interior' });
    const scaled = spaceMetrics(Float32Array.from(strided), {
      upAxis: 'z', spaceKind: 'interior', sourcePointCount: fullCount,
    });
    const unscaled = spaceMetrics(Float32Array.from(strided), {
      upAxis: 'z', spaceKind: 'interior',
    });
    // Within 25% of the truth (the sparser cloud re-sizes the footprint grid
    // slightly), where the unscaled figure was ~5× off.
    expect(scaled.quality.densityPerM2).toBeGreaterThan(truth.quality.densityPerM2 * 0.75);
    expect(scaled.quality.densityPerM2).toBeLessThan(truth.quality.densityPerM2 * 1.25);
    expect(scaled.quality.densityPerM2 / unscaled.quality.densityPerM2).toBeCloseTo(5, 1);
  });

  it('too few points → graceful unknowns', () => {
    const m = spaceMetrics(pts([[0, 0, 0], [1, 1, 1], [2, 0, 1]]), { upAxis: 'z', spaceKind: 'interior' });
    expect(m.ceilingHeightM).toBeNull();
    expect(m.enclosedVolumeM3).toBeNull();
    expect(m.storyCount).toBe(0);
    expect(m.floorAreaM2).toBe(0);
  });
});
