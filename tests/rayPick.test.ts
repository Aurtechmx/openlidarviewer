/**
 * rayPick.test.ts — the grid ray-picker must agree with the linear picker.
 *
 * The whole point of the index is speed WITHOUT a change in which point is
 * picked. So the test is not "close enough": across randomized clouds and rays
 * it diffs `pickAlongRay` against the shipping `nearestPointAlongRay` under the
 * same angular acceptance gate, and requires the identical winning point index
 * (and matching offset/along on that winner). Any grid bug that visits too few
 * cells shows up here as a disagreement, not as a silently worse pick.
 *
 * Pure Node. No DOM, no three.js, no I/O, no Math.random — clouds and rays come
 * from a seeded mulberry32 so every failure reproduces.
 */
import { describe, it, expect } from 'vitest';

import { buildRayPickIndex, pickAlongRay } from '../src/render/pick/rayPick';
import { nearestPointAlongRay, type Vec3 } from '../src/render/navMath';

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function cloud(points: ReadonlyArray<readonly [number, number, number]>): Float32Array {
  const out = new Float32Array(points.length * 3);
  points.forEach((p, i) => { out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; });
  return out;
}

/** What the linear picker accepts under `offset/along < tolerance`. */
function linearIndex(positions: Float32Array, o: Vec3, d: Vec3, tol: number, accept?: (i: number) => boolean): number | null {
  const hit = nearestPointAlongRay(positions, o, d, accept);
  if (hit === null) return null;
  return hit.offset / hit.along < tol ? hit.index : null;
}

const TOLERANCES = [0.02, 0.07, 0.3];

describe('rayPick — small known cases', () => {
  it('returns null on an empty cloud', () => {
    const idx = buildRayPickIndex(new Float32Array(0));
    expect(pickAlongRay(idx, [0, 0, 0], [1, 0, 0], 0.07)).toBeNull();
  });

  it('picks a point sitting on the ray', () => {
    const idx = buildRayPickIndex(cloud([[5, 0, 0], [5, 4, 0]]));
    const hit = pickAlongRay(idx, [0, 0, 0], [1, 0, 0], 0.07);
    expect(hit?.index).toBe(0);
    expect(hit?.along).toBeCloseTo(5, 9);
    expect(hit?.offset).toBeCloseTo(0, 9);
  });

  it('ignores points behind the origin', () => {
    const idx = buildRayPickIndex(cloud([[-5, 0, 0], [5, 0, 0]]));
    expect(pickAlongRay(idx, [0, 0, 0], [1, 0, 0], 0.07)?.index).toBe(1);
  });

  it('rejects a point outside the angular tolerance', () => {
    // offset 3, along 4 -> score 0.75, far above any tested tolerance.
    const idx = buildRayPickIndex(cloud([[4, 3, 0]]));
    expect(pickAlongRay(idx, [0, 0, 0], [1, 0, 0], 0.07)).toBeNull();
  });

  it('breaks an exact tie on the lowest point index', () => {
    const idx = buildRayPickIndex(cloud([[5, 0, 0], [5, 0, 0], [5, 0, 0]]));
    expect(pickAlongRay(idx, [0, 0, 0], [1, 0, 0], 0.07)?.index).toBe(0);
  });

  it('returns null for a zero-length or non-finite direction', () => {
    const idx = buildRayPickIndex(cloud([[5, 0, 0]]));
    expect(pickAlongRay(idx, [0, 0, 0], [0, 0, 0], 0.07)).toBeNull();
    expect(pickAlongRay(idx, [0, 0, 0], [Number.NaN, 0, 0], 0.07)).toBeNull();
  });

  it('is scale-invariant in the direction (need not be unit length)', () => {
    const idx = buildRayPickIndex(cloud([[5, 0.1, 0]]));
    const a = pickAlongRay(idx, [0, 0, 0], [1, 0, 0], 0.07);
    const b = pickAlongRay(idx, [0, 0, 0], [7, 0, 0], 0.07);
    expect(a?.index).toBe(b?.index);
    expect(a?.along).toBeCloseTo(b?.along ?? -1, 9);
  });
});

describe('rayPick — parity with nearestPointAlongRay across randomized clouds', () => {
  it('returns the identical winning point under the same acceptance gate', () => {
    let hits = 0; // sanity: make sure we actually exercise the accepted branch
    for (let seed = 1; seed <= 260; seed++) {
      const rand = mulberry32(seed);
      const n = [1, 2, 40, 400][seed % 4];
      const scale = [1e-2, 1, 1e3][seed % 3];
      const pts: Array<readonly [number, number, number]> = [];
      for (let i = 0; i < n; i++) {
        pts.push([rand() * scale, rand() * scale, rand() * scale]);
      }
      // Salt some clouds with exact duplicates and an axis-hugging line to
      // stress ties and near-axis reordering.
      if (seed % 5 === 0 && n > 3) {
        pts.push([...pts[0]] as [number, number, number]);
        for (let i = 0; i < 5; i++) pts.push([i * scale * 0.1, 1e-6 * scale, 0]);
      }
      const positions = cloud(pts);
      const idx = buildRayPickIndex(positions);

      for (const tol of TOLERANCES) {
        for (let trial = 0; trial < 6; trial++) {
          let o: Vec3;
          let d: Vec3;
          if (trial < 4) {
            // Targeted ray: aim from a random origin roughly at a random point,
            // so the accepted branch is frequently exercised.
            const target = pts[Math.floor(rand() * pts.length)];
            o = [rand() * scale, rand() * scale, -scale - rand() * scale];
            d = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
            // small jitter so it does not pass exactly through the point
            d = [d[0] + (rand() - 0.5) * 0.02 * scale, d[1] + (rand() - 0.5) * 0.02 * scale, d[2]];
          } else {
            o = [rand() * scale, rand() * scale, rand() * scale];
            d = [rand() - 0.5, rand() - 0.5, rand() - 0.5];
          }
          if (Math.hypot(d[0], d[1], d[2]) === 0) continue;

          const lin = nearestPointAlongRay(positions, o, d);
          const linScore = lin === null ? Infinity : lin.offset / lin.along;
          const grid = pickAlongRay(idx, o, d, tol);

          if (linScore < tol * (1 - 1e-6)) {
            // Clearly accepted: the grid must return the same winning point.
            expect(grid).not.toBeNull();
            expect(grid?.index).toBe(lin?.index);
            expect(grid?.along).toBeCloseTo(lin?.along ?? -1, 6);
            expect(grid?.offset).toBeCloseTo(lin?.offset ?? -1, 6);
            hits++;
          } else if (linScore > tol * (1 + 1e-6)) {
            // Clearly rejected: nothing is inside the cone.
            expect(grid).toBeNull();
          }
          // else: within a hair of the gate boundary — skip (ULP-sensitive).
        }
      }
    }
    expect(hits).toBeGreaterThan(200);
  });

  it('honours an accept predicate identically to the linear scan', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const rand = mulberry32(seed * 7 + 3);
      const pts: Array<readonly [number, number, number]> = [];
      for (let i = 0; i < 120; i++) pts.push([rand() * 100, rand() * 100, rand() * 100]);
      const positions = cloud(pts);
      const idx = buildRayPickIndex(positions);
      const accept = (i: number): boolean => i % 3 !== 0;

      const target = pts[Math.floor(rand() * pts.length)];
      const o: Vec3 = [rand() * 100, rand() * 100, -120];
      const d: Vec3 = [target[0] - o[0], target[1] - o[1], target[2] - o[2]];
      const tol = 0.1;

      const lin = linearIndex(positions, o, d, tol, accept);
      const grid = pickAlongRay(idx, o, d, tol, accept);
      expect(grid === null ? null : grid.index).toBe(lin);
    }
  });
});
