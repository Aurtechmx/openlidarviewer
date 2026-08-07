/**
 * fixtures.test.ts — the seeded synthetic clouds the suites measure against.
 *
 * Two properties carry the whole reproducibility claim: the same seed must
 * produce the same bytes anywhere, and two different seeds must produce
 * genuinely different data. A generator that quietly ignored its seed would
 * pass every "it produced a cloud" assertion while making every reproducibility
 * hash downstream meaningless.
 *
 * The third group asserts the cloud is worth analysing at all — a uniform
 * random cube would let the DTM, contour and terrain-descriptor benchmarks run
 * green over a surface with no science in it.
 *
 * The clock/random source guard for this module lives in `sourceGuards.test.ts`,
 * which walks all of `benchmarks/` so a module added later is covered by
 * default rather than by someone remembering to copy the check.
 */
import { describe, test, expect } from 'vitest';
import {
  FIXTURE_LADDER,
  CI_DEFAULT_TIER,
  defaultLadder,
  fullLadder,
  generateSyntheticCloud,
  groundElevationAt,
} from '../../benchmarks/fixtures/syntheticCloud';

/** The raw bytes behind a cloud's positions — the strictest identity check. */
function bytesOf(positions: Float32Array): Uint8Array {
  return new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
}

describe('the seeded synthetic cloud', () => {
  test('the same seed and size produce byte-identical point data', () => {
    const a = generateSyntheticCloud({ seed: 42, pointCount: 5_000 });
    const b = generateSyntheticCloud({ seed: 42, pointCount: 5_000 });
    // Byte equality, not value equality: a float comparison would pass on two
    // arrays that differ only in a NaN payload or a -0, both of which change
    // the artifact hash the reproducibility suite computes.
    expect(bytesOf(a.positions)).toEqual(bytesOf(b.positions));
    expect(a.bounds).toEqual(b.bounds);
    expect(a.datasetId).toBe(b.datasetId);
  });

  test('different seeds produce different point data', () => {
    const a = generateSyntheticCloud({ seed: 1, pointCount: 5_000 });
    const b = generateSyntheticCloud({ seed: 2, pointCount: 5_000 });
    expect(bytesOf(a.positions)).not.toEqual(bytesOf(b.positions));
    expect(a.datasetId).not.toBe(b.datasetId);
    // Same landscape, different sampling: the declared extent is a function of
    // the point count alone, so a seed change must move the POINTS, not the
    // tile. Without this a "different seed" could be passing merely because it
    // resized the world.
    expect(a.extentM).toBe(b.extentM);
  });

  test('declares the count and bounds a driver hands to the pipeline', () => {
    const cloud = generateSyntheticCloud({ seed: 7, pointCount: 4_000 });
    expect(cloud.pointCount).toBe(4_000);
    expect(cloud.positions).toHaveLength(4_000 * 3);
    expect(cloud.groundPointCount + cloud.aboveGroundPointCount).toBe(4_000);
    // The declared bounds must be the real extremes of the emitted points —
    // a driver passes them straight to the pipeline's grid, so a declared box
    // that does not contain the data produces a silently clipped raster.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < cloud.pointCount; i++) {
      const x = cloud.positions[i * 3];
      const y = cloud.positions[i * 3 + 1];
      const z = cloud.positions[i * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    expect(cloud.bounds).toEqual({ minX, minY, minZ, maxX, maxY, maxZ });
  });

  test('has real relief and vertical structure, not a flat plane or a uniform cube', () => {
    const cloud = generateSyntheticCloud({ seed: 3, pointCount: 20_000 });
    const relief = cloud.bounds.maxZ - cloud.bounds.minZ;
    expect(relief).toBeGreaterThan(1);

    // The ground surface itself must vary far beyond the noise floor, or the
    // DTM/contour/descriptor benchmarks are measuring noise. Sample the
    // analytic surface on a coarse lattice rather than the returns, so the
    // check is about the SURFACE and not about where points happened to land.
    const zs: number[] = [];
    for (let i = 0; i <= 12; i++) {
      for (let j = 0; j <= 12; j++) {
        zs.push(groundElevationAt(cloud, (i / 12) * cloud.extentM, (j / 12) * cloud.extentM));
      }
    }
    const groundRelief = Math.max(...zs) - Math.min(...zs);
    expect(groundRelief).toBeGreaterThan(cloud.noiseHalfWidthM * 20);

    // …and it must not be a single tilted plane: subtracting a best-fit plane
    // has to leave a substantial residual, which is what a DTM, contour and
    // TPI/VRM pass actually have to resolve.
    const mid = zs[Math.floor(zs.length / 2)];
    const nonPlanar = zs.filter((z) => Math.abs(z - mid) > groundRelief * 0.1).length;
    expect(nonPlanar).toBeGreaterThan(zs.length / 4);

    // Above-ground structure exists, so the ground filter has something to do.
    expect(cloud.aboveGroundPointCount).toBeGreaterThan(0);
    expect(cloud.groundPointCount).toBeGreaterThan(cloud.aboveGroundPointCount);
  });

  test('the size ladder covers 100k…5M and keeps the large tiers opt-in', () => {
    expect(FIXTURE_LADDER.map((t) => t.pointCount)).toEqual([
      100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000,
    ]);
    expect(fullLadder()).toHaveLength(6);
    // Default (CI) run: only the tiers that finish quickly. Pinned as an
    // explicit list — asserting `every(t => !t.optIn)` would only restate the
    // filter `defaultLadder` is defined as, and would still pass if every tier
    // were marked opt-in and the default run measured nothing at all.
    expect(defaultLadder().map((t) => t.pointCount)).toEqual([100_000, 250_000, 500_000]);
    expect(FIXTURE_LADDER.filter((t) => t.optIn).map((t) => t.id)).toEqual(['1m', '2m', '5m']);
    expect(CI_DEFAULT_TIER.pointCount).toBe(100_000);
    // Ladder ids are what a report keys a scaling curve off, so they must be
    // unique and stable.
    expect(new Set(FIXTURE_LADDER.map((t) => t.id)).size).toBe(FIXTURE_LADDER.length);
  });
});
