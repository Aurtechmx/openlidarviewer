import { describe, test, expect } from 'vitest';
import { alignEpochClouds, summarizeAlignment } from '../src/terrain/change/alignEpochs';
import type { EpochCloud } from '../src/terrain/change/compareEpochs';

type P = [number, number, number];

function cloudFrom(pts: P[], origin?: [number, number, number]): EpochCloud {
  const f = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    f[i * 3] = p[0];
    f[i * 3 + 1] = p[1];
    f[i * 3 + 2] = p[2];
  });
  return origin ? { positions: f, origin } : { positions: f };
}

/** Deterministic, asymmetric scatter so ICP can resolve translation AND yaw. */
function scatter(n: number, seed = 12345): P[] {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const pts: P[] = [];
  for (let i = 0; i < n; i++) {
    const x = rnd() * 20; // wide span on x
    const y = rnd() * 8; // narrower on y → not rotationally symmetric
    const z = Math.sin(x * 0.3) + rnd() * 0.02;
    pts.push([x, y, z]);
  }
  return pts;
}

describe('alignEpochClouds', () => {
  test('identical clouds align to a near-identity transform', () => {
    const a = cloudFrom(scatter(200));
    const b = cloudFrom(scatter(200)); // same seed → identical geometry
    const { after, alignment } = alignEpochClouds(a, b);
    expect(alignment.attempted).toBe(true);
    expect(alignment.applied).toBe(true);
    expect(alignment.rmsResidualM).toBeLessThan(1e-3);
    expect(Math.abs(alignment.yawDeg)).toBeLessThan(0.1);
    expect(Math.hypot(alignment.translation[0], alignment.translation[1])).toBeLessThan(1e-2);
    expect(after.positions.length).toBe(b.positions.length);
  });

  test('recovers a horizontal translation and preserves the vertical change', () => {
    const base = scatter(200);
    const before = cloudFrom(base);
    // +3/-2 horizontal shift AND a +0.5 m uniform vertical change (the signal).
    const after = cloudFrom(base.map(([x, y, z]) => [x + 3, y - 2, z + 0.5] as P));
    const r = alignEpochClouds(before, after); // horizontalOnly defaults true
    expect(r.alignment.applied).toBe(true);
    expect(r.alignment.translation[2]).toBe(0); // no z applied
    let maxHoriz = 0;
    let minZDelta = Infinity;
    for (let i = 0; i < base.length; i++) {
      const dx = r.after.positions[i * 3] - base[i][0];
      const dy = r.after.positions[i * 3 + 1] - base[i][1];
      maxHoriz = Math.max(maxHoriz, Math.hypot(dx, dy));
      minZDelta = Math.min(minZDelta, r.after.positions[i * 3 + 2] - base[i][2]);
    }
    expect(maxHoriz).toBeLessThan(0.2); // horizontal misregistration removed
    expect(minZDelta).toBeGreaterThan(0.45); // the +0.5 vertical change survives
  });

  test('horizontalOnly:false applies the full 3-D transform (z included)', () => {
    const base = scatter(200);
    const after = cloudFrom(base.map(([x, y, z]) => [x + 3, y - 2, z + 0.5] as P));
    const r = alignEpochClouds(cloudFrom(base), after, { horizontalOnly: false });
    expect(r.alignment.applied).toBe(true);
    let maxErr = 0;
    for (let i = 0; i < base.length; i++) {
      const dx = r.after.positions[i * 3] - base[i][0];
      const dy = r.after.positions[i * 3 + 1] - base[i][1];
      const dz = r.after.positions[i * 3 + 2] - base[i][2];
      maxErr = Math.max(maxErr, Math.hypot(dx, dy, dz));
    }
    expect(maxErr).toBeLessThan(0.2); // full transform lands after onto before
  });

  test('recovers a small yaw', () => {
    const base = scatter(200);
    const yaw = (2 * Math.PI) / 180; // 2°
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const after = cloudFrom(base.map(([x, y, z]) => [c * x - s * y, s * x + c * y, z] as P));
    const r = alignEpochClouds(cloudFrom(base), after);
    expect(r.alignment.applied).toBe(true);
    expect(Math.abs(r.alignment.yawDeg)).toBeGreaterThan(1.0);
    expect(Math.abs(r.alignment.yawDeg)).toBeLessThan(3.0);
    expect(r.alignment.rmsResidualM).toBeLessThan(0.2);
  });

  test('too few points is degenerate and leaves the cloud untouched', () => {
    const tiny = cloudFrom([[0, 0, 0], [1, 1, 1]]);
    const r = alignEpochClouds(tiny, tiny);
    expect(r.alignment.attempted).toBe(false);
    expect(r.alignment.degenerate).toBe(true);
    expect(r.after).toBe(tiny); // same reference, not transformed
  });

  test('a residual over the gate is refused and the cloud is left as-is', () => {
    const a = cloudFrom(scatter(200, 1));
    const b = cloudFrom(scatter(200, 999)); // unrelated geometry
    const r = alignEpochClouds(a, b, { maxResidualM: 0.001 });
    expect(r.alignment.attempted).toBe(true);
    expect(r.alignment.refused).toBe(true);
    expect(r.alignment.applied).toBe(false);
    expect(r.after).toBe(b); // unchanged reference
  });

  test('a georeferenced (UTM-scale origin) cloud keeps centimetre precision through alignment', () => {
    // The whole point of the origin/local split is float precision: at a UTM
    // northing of ~4,000,000 a Float32 quantises at ~0.25–0.5 m — larger than
    // the centimetre-level misalignment ICP corrects. The aligned cloud must
    // therefore come back as local + origin, never as absolute world values
    // stored in a Float32Array.
    const base = scatter(200);
    const origin: [number, number, number] = [500000, 4000000, 100];
    const before = cloudFrom(base, origin);
    const after = cloudFrom(base.map(([x, y, z]) => [x + 0.5, y, z] as P), origin);
    const { after: aligned, alignment } = alignEpochClouds(before, after);
    expect(alignment.applied).toBe(true);
    const ox = aligned.origin?.[0] ?? 0;
    const oy = aligned.origin?.[1] ?? 0;
    let maxErr = 0;
    for (let i = 0; i < base.length; i++) {
      // World-frame aligned point vs the before epoch's exact world point.
      const wx = aligned.positions[i * 3] + ox;
      const wy = aligned.positions[i * 3 + 1] + oy;
      maxErr = Math.max(
        maxErr,
        Math.abs(wx - (base[i][0] + origin[0])),
        Math.abs(wy - (base[i][1] + origin[1])),
      );
    }
    expect(maxErr).toBeLessThan(0.02); // cm-level, not the ~0.25–0.5 m f32 step
  });

  test('geographic (degree) clouds are never planar-ICP aligned — skipped, untouched', () => {
    // In lon/lat space 1° of longitude ≠ 1° of latitude (cos φ), so a yaw
    // solved in degree space is a SHEAR in metres — the "rigid" transform is
    // geometrically invalid there, and the convergence tolerance/gate are in
    // degree-metres nonsense units. Alignment must refuse the frame outright.
    const base = scatter(100).map(([x, y, z]) => [x * 1e-4, y * 1e-4, z] as P);
    const before: EpochCloud = { ...cloudFrom(base), isGeographic: true };
    const shifted = cloudFrom(base.map(([x, y, z]) => [x + 1e-5, y, z] as P));
    const after: EpochCloud = { ...shifted, isGeographic: true };
    const r = alignEpochClouds(before, after);
    expect(r.alignment.applied).toBe(false);
    expect(r.after).toBe(after); // same reference — not transformed
    expect(summarizeAlignment(r.alignment).toLowerCase()).toContain('geographic');
  });

  test('a foot-CRS cloud reports its shift and residual in METRES, not feet', () => {
    // EpochAlignment promises metres (rmsResidualM / translation docs) and the
    // UI prints "N m". icpRegister works in the clouds' own units, so a
    // foot-CRS survey shifted 10 ft must report ≈3.05 m — printing "10 m"
    // is the wrong-units failure mode the trust system exists to prevent.
    const base = scatter(200);
    const ftToM = 0.3048;
    const before: EpochCloud = { ...cloudFrom(base), linearUnitToMetres: ftToM };
    const after: EpochCloud = {
      ...cloudFrom(base.map(([x, y, z]) => [x + 10, y, z] as P)),
      linearUnitToMetres: ftToM,
    };
    const r = alignEpochClouds(before, after);
    expect(r.alignment.applied).toBe(true);
    const shiftM = Math.hypot(r.alignment.translation[0], r.alignment.translation[1]);
    expect(shiftM).toBeGreaterThan(2.9); // 10 ft ≈ 3.048 m …
    expect(shiftM).toBeLessThan(3.2); // … NOT 10
    expect(r.alignment.rmsResidualM).toBeLessThan(0.05); // metres, near-exact fit
  });

  test('the residual gate is honoured in metres on a foot-CRS cloud', () => {
    // Same-geometry clouds jittered by ±0.25 ft: the RMS residual is ≈0.15 ft
    // ≈ 0.05 m. A 0.1 m (metre-denominated) gate must therefore ACCEPT the
    // fit — comparing the raw foot residual (≈0.15) against 0.1 would refuse.
    const base = scatter(200);
    let s = 424242 >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const jittered = base.map(
      ([x, y, z]) => [x + (rnd() - 0.5) * 0.5, y + (rnd() - 0.5) * 0.5, z] as P,
    );
    const ftToM = 0.3048;
    const before: EpochCloud = { ...cloudFrom(base), linearUnitToMetres: ftToM };
    const after: EpochCloud = { ...cloudFrom(jittered), linearUnitToMetres: ftToM };
    const r = alignEpochClouds(before, after, { maxResidualM: 0.1 });
    expect(r.alignment.rmsResidualM).toBeGreaterThan(0.02); // sanity: real jitter…
    expect(r.alignment.rmsResidualM).toBeLessThan(0.1); // …but under the gate in METRES
    expect(r.alignment.refused).toBe(false);
    expect(r.alignment.applied).toBe(true);
  });

  test('origins are honoured: a shift expressed via origin still aligns', () => {
    const base = scatter(150);
    const before = cloudFrom(base);
    // Same geometry, but expressed as local + a non-zero origin.
    const after = cloudFrom(base, [5, 5, 1]);
    const r = alignEpochClouds(before, after);
    expect(r.alignment.applied).toBe(true);
    // ICP should undo the origin offset (≈5,5 translation back to before).
    expect(Math.hypot(r.alignment.translation[0] + 5, r.alignment.translation[1] + 5)).toBeLessThan(0.3);
  });
});

describe('summarizeAlignment', () => {
  test('applied, refused, and skipped each read clearly', () => {
    const a = cloudFrom(scatter(200));
    const applied = summarizeAlignment(alignEpochClouds(a, cloudFrom(scatter(200))).alignment);
    expect(applied).toMatch(/aligned the after cloud/i);

    const refused = summarizeAlignment(
      alignEpochClouds(cloudFrom(scatter(200, 1)), cloudFrom(scatter(200, 2)), { maxResidualM: 0.001 }).alignment,
    );
    expect(refused).toMatch(/refused/i);

    const skipped = summarizeAlignment(alignEpochClouds(cloudFrom([[0, 0, 0]]), cloudFrom([[0, 0, 0]])).alignment);
    expect(skipped).toMatch(/skipped/i);
  });
});

/**
 * Alignment must not run before the two epochs are shown to share a frame.
 *
 * ICP fits a rigid transform between two point sets. Given two epochs in
 * different CRSs — or on different vertical datums — it will still converge on
 * something and report a residual, because a residual is just a number about
 * the fit, not about whether the fit was meaningful. That residual then reads
 * as a quality figure for a comparison that never had a common frame.
 *
 * The frame check therefore happens BEFORE any sampling or fitting, in the
 * function itself rather than at a call site, so no caller can reach the fit
 * without passing it.
 */
describe('spatial preflight precedes the fit', () => {
  const cloud = (over: Partial<EpochCloud> = {}): EpochCloud => ({
    positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 10, 0, 5, 5, 1]),
    origin: [0, 0, 0],
    crs: 'EPSG:32612',
    verticalDatum: 'EPSG:5703',
    ...over,
  });

  test('refuses a different horizontal CRS and reports no fit', () => {
    const r = alignEpochClouds(cloud(), cloud({ crs: 'EPSG:25829' }));
    expect(r.alignment.frameIncompatible).toBe(true);
    expect(r.alignment.applied).toBe(false);
    expect(r.after).toBe(r.after); // the after cloud is returned untouched
  });

  test('refuses a different vertical datum', () => {
    const r = alignEpochClouds(cloud(), cloud({ verticalDatum: 'EPSG:4979' }));
    expect(r.alignment.frameIncompatible).toBe(true);
    expect(r.alignment.applied).toBe(false);
  });

  test('reports no residual for a refused pair — there is no fit to score', () => {
    const r = alignEpochClouds(cloud(), cloud({ crs: 'EPSG:25829' }));
    // Infinity, never 0 — a zero residual reads as a PERFECT fit, which is
    // the opposite of what "no fit was attempted" means.
    expect(r.alignment.rmsResidualM).toBe(Infinity);
    expect(r.alignment.attempted).toBe(false);
  });

  test('states the reason', () => {
    const r = alignEpochClouds(cloud(), cloud({ crs: 'EPSG:25829' }));
    expect(r.alignment.frameReason ?? '').toMatch(/CRS|frame|datum/i);
  });

  test('proceeds normally when both epochs share the frame', () => {
    const r = alignEpochClouds(cloud(), cloud());
    expect(r.alignment.frameIncompatible).not.toBe(true);
  });

  test('still compares two UNDECLARED scans — silence is not contradiction', () => {
    // Two local scans with no CRS is a real workflow. The comparison path
    // already treats that pair as indicative rather than measured; refusing
    // it here would forbid the case instead of qualifying it, and would put
    // this gate at odds with the one downstream.
    const r = alignEpochClouds(
      cloud({ crs: null, verticalDatum: null }),
      cloud({ crs: null, verticalDatum: null }),
    );
    expect(r.alignment.frameIncompatible).not.toBe(true);
  });

  test('matches NAVD88 against EPSG:5703 rather than refusing on spelling', () => {
    const r = alignEpochClouds(cloud({ verticalDatum: 'NAVD88' }), cloud({ verticalDatum: 'EPSG:5703' }));
    expect(r.alignment.frameIncompatible).not.toBe(true);
  });
});

/**
 * An alignment over undeclared frames must say so in its own summary.
 *
 * The preflight lets two silent epochs through on purpose — comparing local
 * scans is a real workflow — but the summary then reported "Aligned the after
 * cloud horizontally (0.03 m shift, 0.01 m residual)" with no hint that
 * neither epoch had ever declared a frame. Those figures describe the fit
 * accurately and describe the RELATIONSHIP not at all, and a reader takes a
 * residual in metres as evidence of georeferenced agreement.
 */
describe('undeclared frames are labelled indicative', () => {
  const local = (): EpochCloud => ({
    positions: Float32Array.from([0, 0, 0, 10, 0, 0.1, 0, 10, 0.2, 5, 5, 1]),
    origin: [0, 0, 0],
    crs: null,
    verticalDatum: null,
  });
  const referenced = (over: Partial<EpochCloud> = {}): EpochCloud => ({
    ...local(), crs: 'EPSG:32612', verticalDatum: 'EPSG:5703', ...over,
  });

  test('flags a pair where neither epoch declared a frame', () => {
    const r = alignEpochClouds(local(), local());
    expect(r.alignment.frameUnverified).toBe(true);
    expect(summarizeAlignment(r.alignment)).toMatch(/indicative|local frame|not georeferenced/i);
  });

  test('flags a pair where only one epoch declared a frame', () => {
    const r = alignEpochClouds(referenced(), local());
    expect(r.alignment.frameUnverified).toBe(true);
  });

  test('does NOT flag a pair that both declared and agreed', () => {
    const r = alignEpochClouds(referenced(), referenced());
    expect(r.alignment.frameUnverified).not.toBe(true);
    expect(summarizeAlignment(r.alignment)).not.toMatch(/indicative/i);
  });
});
