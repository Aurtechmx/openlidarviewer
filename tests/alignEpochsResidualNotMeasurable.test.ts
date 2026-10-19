/**
 * alignEpochsResidualNotMeasurable.test.ts
 *
 * The residual at the applied pose is the RMS distance from each sampled point
 * to its nearest partner, over pairs inside the correspondence distance. When
 * the real change between the epochs is larger than that distance no pair is
 * left and the residual is not a number. The summary used to print
 * "Residual at the applied pose Infinity m" and the registration record stored
 * Infinity, which JSON writes as null with no reason.
 */
import { describe, expect, it } from 'vitest';
import { alignEpochClouds, summarizeAlignment } from '../src/terrain/change/alignEpochs';
import { buildRegistrationArtifact, summarizeRegistration } from '../src/terrain/change/registrationArtifact';

/** A 31 x 31 relief lattice at 0.1 m spacing, raised by `dz`. */
function lattice(dz: number): Float32Array {
  const out: number[] = [];
  for (let x = 0; x <= 30; x++) {
    for (let y = 0; y <= 30; y++) out.push(x * 0.1, y * 0.1, 0.2 * Math.sin(x / 4) + 0.15 * Math.cos(y / 3) + dz);
  }
  return new Float32Array(out);
}
const before = { positions: lattice(0), crs: null, verticalDatum: null, linearUnitToMetres: 1 };
const scans = { targetId: 'a', targetName: 'before.laz', sourceId: 'b', sourceName: 'after.laz' };

describe('a change larger than the correspondence distance', () => {
  const r = alignEpochClouds(before, { ...before, positions: lattice(1) }, { maxResidualM: 0.1 });
  const a = r.alignment;

  it('is applied horizontally and has no measurable residual at the applied pose', () => {
    expect(a.applied).toBe(true);
    expect(a.appliedDof).toBe('yaw+xy');
    // 1 m of real change against a 3-spacing correspondence distance of 0.3 m.
    expect(a.correspondenceDistanceM).toBeLessThan(1);
    expect(a.appliedTransformResidualM).toBe(Infinity);
  });

  it('the summary says so and prints no infinite figure', () => {
    const s = summarizeAlignment(a);
    expect(s).toContain('Residual at the applied pose not measurable: change exceeds the correspondence distance');
    expect(s).not.toMatch(/Infinity|NaN/);
    // The solver fit residual, which is finite, is still reported.
    expect(s).toMatch(/solver fit residual \(yaw \+ x\/y\/z, not what was applied\) \d+\.\d{2} m/);
  });

  it('the registration record holds null with a reason, and survives JSON', () => {
    const art = buildRegistrationArtifact(a, scans, 0);
    expect(art.appliedTransformResidualM).toBeNull();
    expect(art.appliedTransformResidualReason).toBe('not measurable: change exceeds the correspondence distance');
    expect(art.solverResidualM).toBeGreaterThanOrEqual(0);
    expect(art.solverResidualReason).toBeNull();
    const round = JSON.parse(JSON.stringify(art)) as typeof art;
    expect(round.appliedTransformResidualM).toBeNull();
    expect(round.appliedTransformResidualReason).toContain('correspondence distance');
    const line = summarizeRegistration(art);
    expect(line).toContain('residual at applied pose not measurable: change exceeds the correspondence distance');
    expect(line).not.toMatch(/Infinity|NaN/);
  });
});

describe('a measurable residual keeps its number and has no reason', () => {
  it('a small vertical offset inside the correspondence distance', () => {
    const r = alignEpochClouds(before, { ...before, positions: lattice(0.1) }, { maxResidualM: 0.1 });
    expect(r.alignment.applied).toBe(true);
    expect(Number.isFinite(r.alignment.appliedTransformResidualM)).toBe(true);
    const art = buildRegistrationArtifact(r.alignment, scans, 0);
    expect(art.appliedTransformResidualM).toBeCloseTo(r.alignment.appliedTransformResidualM, 12);
    expect(art.appliedTransformResidualReason).toBeNull();
    expect(summarizeAlignment(r.alignment)).toMatch(/Residual at the applied pose \d+\.\d{2} m/);
  });
});

describe('a record with no fit', () => {
  it('stores null residuals with their reasons instead of Infinity', () => {
    const geo = { ...before, crs: 'EPSG:32612', verticalDatum: 'NAVD88' };
    const r = alignEpochClouds(geo, { ...geo, positions: lattice(1) }, { maxResidualM: 0.1 });
    const art = buildRegistrationArtifact(r.alignment, scans, 0);
    expect(art.frameKept).toBe(true);
    expect(art.solverResidualM).toBeNull();
    expect(art.solverResidualReason).toBe('not computed: the supplied coordinates were kept and no fit ran');
    expect(art.appliedTransformResidualM).toBeNull();
    expect(JSON.stringify(art)).not.toContain('Infinity');
  });
});
