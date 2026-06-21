/**
 * compareEpochs.test.ts — the two-epoch end-to-end path: ground-filter +
 * rasterise both clouds onto ONE shared grid, then diff. Exercises the real
 * terrain leaves (not mocks), so it proves the shared-grid wiring co-registers.
 */

import { describe, it, expect } from 'vitest';
import { buildSharedEpochDtms, compareEpochClouds } from '../src/terrain/change/compareEpochs';

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
});

describe('compareEpochClouds', () => {
  it('a +1 m raised surface reads as accretion, co-registered', () => {
    const a = plane(30, 0);
    const b = plane(30, 1); // same footprint, lifted 1 m
    const cmp = compareEpochClouds({ positions: a }, { positions: b });
    expect(cmp).not.toBeNull();
    expect(cmp!.coregistered).toBe(true);
    // b − a ≈ +1 m everywhere → net volume strongly positive, gain >> loss.
    expect(cmp!.result.stats.netVolumeM3).toBeGreaterThan(0);
    expect(cmp!.result.stats.gainVolumeM3).toBeGreaterThan(cmp!.result.stats.lossVolumeM3);
    expect(cmp!.result.aligned).toBe(true);
  });

  it('identical epochs read as no net change', () => {
    const a = plane(30, 5);
    const cmp = compareEpochClouds({ positions: a }, { positions: plane(30, 5) });
    expect(cmp).not.toBeNull();
    expect(Math.abs(cmp!.result.stats.netVolumeM3)).toBeLessThan(1e-3);
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
