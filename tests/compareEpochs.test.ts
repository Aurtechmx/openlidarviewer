/**
 * compareEpochs.test.ts — the two-epoch end-to-end path: ground-filter +
 * rasterise both clouds onto ONE shared grid, then diff. Exercises the real
 * terrain leaves (not mocks), so it proves the shared-grid wiring co-registers.
 */

import { describe, it, expect } from 'vitest';
import { buildSharedEpochDtms, compareEpochClouds } from '../src/terrain/change/compareEpochs';
import { METRES_PER_DEGREE } from '../src/terrain/ground/horizontalScale';

/** A flat-ish ground plane of points at height `z` over an `n×n` metre grid. */
function plane(n: number, z: number, x0 = 0, y0 = 0): Float32Array {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      pts.push(x0 + i, y0 + j, z);
    }
  }
  return new Float32Array(pts);
}

describe('buildSharedEpochDtms', () => {
  it('puts both epochs on the same grid (same dims, cell size, origin)', () => {
    const a = plane(30, 0);
    const b = plane(30, 1);
    const dtms = buildSharedEpochDtms({ positions: a }, { positions: b });
    expect(dtms).not.toBeNull();
    expect(dtms!.before.cols).toBe(dtms!.after.cols);
    expect(dtms!.before.rows).toBe(dtms!.after.rows);
    expect(dtms!.before.cellSizeM).toBe(dtms!.after.cellSizeM);
    expect(dtms!.before.originH1).toBe(dtms!.after.originH1);
    expect(dtms!.before.originH2).toBe(dtms!.after.originH2);
  });

  it('returns null when an epoch has no points', () => {
    expect(buildSharedEpochDtms({ positions: new Float32Array() }, { positions: plane(10, 0) })).toBeNull();
  });

  it('unit-aware cell floor: a geographic site no longer collapses to 0.25° cells', () => {
    // Two co-located 1e-4°-square epochs (an ~11 m site at the equator).
    // Old floor: max(0.25, 1e-4/256) = 0.25° ≈ 28 km cells → a 1-cell grid
    // (cols = floor(1e-4/0.25) + 1 = 1). New floor: 0.25 m in degrees =
    // 0.25/111320 ≈ 2.24578e-6°, which beats the resolution target
    // 1e-4/256 = 3.90625e-7° → cols = floor(1e-4/2.24578e-6) + 1 =
    // floor(44.53) + 1 = 45 (hand-computed; the grid stays small enough
    // for the surface build to be test-fast).
    const step = 1e-4 / 30;
    const geo = (z: number): Float32Array => {
      const pts: number[] = [];
      for (let i = 0; i <= 30; i++)
        for (let j = 0; j <= 30; j++) pts.push(i * step, j * step, z);
      return new Float32Array(pts);
    };
    const dtms = buildSharedEpochDtms(
      { positions: geo(0), isGeographic: true },
      { positions: geo(1), isGeographic: true },
    );
    expect(dtms).not.toBeNull();
    expect(dtms!.cellSizeM).toBeCloseTo(0.25 / METRES_PER_DEGREE, 12);
    expect(dtms!.cols).toBe(45);
  });

  it('unit-aware cell floor: a US-feet site floors at 0.25 m worth of feet', () => {
    // A 30 ft site: resolution target 30/256 ≈ 0.1172 ft < the floor
    // 0.25/0.3048 ≈ 0.8202 ft — the floor wins, expressed in FEET.
    const dtms = buildSharedEpochDtms(
      { positions: plane(30, 0), linearUnitToMetres: 0.3048 },
      { positions: plane(30, 1), linearUnitToMetres: 0.3048 },
    );
    expect(dtms).not.toBeNull();
    expect(dtms!.cellSizeM).toBeCloseTo(0.25 / 0.3048, 9);
  });

  it('projected metres keep the historical 0.25 m floor (no unit info = factor 1)', () => {
    const dtms = buildSharedEpochDtms({ positions: plane(30, 0) }, { positions: plane(30, 1) });
    expect(dtms).not.toBeNull();
    expect(dtms!.cellSizeM).toBeCloseTo(0.25, 9);
  });
});

describe('compareEpochClouds', () => {
  it('a +1 m raised surface reads as accretion; unverified without CRS/datum', () => {
    const a = plane(30, 0);
    const b = plane(30, 1); // same footprint, lifted 1 m
    const cmp = compareEpochClouds({ positions: a }, { positions: b });
    expect(cmp).not.toBeNull();
    // The difference math is correct and the rasters align cell-for-cell…
    expect(cmp!.result.stats.netVolumeM3).toBeGreaterThan(0);
    expect(cmp!.result.stats.gainVolumeM3).toBeGreaterThan(cmp!.result.stats.lossVolumeM3);
    expect(cmp!.result.aligned).toBe(true);
    // …but with no CRS or vertical datum we cannot VERIFY co-registration, so it
    // is honestly flagged unverified rather than asserted co-registered.
    expect(cmp!.coregistered).toBe(false);
    expect(cmp!.coregistrationNotes.join(' ')).toMatch(/unknown/i);
  });

  it('identical epochs read as no net change', () => {
    const a = plane(30, 5);
    const cmp = compareEpochClouds({ positions: a }, { positions: plane(30, 5) });
    expect(cmp).not.toBeNull();
    expect(Math.abs(cmp!.result.stats.netVolumeM3)).toBeLessThan(1e-3);
  });

  it('aligns two clouds by their origins (different origins, same world footprint)', () => {
    // A is recentred by origin (1000,2000): its local 0..30 is world 1000..1030.
    // B already sits at world 1000..1030 with origin 0. Differencing raw LOCAL
    // coordinates would find zero overlap (all NaN); aligning by origin makes the
    // two epochs fully comparable. This guards the world-frame fix.
    const a = plane(30, 0);
    const b = plane(30, 1, 1000, 2000); // local already at world 1000..1030, +1 m
    const cmp = compareEpochClouds(
      { positions: a, origin: [1000, 2000, 0] },
      { positions: b, origin: [0, 0, 0] },
    );
    expect(cmp).not.toBeNull();
    expect(cmp!.result.stats.comparable).toBeGreaterThan(0);
    expect(cmp!.result.stats.netVolumeM3).toBeGreaterThan(0);
  });

  it('flags a CRS mismatch between the two epochs', () => {
    const a = plane(20, 0);
    const cmp = compareEpochClouds(
      { positions: a, crs: 'EPSG:32612' },
      { positions: plane(20, 1), crs: 'EPSG:32613' },
    );
    expect(cmp).not.toBeNull();
    expect(cmp!.coregistered).toBe(false);
    expect(cmp!.coregistrationNotes.join(' ')).toContain('CRS differs');
  });
});
