/**
 * profileCorridor.test.ts
 *
 * The section extractor and the derived sampler must accept exactly the same
 * returns. These tests hold the two against each other on clouds built to
 * land points on and beside the capsule boundary, under several `up` axes.
 *
 * Agreement is asserted per bin and exactly. A single point resolving to a
 * different bin, or accepted by one side and not the other, fails.
 */
import { describe, it, expect } from 'vitest';
import { sampleProfile, AUTO_CORRIDOR_FRACTION } from '../src/render/measure/profileSampler';
import { buildProfileFrame } from '../src/render/measure/profileGeometry';
import {
  profileCorridorAccepts,
  profileCorridorBin,
  resolveCorridorHalfWidth,
  createProfileHitScratch,
  PROFILE_HIT_CHAINAGE,
  PROFILE_HIT_LATERAL,
  PROFILE_HIT_HEIGHT,
} from '../src/render/measure/profileCorridor';
import type { Vec3 } from '../src/render/navMath';

/**
 * Golden-ratio low-discrepancy sequence. Deterministic, and unlike a fixed
 * stride it does not align with any structure in the generated cloud.
 */
function lowDiscrepancy(i: number): number {
  return (i * 0.6180339887498949) % 1;
}

/** Per-bin accepted counts, computed through the shared corridor predicate. */
function countsViaPredicate(
  positions: Float32Array,
  a: Vec3,
  b: Vec3,
  up: Vec3,
  bandWidth: number | null,
  samples: number,
): number[] {
  const frame = buildProfileFrame(a, b, up);
  const band = resolveCorridorHalfWidth(frame.horizontalLength, bandWidth, AUTO_CORRIDOR_FRACTION);
  const bandSq = band * band;
  const scratch = createProfileHitScratch();
  const counts: number[] = new Array<number>(samples).fill(0);
  const n = positions.length / 3;
  for (let i = 0; i < n; i++) {
    const ok = profileCorridorAccepts(
      frame,
      band,
      bandSq,
      positions[i * 3],
      positions[i * 3 + 1],
      positions[i * 3 + 2],
      scratch,
    );
    if (!ok) continue;
    const bin = profileCorridorBin(
      scratch[PROFILE_HIT_CHAINAGE],
      frame.horizontalLength,
      samples,
    );
    counts[bin]++;
  }
  return counts;
}

/** Per-bin accepted counts as reported by the derived sampler. */
function countsViaSampler(
  positions: Float32Array,
  a: Vec3,
  b: Vec3,
  up: Vec3,
  bandWidth: number | null,
  samples: number,
): number[] {
  // `count` is optional on ProfileSample for pre-v0.4.5 series, and
  // `sampleProfile` always emits it. Coercing a missing one to 0 would let
  // this comparison agree with an extractor that found nothing, so a missing
  // count is an error here rather than a default.
  return sampleProfile({ positions, a, b, up, bandWidth, samples }).map((s) => {
    if (s.count === undefined) throw new Error('sampleProfile omitted a bin count');
    return s.count;
  });
}

/**
 * A cloud whose points cluster on the corridor boundary.
 *
 * Half the points are placed at a lateral offset drawn from a set that
 * includes exactly `band`, one ulp inside and one ulp outside, so the
 * inclusive-boundary rule is exercised rather than assumed. The rest scatter
 * across and beyond both end caps, including the diagonal corner region that
 * separates a capsule from a bounding rectangle.
 */
function boundaryCloud(
  count: number,
  band: number,
  a: Vec3,
  b: Vec3,
  up: Vec3,
): Float32Array {
  const out = new Float32Array(count * 3);
  const offsets = [
    band,
    band * (1 + 2 * Number.EPSILON),
    band * (1 - 2 * Number.EPSILON),
    band * 0.5,
    band * 1.5,
    0,
  ];
  // Generate in the section's own frame so the cloud is boundary-dense for
  // this exact a/b/up rather than for a canonical one.
  const frame = buildProfileFrame(a, b, up);
  const length = frame.horizontalLength;
  const along = frame.along;
  const lat = frame.lateral;
  const u = frame.up;
  const anchor = frame.horizontalAnchor;
  for (let i = 0; i < count; i++) {
    // Chainage sweeps past both caps so the radial cap region is populated.
    const s = lowDiscrepancy(i) * (length + 4 * band) - 2 * band;
    const d = offsets[i % offsets.length] * (i % 2 === 0 ? 1 : -1);
    const h = lowDiscrepancy(i * 7 + 3) * 20;
    out[i * 3] = anchor[0] + along[0] * s + lat[0] * d + u[0] * h;
    out[i * 3 + 1] = anchor[1] + along[1] * s + lat[1] * d + u[1] * h;
    out[i * 3 + 2] = anchor[2] + along[2] * s + lat[2] * d + u[2] * h;
  }
  return out;
}

const CASES: { name: string; up: Vec3; a: Vec3; b: Vec3 }[] = [
  { name: 'Z-up, axis aligned', up: [0, 0, 1], a: [0, 0, 0], b: [100, 0, 0] },
  { name: 'Z-up, oblique section', up: [0, 0, 1], a: [-13, 7, 2], b: [61, 44, 9] },
  { name: 'Y-up', up: [0, 1, 0], a: [0, 0, 0], b: [80, 5, 30] },
  { name: 'X-up', up: [1, 0, 0], a: [3, -2, 0], b: [4, 55, 40] },
  {
    name: 'oblique up',
    up: [0.3, 0.5, 0.8119], // normalised inside buildProfileFrame
    a: [1, 2, 3],
    b: [70, 40, 25],
  },
];

describe('profile corridor predicate agrees with the derived sampler', () => {
  for (const c of CASES) {
    for (const samples of [32, 64, 512]) {
      it(`${c.name}, ${samples} stations, explicit band`, () => {
        const band = 2.5;
        const cloud = boundaryCloud(4000, band, c.a, c.b, c.up);
        const viaPredicate = countsViaPredicate(cloud, c.a, c.b, c.up, band, samples);
        const viaSampler = countsViaSampler(cloud, c.a, c.b, c.up, band, samples);
        expect(viaPredicate).toEqual(viaSampler);
        // A vacuous pass would be two all-zero arrays; require real coverage.
        const total = viaSampler.reduce((x, y) => x + y, 0);
        expect(total).toBeGreaterThan(200);
      });
    }

    it(`${c.name}, automatic corridor width`, () => {
      const cloud = boundaryCloud(4000, 5, c.a, c.b, c.up);
      const viaPredicate = countsViaPredicate(cloud, c.a, c.b, c.up, null, 64);
      const viaSampler = countsViaSampler(cloud, c.a, c.b, c.up, null, 64);
      expect(viaPredicate).toEqual(viaSampler);
      expect(viaSampler.reduce((x, y) => x + y, 0)).toBeGreaterThan(200);
    });
  }
});

describe('profile corridor edge behaviour', () => {
  const up: Vec3 = [0, 0, 1];
  const a: Vec3 = [0, 0, 0];
  const b: Vec3 = [10, 0, 0];
  const frame = buildProfileFrame(a, b, up);
  const band = 1;
  const scratch = createProfileHitScratch();

  const accepts = (x: number, y: number, z: number): boolean =>
    profileCorridorAccepts(frame, band, band * band, x, y, z, scratch);

  it('accepts a point exactly on the lateral boundary', () => {
    expect(accepts(5, 1, 0)).toBe(true);
  });

  it('rejects a point outside the lateral boundary', () => {
    expect(accepts(5, 1.0000001, 0)).toBe(false);
  });

  it('closes the ends with a cap rather than a square corner', () => {
    // Diagonal corner: inside a bounding rectangle of half-width 1 extended
    // to the endpoint, outside a capsule because its radial distance from the
    // endpoint is sqrt(2) * 0.9 > 1.
    expect(accepts(-0.9, 0.9, 0)).toBe(false);
    // Same chainage, on the section axis: inside the cap.
    expect(accepts(-0.9, 0, 0)).toBe(true);
  });

  it('rejects a point beyond the far cap', () => {
    expect(accepts(11.0000001, 0, 0)).toBe(false);
    expect(accepts(11, 0, 0)).toBe(true);
  });

  it('rejects non-finite coordinates', () => {
    expect(accepts(Number.NaN, 0, 0)).toBe(false);
    expect(accepts(5, Number.POSITIVE_INFINITY, 0)).toBe(false);
  });

  it('signs the lateral offset by side, and reports chainage along the line', () => {
    // frame.lateral is up x along. For up = +Z and along = +X that is +Y, so
    // a point at +Y sits on the positive side. A sign flip or a swap with
    // chainage would mirror the section, which the counts alone cannot see.
    expect(accepts(3, 0.5, 0)).toBe(true);
    expect(scratch[PROFILE_HIT_LATERAL]).toBeCloseTo(0.5, 12);
    expect(scratch[PROFILE_HIT_CHAINAGE]).toBeCloseTo(3, 12);

    expect(accepts(3, -0.5, 0)).toBe(true);
    expect(scratch[PROFILE_HIT_LATERAL]).toBeCloseTo(-0.5, 12);
    expect(scratch[PROFILE_HIT_CHAINAGE]).toBeCloseTo(3, 12);

    // Under a reversed section the same physical point takes the other side.
    const rev = buildProfileFrame(b, a, up);
    expect(profileCorridorAccepts(rev, band, band * band, 3, 0.5, 0, scratch)).toBe(true);
    expect(scratch[PROFILE_HIT_LATERAL]).toBeCloseTo(-0.5, 12);
    expect(scratch[PROFILE_HIT_CHAINAGE]).toBeCloseTo(7, 12);
  });

  it('reports height along up, not z, under a Y-up frame', () => {
    const yUp: Vec3 = [0, 1, 0];
    const yFrame = buildProfileFrame([0, 0, 0], [10, 0, 0], yUp);
    const ok = profileCorridorAccepts(yFrame, 1, 1, 5, 42, 0.5, scratch);
    expect(ok).toBe(true);
    expect(scratch[PROFILE_HIT_HEIGHT]).toBeCloseTo(42, 12);
  });
});
