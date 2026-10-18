import { describe, expect, test } from 'vitest';
import { alignEpochClouds, meanPointSpacing, summarizeAlignment } from '../src/terrain/change/alignEpochs';
import { buildSharedEpochDtms, type EpochCloud } from '../src/terrain/change/compareEpochs';
import { compareDtms } from '../src/terrain/change/compareDtms';

/**
 * Two epochs in one CRS whose footprints differ. The solve starts at the
 * identity pose, rejects pairs beyond a few point spacings and measures the
 * overlap at that distance, so a difference in extent is not read as a
 * misregistration.
 */

const surf = (x: number, y: number): number => 3 * Math.sin(x / 9) + 2 * Math.cos(y / 7) + 0.02 * x;

/** A 1 m lattice over [x0,x1]×[y0,y1], moved by `pose` (yaw about the scene centre, then shift). */
function lattice(x0: number, x1: number, y0: number, y1: number, pose = { dx: 0, dy: 0, yawDeg: 0 }): Float32Array {
  const out: number[] = [];
  const a = (pose.yawDeg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      const u = x - 50, v = y - 50;
      out.push(c * u - s * v + 50 + pose.dx, s * u + c * v + 50 + pose.dy, surf(x, y));
    }
  }
  return new Float32Array(out);
}

const epoch = (positions: Float32Array): EpochCloud => ({
  positions, crs: 'EPSG:32612', verticalDatum: 'NAVD88', linearUnitToMetres: 1,
});

/**
 * The gate the compare flow passes (10 % of the before epoch's span), with the
 * common-CRS fit opted in: by default these epochs keep their coordinates.
 */
const LIVE = { maxResidualM: 10, horizontalUnitKnown: true, commonFrame: 'estimate' as const };

describe('alignEpochClouds keeps the coordinates of a common-CRS pair by default', () => {
  test('no fit, no shift, the after cloud returned as supplied', () => {
    const after = epoch(lattice(0, 100, 0, 100, { dx: 0.5, dy: 0.3, yawDeg: 1 }));
    const r = alignEpochClouds(epoch(lattice(0, 100, 0, 100)), after, { maxResidualM: 10, horizontalUnitKnown: true });
    expect(r.alignment.frameKept).toBe(true);
    expect(r.alignment.attempted).toBe(false);
    expect(r.alignment.applied).toBe(false);
    expect(r.after).toBe(after);
    expect(summarizeAlignment(r.alignment)).toMatch(/not estimated/i);
  });
});

const shiftOf = (t: readonly number[]): number => Math.hypot(t[0], t[1]);

describe('alignEpochClouds on epochs of different extent, no true offset', () => {
  test('after extends 30 % past before: no false shift, overlap measured at the correspondence distance', () => {
    const { alignment } = alignEpochClouds(epoch(lattice(0, 100, 0, 100)), epoch(lattice(0, 130, 0, 100)), LIVE);
    expect(alignment.identityStart).toBe(true);
    expect(!alignment.applied || shiftOf(alignment.translation) < 0.05).toBe(true);
    expect(Math.abs(alignment.yawDeg)).toBeLessThan(0.05);
    // The true overlap is 101 / 131 columns ≈ 0.77; the old gate reported 0.90.
    expect(alignment.overlapFraction).toBeGreaterThan(0.74);
    expect(alignment.overlapFraction).toBeLessThan(0.82);
  });

  test('after extends 60 % past before: no false shift', () => {
    const { alignment } = alignEpochClouds(epoch(lattice(0, 100, 0, 100)), epoch(lattice(0, 160, 0, 100)), LIVE);
    expect(!alignment.applied || shiftOf(alignment.translation) < 0.05).toBe(true);
  });

  test('the difference over the shared footprint is about zero', () => {
    const before = epoch(lattice(0, 100, 0, 100));
    const { after } = alignEpochClouds(before, epoch(lattice(0, 130, 0, 100)), LIVE);
    const dtms = buildSharedEpochDtms(before, after)!;
    const cmp = compareDtms(dtms.before, dtms.after, { horizontalUnitToMetres: 1, horizontalUnitKnown: true, levelOfDetectionM: 0.1 });
    const s = cmp.result.stats;
    expect(s.comparable).toBeGreaterThan(0);
    expect(s.meanAbsChangeM).toBeLessThan(0.05);
    expect(Math.abs(s.rawNetVolumeM3)).toBeLessThan(50);
  });
});

describe('alignEpochClouds recovers a genuine small misregistration', () => {
  const truth = { dx: 0.5, dy: 0.3, yawDeg: 1 };

  /** Max horizontal error of the aligned after lattice against the unmoved lattice. */
  function residualError(before: [number, number], afterX1: number): { applied: boolean; err: number; shift: number } {
    const ref = lattice(0, afterX1, 0, 100);
    const { after, alignment } = alignEpochClouds(epoch(lattice(0, before[1], 0, 100)), epoch(lattice(0, afterX1, 0, 100, truth)), LIVE);
    let err = 0;
    for (let i = 0; i < ref.length; i += 3) {
      err = Math.max(err, Math.hypot(after.positions[i] - ref[i], after.positions[i + 1] - ref[i + 1]));
    }
    return { applied: alignment.applied, err, shift: shiftOf(alignment.translation) };
  }

  test('full overlap: recovered to a few centimetres', () => {
    const r = residualError([0, 100], 100);
    expect(r.applied).toBe(true);
    expect(r.err).toBeLessThan(0.1);
  });

  test('30 % extent difference: recovered within tolerance or withheld, never a large false shift', () => {
    const r = residualError([0, 100], 130);
    if (r.applied) expect(r.err).toBeLessThan(0.25);
    expect(r.shift).toBeLessThan(3);
  });
});

describe('alignEpochClouds withholds a move the starting pose does not support', () => {
  test('a shift larger than the correspondence distance is not applied', () => {
    const { alignment } = alignEpochClouds(epoch(lattice(0, 100, 0, 100)), epoch(lattice(0, 100, 0, 100, { dx: 20, dy: 0, yawDeg: 0 })), LIVE);
    expect(alignment.applied).toBe(false);
    expect(summarizeAlignment(alignment)).toMatch(/withheld|refused/i);
  });
});

describe('meanPointSpacing', () => {
  test('a 1 m lattice reads about 1 m', () => {
    const p = lattice(0, 50, 0, 50);
    const pts: [number, number, number][] = [];
    for (let i = 0; i < p.length; i += 3) pts.push([p[i], p[i + 1], p[i + 2]]);
    expect(meanPointSpacing(pts)).toBeGreaterThan(0.9);
    expect(meanPointSpacing(pts)).toBeLessThan(1.15);
  });

  test('an L-shaped footprint is not read as sparse', () => {
    const pts: [number, number, number][] = [];
    for (let x = 0; x <= 100; x++) for (let y = 0; y <= 10; y++) pts.push([x, y, 0]);
    for (let x = 0; x <= 10; x++) for (let y = 11; y <= 100; y++) pts.push([x, y, 0]);
    expect(meanPointSpacing(pts)).toBeLessThan(1.3);
  });

  test('no horizontal extent is NaN', () => {
    expect(meanPointSpacing([[1, 1, 0], [1, 1, 5]])).toBeNaN();
  });
});
