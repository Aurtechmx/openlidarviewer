/**
 * stratifiedRmse.test.ts — hold-out RMSE stratified by slope band + zone.
 */

import { describe, it, expect } from 'vitest';
import { holdoutValidateDtm } from '../src/terrain/validate/holdoutRmse';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

/** A dense grid of points on a plane z = slope·x. */
function plane(slope: number, span = 20): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let ix = 0; ix < span; ix++) {
    for (let iy = 0; iy < span; iy++) {
      // jitter within the cell so multiple returns can land per cell
      pts.push({ x: ix + 0.25, y: iy + 0.25, z: slope * ix });
      pts.push({ x: ix + 0.75, y: iy + 0.75, z: slope * ix });
    }
  }
  return pts;
}

describe('holdoutValidateDtm — stratified reporting', () => {
  it('populates perSlopeBand and perZone, summing to the covered sample size', () => {
    const pts = plane(0.04); // ~2.3° → flat band
    const report = holdoutValidateDtm(pts, new Uint8Array(pts.length).fill(1), {
      cellSizeM: 1,
      seed: 7,
    });
    expect(report.sampleSize).toBeGreaterThan(0);

    expect(report.perSlopeBand).toBeDefined();
    expect(report.perSlopeBand).toHaveLength(3);
    const slopeTotal = report.perSlopeBand!.reduce((s, b) => s + b.count, 0);
    expect(slopeTotal).toBe(report.sampleSize);
    // A gentle plane is dominated by the flat band.
    const flat = report.perSlopeBand!.find((b) => b.band === 'flat')!;
    expect(flat.count).toBeGreaterThan(report.sampleSize / 2);

    expect(report.perZone).toBeDefined();
    expect(report.perZone).toHaveLength(2);
    const zoneTotal = report.perZone!.reduce((s, z) => s + z.count, 0);
    expect(zoneTotal).toBe(report.sampleSize);
  });

  it('a steep plane lands its samples in the steep band', () => {
    const pts = plane(0.6); // ~31° → steep band
    const report = holdoutValidateDtm(pts, new Uint8Array(pts.length).fill(1), {
      cellSizeM: 1,
      seed: 7,
    });
    const steep = report.perSlopeBand!.find((b) => b.band === 'steep')!;
    const flat = report.perSlopeBand!.find((b) => b.band === 'flat')!;
    expect(steep.count).toBeGreaterThan(flat.count);
  });
});
