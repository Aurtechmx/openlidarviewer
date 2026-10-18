import { describe, expect, test } from 'vitest';
import { alignEpochClouds, summarizeAlignment } from '../src/terrain/change/alignEpochs';
import { buildRegistrationArtifact, summarizeRegistration } from '../src/terrain/change/registrationArtifact';
import type { EpochCloud } from '../src/terrain/change/compareEpochs';

/**
 * The shift an alignment states is the displacement at the before sample's
 * centroid. The transform's translation turns its yaw about the world origin,
 * so at projected coordinates a fraction of a degree reads as kilometres.
 * The epochs declare one CRS, so these tests opt in to a fit with
 * `commonFrame: 'estimate'`; by default their coordinates are kept.
 */

const ORIGIN: [number, number, number] = [500000, 4000000, 0];
const surf = (x: number, y: number): number => 3 * Math.sin(x / 9) + 2 * Math.cos(y / 7) + 0.02 * x;

/** A 1 m lattice over 100 x 100 local metres, turned `yawDeg` about its centre and shifted. */
function lattice(yawDeg = 0, dx = 0, dy = 0): Float32Array {
  const a = (yawDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out: number[] = [];
  for (let x = 0; x <= 100; x++) {
    for (let y = 0; y <= 100; y++) {
      const u = x - 50, v = y - 50;
      out.push(c * u - s * v + 50 + dx, s * u + c * v + 50 + dy, surf(x, y));
    }
  }
  return new Float32Array(out);
}

const epoch = (positions: Float32Array): EpochCloud => ({
  positions, origin: ORIGIN, crs: 'EPSG:32612', verticalDatum: 'NAVD88', linearUnitToMetres: 1,
});

describe('alignment shift at UTM coordinates', () => {
  const { alignment } = alignEpochClouds(epoch(lattice()), epoch(lattice(0.5, 0.3, -0.2)), { maxResidualM: 10, horizontalUnitKnown: true, commonFrame: 'estimate' });

  test('the 0.5° yaw is recovered and applied', () => {
    expect(alignment.applied).toBe(true);
    expect(alignment.yawDeg).toBeCloseTo(-0.5, 3);
  });

  test('the translation term is about the world origin and is large', () => {
    expect(Math.hypot(alignment.translation[0], alignment.translation[1])).toBeGreaterThan(1000);
  });

  test('the stated shift is the centroid displacement, about the 0.36 m offset', () => {
    const c = alignment.centroidShiftM!;
    const shift = Math.hypot(c[0], c[1]);
    expect(shift).toBeCloseTo(Math.hypot(0.3, 0.2), 2);
    const summary = summarizeAlignment(alignment);
    expect(summary).toContain(`${shift.toFixed(2)} m shift at the before sample's centroid`);
    expect(summary).not.toMatch(/\d{3,}\.\d+ m shift/);
  });

  test('the registration record carries and states the centroid shift', () => {
    const art = buildRegistrationArtifact(alignment, { targetId: 'a', targetName: 'a', sourceId: 'b', sourceName: 'b' }, 0);
    expect(art.centroidShiftM).toEqual(alignment.centroidShiftM);
    const c = alignment.centroidShiftM!;
    expect(summarizeRegistration(art)).toContain(`shift ${Math.hypot(c[0], c[1]).toFixed(3)} m at the centroid`);
  });
});
