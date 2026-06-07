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

  it('open object → no ceiling height, envelope-volume fallback', () => {
    const m = spaceMetrics(dome(), { upAxis: 'z', spaceKind: 'object' });
    expect(m.ceilingHeightM).toBeNull();
    expect(m.planes.ceilingPresent).toBe(false);
    expect(m.enclosedVolumeM3).not.toBeNull();
    expect(m.enclosedVolumeM3 as number).toBeGreaterThan(0);
  });

  it('too few points → graceful unknowns', () => {
    const m = spaceMetrics(pts([[0, 0, 0], [1, 1, 1], [2, 0, 1]]), { upAxis: 'z', spaceKind: 'interior' });
    expect(m.ceilingHeightM).toBeNull();
    expect(m.enclosedVolumeM3).toBeNull();
    expect(m.storyCount).toBe(0);
    expect(m.floorAreaM2).toBe(0);
  });
});
