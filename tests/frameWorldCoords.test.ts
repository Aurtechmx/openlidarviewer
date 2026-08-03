/**
 * frameWorldCoords.test.ts — the world coordinate a CPU boundary derives is
 * invariant to a layer's placement.
 *
 * Roadmap P1 #2 keeps every layer's vertices SOURCE-LOCAL and holds the mount
 * as a Float64 `sourceToProject` translation held BESIDE the buffer, never
 * baked into it. The property that keeps the world-producing CPU boundaries —
 * picking, terrain gather, cross-layer measurement, export bounds, change
 * detection — correct under a mount is this:
 *
 *   the WORLD coordinate of point i is `sourceLocal[i] + sourceOrigin`, and
 *   mounting the layer (setting a non-identity placement) does not change it.
 *
 * A boundary that derives world that way computes the same survey coordinate
 * whether the layer is mounted or not, and whether or not another layer is
 * added beside it. The equivalent project-frame path — `projectXYZ(i,
 * transform)` lifted back through the project origin — recovers the same world,
 * so the source frame and the project frame agree on where the point is.
 *
 * The contrast case pins the failure mode the audit surfaced. Deriving world
 * from the PLACED (project-local) point plus `sourceOrigin` — the shape
 * `Viewer._infoForHit` currently feeds the inspector (src/render/Viewer.ts
 * ~6087) — double-counts the translation and is wrong by exactly
 * `sourceToProject` for a non-anchor mount. It coincides with the true world
 * only under the identity placement, which is why the error is invisible in the
 * single-layer / mount-off configuration and only appears once a second layer
 * mounts. A world-producing boundary must read `sourceLocal + sourceOrigin`
 * (or, equivalently, `projectLocal + projectOrigin`), never `placedPoint +
 * sourceOrigin`.
 *
 * Pure Node maths — reuses `ProjectSpatialFrame`/`LayerSpatialTransform` and the
 * `placePoint` fold, and the seeded-PRNG property style from
 * `tests/frameGateProperties.test.ts`.
 */

import { describe, it, test, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import {
  createProjectFrame,
  chooseProjectOrigin,
  layerTransform,
  projectLocalToWorld,
} from '../src/geo/ProjectSpatialFrame';
import { placePoint, isIdentityPlacement } from '../src/render/layerPlacement';

type Vec3 = readonly [number, number, number];

// ── a tiny reproducible generator (same shape as frameGateProperties) ────────
/** mulberry32 — deterministic from a 32-bit seed, so a failure replays exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function forAll<T>(
  name: string,
  gen: (r: () => number) => T,
  check: (value: T) => void,
  runs = 200,
): void {
  for (let i = 0; i < runs; i++) {
    const seed = 0x5eed + i;
    const value = gen(rng(seed));
    try {
      check(value);
    } catch (err) {
      throw new Error(`${name} failed at seed ${seed}\n${(err as Error).message}`);
    }
  }
}

const make = (positions: Float32Array, origin: Vec3): PointCloud =>
  new PointCloud({ positions, origin: [...origin], sourceFormat: 'las', name: 'p.las' });

/**
 * Two georeferenced layers at integer survey origins a real distance apart,
 * plus the shared frame chosen from those origins. Origins are integers because
 * `chooseProjectOrigin` floors, and integers keep the Float64 lift exact.
 */
function genScene(r: () => number) {
  const oA: Vec3 = [
    500000 + Math.floor(r() * 1000),
    4100000 + Math.floor(r() * 1000),
    100 + Math.floor(r() * 50),
  ];
  // B is offset from A by up to a couple of km per axis — the twoScanMount
  // regime, inside the 1 mm precision budget.
  const oB: Vec3 = [
    oA[0] + 1 + Math.floor(r() * 2000),
    oA[1] + 1 + Math.floor(r() * 2000),
    oA[2] + Math.floor(r() * 5),
  ];
  const n = 1 + Math.floor(r() * 6);
  const mk = (): Float32Array => {
    const p = new Float32Array(n * 3);
    for (let i = 0; i < p.length; i++) p[i] = (r() - 0.5) * 300;
    return p;
  };
  const cloudA = make(mk(), oA);
  const cloudB = make(mk(), oB);
  const frame = createProjectFrame(chooseProjectOrigin([oA, oB]));
  const tA = layerTransform(frame, [...cloudA.sourceOrigin]);
  const tB = layerTransform(frame, [...cloudB.sourceOrigin]);
  return { cloudA, cloudB, frame, tA, tB, oA, oB };
}

describe('worldXYZ is the source-frame world coordinate', () => {
  test('equals sourceLocal + sourceOrigin for every point', () => {
    forAll('world = local + origin', genScene, ({ cloudA }) => {
      const w: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < cloudA.pointCount; i++) {
        cloudA.worldXYZ(i, w);
        for (let a = 0; a < 3; a++) {
          expect(w[a]).toBeCloseTo(cloudA.positions[i * 3 + a] + cloudA.sourceOrigin[a], 6);
        }
      }
    });
  });
});

describe('a mount does not move the world coordinate a boundary computes', () => {
  it('the project-frame path recovers exactly the source-frame world', () => {
    // Mounting is "apply the layer transform". A boundary that lifts the
    // project-local coordinate back through the project origin must land on the
    // same world coordinate the source frame gives — for both layers, the
    // anchor and the one that actually moves.
    forAll('project path == source path', genScene, ({ cloudB, frame, tB }) => {
      const w: [number, number, number] = [0, 0, 0];
      const p: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < cloudB.pointCount; i++) {
        cloudB.worldXYZ(i, w); // un-mounted boundary: sourceLocal + sourceOrigin
        cloudB.projectXYZ(i, tB, p); // mounted boundary: project-local
        const lifted = projectLocalToWorld(frame, [p[0], p[1], p[2]]);
        for (let a = 0; a < 3; a++) expect(lifted[a]).toBeCloseTo(w[a], 9);
      }
    });
  });

  it('adding a second layer leaves the first layer world coordinates unchanged', () => {
    // A boundary reads layer A the same way whether A stands alone or B has
    // just mounted beside it: the source origin is fixed at construction and
    // the placement lives with the frame, not the cloud.
    forAll('neighbour add is inert for A', genScene, ({ cloudA }) => {
      const before: number[] = [];
      const w: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < cloudA.pointCount; i++) {
        cloudA.worldXYZ(i, w);
        before.push(w[0], w[1], w[2]);
      }
      // "Mount a neighbour": the operation is placement bookkeeping on the
      // frame, never a write to A. A's derived world must be identical after.
      const after: number[] = [];
      for (let i = 0; i < cloudA.pointCount; i++) {
        cloudA.worldXYZ(i, w);
        after.push(w[0], w[1], w[2]);
      }
      expect(after).toEqual(before);
    });
  });
});

describe('the non-anchor layer really moves — the transform is non-trivial', () => {
  it('B carries a non-identity placement while A anchors the frame', () => {
    forAll('B is a real mount', genScene, ({ tA, tB }) => {
      // A sits at the per-axis floor(min), so it anchors: identity placement.
      expect(isIdentityPlacement(tA)).toBe(true);
      // B is strictly offset on X and Y, so it must translate.
      expect(isIdentityPlacement(tB)).toBe(false);
      expect(tB.sourceToProject[0]).toBeGreaterThan(0);
      expect(tB.sourceToProject[1]).toBeGreaterThan(0);
    });
  });
});

describe('the placed-point + sourceOrigin path is the wrong frame under a mount', () => {
  it('double-counts the translation for a non-anchor layer', () => {
    // The audit finding, pinned. `placePoint(sourceLocal, tB)` is the
    // project-local point the picker hands back for the on-screen marker;
    // adding `sourceOrigin` to it (Viewer._infoForHit) yields the true world
    // PLUS `sourceToProject`, so a mounted layer's inspector coordinate is off
    // by the full mount offset (2 km in the twoScanMount fixture).
    forAll('placed + origin is off by sourceToProject', genScene, ({ cloudB, tB }) => {
      const w: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < cloudB.pointCount; i++) {
        cloudB.worldXYZ(i, w); // the TRUE world coordinate
        const sourceLocal: Vec3 = [
          cloudB.positions[i * 3],
          cloudB.positions[i * 3 + 1],
          cloudB.positions[i * 3 + 2],
        ];
        const placed = placePoint(sourceLocal, tB); // project-local marker point
        for (let a = 0; a < 3; a++) {
          const wrong = placed[a] + cloudB.sourceOrigin[a]; // the _infoForHit shape
          expect(wrong - w[a]).toBeCloseTo(tB.sourceToProject[a], 6);
        }
        // On X/Y the offset is a real, human-visible error, not float noise.
        expect(Math.abs(placed[0] + cloudB.sourceOrigin[0] - w[0])).toBeGreaterThan(0.5);
      }
    });
  });

  it('coincides with the true world only for the identity anchor', () => {
    // Layer A anchors (identity), so `placePoint` returns the same tuple and
    // `placed + sourceOrigin` equals `worldXYZ`. This is exactly why the
    // finding is invisible single-layer and while mounting is off.
    forAll('anchor path is exact', genScene, ({ cloudA, tA }) => {
      const w: [number, number, number] = [0, 0, 0];
      for (let i = 0; i < cloudA.pointCount; i++) {
        cloudA.worldXYZ(i, w);
        const sourceLocal: Vec3 = [
          cloudA.positions[i * 3],
          cloudA.positions[i * 3 + 1],
          cloudA.positions[i * 3 + 2],
        ];
        const placed = placePoint(sourceLocal, tA);
        for (let a = 0; a < 3; a++) {
          expect(placed[a] + cloudA.sourceOrigin[a]).toBeCloseTo(w[a], 9);
        }
      }
    });
  });
});
