/**
 * reclassifyLassoUserState.test.ts
 *
 * A live report said "classification seems off, when trying to reclassify its
 * not letting me" on a USGS 3DEP tile: 37,333,283 declared points, 1,888,921
 * resident after the stride-then-voxel reduction, four class codes
 * (1 / 2 / 7 / 18) in a ~95.5 / 4.4 / 0.12 / 0.004 split, elevation 657-989 m,
 * intensity 7239-65535, opened coloured by HEIGHT because too few points carry
 * a producer class for the class ramp to read.
 *
 * This rebuilds `Viewer.reclassifyLasso`'s composition out of the SAME
 * production helpers (`selectByLasso` + `filterSelectionToVisible` +
 * `buildPointFilterAccept` + `applyIndexReclassify`, with the window built by
 * `elevWindowFieldsFor` exactly as `Viewer._currentFilterWindow` builds it) and
 * walks the observed state one variable at a time, so "the edit refused"
 * becomes a measurement rather than a guess.
 *
 * The result the fix rests on: with the windows the Inspector SEEDS on open
 * (floor(min) / ceil(max) of the loaded sample) the edit lands on every axis:
 * seeded-and-inactive, seeded-and-active, class mask all-visible. The engine
 * does not refuse. What the user sees is a silent success, which is what the
 * legend-refresh fix addresses.
 */

import { describe, it, expect } from 'vitest';
import {
  selectByLasso,
  filterSelectionToVisible,
  type ScreenProjector,
  type Vec2,
} from '../src/render/measure/lassoVolume';
import { applyIndexReclassify } from '../src/render/measure/classificationEditor';
import {
  buildPointFilterAccept,
  elevWindowFieldsFor,
  type PointFilterWindow,
} from '../src/render/pointFilterAccept';

// ── The user's scan, at 1/100 scale ──────────────────────────────────────────

/** The Z origin the LAS loader subtracted; positions are stored origin-shifted. */
const ORIGIN_Z = 823.5;
/** World elevation span of the tile, as the Inspector reports it. */
const WORLD_MIN_Z = 657.32;
const WORLD_MAX_Z = 988.74;
/** Raw intensity span of the loaded sample, as the Inspector reports it. */
const INTEN_MIN = 7239;
const INTEN_MAX = 65535;

/** The user's class split, scaled to a testable count. */
const SPLIT: ReadonlyArray<readonly [number, number]> = [
  [1, 18034], // Unclassified
  [2, 830], // Ground
  [7, 23], // Low point (noise)
  [18, 1], // High noise
];

interface Fixture {
  positions: Float32Array;
  classification: Uint8Array;
  intensity: Uint16Array;
  count: number;
}

/**
 * A tile-shaped cloud: points on a 1 km grid, elevations spanning the reported
 * world range (stored origin-shifted, the frame `cloud.positions` really live
 * in), intensities spanning the reported raw range with the MINIMUM present, so
 * a window whose lower bound equals the sample minimum is exercised at the edge.
 */
function buildFixture(): Fixture {
  const count = SPLIT.reduce((n, [, c]) => n + c, 0);
  const positions = new Float32Array(count * 3);
  const classification = new Uint8Array(count);
  const intensity = new Uint16Array(count);
  const side = Math.ceil(Math.sqrt(count));
  let i = 0;
  for (const [code, n] of SPLIT) {
    for (let k = 0; k < n; k++, i++) {
      const gx = i % side;
      const gy = Math.floor(i / side);
      const t = i / (count - 1);
      positions[i * 3] = gx * 1.0;
      positions[i * 3 + 1] = gy * 1.0;
      // Origin-shifted attribute space, the frame the buffer is stored in.
      positions[i * 3 + 2] = WORLD_MIN_Z + t * (WORLD_MAX_Z - WORLD_MIN_Z) - ORIGIN_Z;
      classification[i] = code;
      intensity[i] = Math.round(INTEN_MIN + t * (INTEN_MAX - INTEN_MIN));
    }
  }
  return { positions, classification, intensity, count };
}

/** Top-down orthographic projector: screen == XY. Stands in for the camera. */
const topDown: ScreenProjector = (x, y) => ({ x, y });

/** An axis-aligned screen box as a lasso ring. */
function lassoBox(minX: number, maxX: number, minY: number, maxY: number): Vec2[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

/** The all-visible 256-entry class mask `applyClassVisibility` writes. */
function allVisibleMask(): Float32Array {
  return new Float32Array(256).fill(1);
}

/**
 * `Viewer._currentFilterWindow`, rebuilt from the same pure helper it calls:
 * the elevation window converts with THIS cloud's origin and up-axis.
 */
function windowFor(opts: {
  classActive?: boolean;
  classMask?: ArrayLike<number> | null;
  elevWorld?: readonly [number, number];
  intenWindow?: readonly [number, number];
}): PointFilterWindow {
  const e = elevWindowFieldsFor(opts.elevWorld, ORIGIN_Z, 2);
  return {
    classActive: opts.classActive ?? false,
    classMask: opts.classMask ?? allVisibleMask(),
    elevActive: opts.elevWorld !== undefined,
    elevAxisIdx: e.elevAxisIdx,
    elevMin: e.elevMin,
    elevMax: e.elevMax,
    intenActive: opts.intenWindow !== undefined,
    intenMin: opts.intenWindow?.[0] ?? 0,
    intenMax: opts.intenWindow?.[1] ?? 0,
  };
}

/** `Viewer.reclassifyLasso`'s body, over the same helpers, minus three.js. */
function reclassifyLasso(
  fx: Fixture,
  lasso: ReadonlyArray<Vec2>,
  newClass: number,
  window: PointFilterWindow,
): number {
  const indices = selectByLasso({ lasso, positions: fx.positions, project: topDown });
  filterSelectionToVisible(indices, fx.positions, {
    acceptIndex: buildPointFilterAccept(
      fx.positions,
      fx.classification,
      fx.intensity,
      window,
    ),
  });
  return applyIndexReclassify(fx.classification, indices, newClass).changedCount;
}

// ── The walk ─────────────────────────────────────────────────────────────────

describe('reclassify lasso on the reported scan state', () => {
  /** A lasso over the middle of the tile; it certainly contains points. */
  const lasso = lassoBox(10, 120, 10, 120);

  it('edits points with no filter armed (the baseline the report contradicts)', () => {
    const fx = buildFixture();
    expect(reclassifyLasso(fx, lasso, 2, windowFor({}))).toBeGreaterThan(0);
  });

  it('still edits with the SEEDED elevation window armed', () => {
    // The Inspector seeds floor(min) / ceil(max), so a seeded window is WIDER
    // than the data and can never exclude a point the user drew around.
    const fx = buildFixture();
    const seeded: [number, number] = [Math.floor(WORLD_MIN_Z), Math.ceil(WORLD_MAX_Z)];
    expect(reclassifyLasso(fx, lasso, 2, windowFor({ elevWorld: seeded }))).toBeGreaterThan(0);
  });

  it('still edits with the SEEDED intensity window armed, minimum included', () => {
    // The lower bound EQUALS the sample minimum here, so this is the boundary
    // comparison: `buildPointFilterAccept` is inclusive (`< min` rejects), and
    // the point whose intensity is exactly the minimum must survive.
    const fx = buildFixture();
    const seeded: [number, number] = [INTEN_MIN, INTEN_MAX];
    const changed = reclassifyLasso(fx, lasso, 2, windowFor({ intenWindow: seeded }));
    expect(changed).toBeGreaterThan(0);
    // The point AT the minimum is in the kept set, not shaved off the edge.
    const atMin = fx.intensity.indexOf(INTEN_MIN);
    expect(atMin).toBeGreaterThanOrEqual(0);
    expect(buildPointFilterAccept(
      fx.positions,
      fx.classification,
      fx.intensity,
      windowFor({ intenWindow: seeded }),
    )!(atMin)).toBe(true);
  });

  it('still edits with the class filter armed and every class visible', () => {
    const fx = buildFixture();
    const w = windowFor({ classActive: true, classMask: allVisibleMask() });
    expect(reclassifyLasso(fx, lasso, 2, w)).toBeGreaterThan(0);
  });

  it('refuses only when a filter genuinely hides the drawn points', () => {
    // The one state that DOES return zero: a window the user narrowed past the
    // points they drew around. This is the refusal the UI must say out loud.
    const fx = buildFixture();
    const hidden = windowFor({ elevWorld: [WORLD_MAX_Z - 1, WORLD_MAX_Z] });
    const selected = selectByLasso({ lasso, positions: fx.positions, project: topDown });
    expect(selected.length).toBeGreaterThan(0);
    expect(reclassifyLasso(fx, lasso, 2, hidden)).toBe(0);
  });
});
