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
