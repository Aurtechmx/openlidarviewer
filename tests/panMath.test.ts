/**
 * panMath.test.ts
 *
 * Unit tests for the P1 hand tool's pure geometry and input mapping
 * (docs/_audit/v0.5.5-program.md §P1): the locked-plane drag model, the
 * screen-space fallback, the pointer-down eligibility gate, and the
 * Digit4 / G key mapping.
 *
 * The heart of the suite is a scripted-drag simulator with a pure pinhole
 * camera: it locks a plane at pointer-down exactly like NavController does,
 * walks a pointer path, applies each returned delta to camera AND target,
 * and asserts the program's acceptance criteria numerically —
 *
 *   - the grabbed world point re-projects onto the pointer at EVERY step
 *     (the "physically attached" 1:1 contract),
 *   - no jump at pointer-down (zero delta for a zero pointer move),
 *   - camera and target translate by the same vector,
 *   - camera-target distance is constant within 1e-10 relative,
 *   - the same holds at high (post-recenter worst-case) coordinates.
 */

import { describe, it, expect } from 'vitest';
import type { Vec3 } from '../src/render/navMath';
import {
  intersectRayPlane,
  panGestureKind,
  panModeForKey,
  panPlaneDelta,
  screenPanDelta,
} from '../src/render/panMath';

// ── Tiny vector helpers (kept local — the module under test is pure) ──────
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => scale(a, 1 / len(a));
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * A pure pinhole camera: position + orthonormal basis (right/up/forward),
 * vertical fov and aspect. Mirrors how three.js maps NDC to rays for a
 * PerspectiveCamera, without importing three.js (Node-safe).
 */
interface PinholeCam {
  pos: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  fovDeg: number;
  aspect: number;
}

/** The world-space ray direction through an NDC point. */
function rayThrough(cam: PinholeCam, ndcX: number, ndcY: number): Vec3 {
  const t = Math.tan((cam.fovDeg * Math.PI) / 360);
  return norm(
    add(
      cam.forward,
      add(scale(cam.right, ndcX * t * cam.aspect), scale(cam.up, ndcY * t)),
    ),
  );
}

/** Project a world point to NDC (x right, y up). */
function projectToNdc(cam: PinholeCam, w: Vec3): [number, number] {
  const v = sub(w, cam.pos);
  const z = dot(v, cam.forward);
  const t = Math.tan((cam.fovDeg * Math.PI) / 360);
  return [dot(v, cam.right) / (z * t * cam.aspect), dot(v, cam.up) / (z * t)];
}

/** A camera looking from `pos` toward `target`, world-up +Z (LAS style). */
function lookAt(pos: Vec3, target: Vec3, fovDeg = 60, aspect = 16 / 9): PinholeCam {
  const forward = norm(sub(target, pos));
  const right = norm(cross(forward, [0, 0, 1]));
  const up = cross(right, forward);
  return { pos, right, up, forward, fovDeg, aspect };
}

// ─────────────────────────────────────────────────────────────────────────
// intersectRayPlane
// ─────────────────────────────────────────────────────────────────────────

describe('intersectRayPlane', () => {
  it('hits an axis-aligned plane at the expected point', () => {
    const hit = intersectRayPlane([0, 0, 10], [0, 0, -1], [0, 0, 0], [0, 0, 1]);
    expect(hit).not.toBeNull();
    expect(hit![0]).toBeCloseTo(0, 12);
    expect(hit![1]).toBeCloseTo(0, 12);
    expect(hit![2]).toBeCloseTo(0, 12);
  });

  it('hits an oblique ray where geometry says it should', () => {
    // Ray from (0,0,10) with dir (1,0,-1)/√2 meets z=0 at (10,0,0).
    const d = norm([1, 0, -1]);
    const hit = intersectRayPlane([0, 0, 10], d, [5, 5, 0], [0, 0, 1]);
    expect(hit).not.toBeNull();
    expect(hit![0]).toBeCloseTo(10, 10);
    expect(hit![1]).toBeCloseTo(0, 10);
    expect(hit![2]).toBeCloseTo(0, 10);
  });

  it('returns null for a grazing (parallel) ray', () => {
    expect(
      intersectRayPlane([0, 0, 10], [1, 0, 0], [0, 0, 0], [0, 0, 1]),
    ).toBeNull();
  });

  it('returns null when the plane lies behind the ray origin', () => {
    expect(
      intersectRayPlane([0, 0, 10], [0, 0, 1], [0, 0, 0], [0, 0, 1]),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// panPlaneDelta — one drag step
// ─────────────────────────────────────────────────────────────────────────

describe('panPlaneDelta', () => {
  it('is exactly zero at pointer-down (no jump at gesture start)', () => {
    const cam = lookAt([0, -20, 10], [0, 0, 0]);
    const dir = rayThrough(cam, 0.31, -0.12);
    const grab = intersectRayPlane(cam.pos, dir, [0, 0, 0], cam.forward)!;
    const delta = panPlaneDelta(cam.pos, dir, grab, [0, 0, 0], cam.forward)!;
    expect(len(delta)).toBeLessThan(1e-12);
  });

  it('returns grab − hit, a vector parallel to the locked plane', () => {
    const cam = lookAt([3, -20, 12], [0, 0, 0]);
    const planePoint: Vec3 = [0, 0, 0];
    const dir0 = rayThrough(cam, 0, 0);
    const grab = intersectRayPlane(cam.pos, dir0, planePoint, cam.forward)!;
    const dir1 = rayThrough(cam, 0.4, 0.25);
    const hit = intersectRayPlane(cam.pos, dir1, planePoint, cam.forward)!;
    const delta = panPlaneDelta(cam.pos, dir1, grab, planePoint, cam.forward)!;
    expect(delta).toEqual(sub(grab, hit));
    // Parallel to the plane: no component along the normal.
    expect(Math.abs(dot(delta, cam.forward))).toBeLessThan(1e-10);
  });

  it('returns null for a grazing ray so the caller can fall back', () => {
    expect(
      panPlaneDelta([0, 0, 10], [1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scripted drag — the program's acceptance criteria, numerically
// ─────────────────────────────────────────────────────────────────────────

/**
 * Run a full scripted drag exactly the way NavController does: lock the
 * plane at pointer-down (through `target`, normal = camera forward), then
 * for each pointer NDC position compute the delta and translate camera AND
 * target by it. Returns per-step diagnostics for the assertions.
 */
function runScriptedDrag(
  camPos: Vec3,
  target: Vec3,
  path: Array<[number, number]>,
): {
  reprojErr: number[];
  distRelDrift: number[];
  camMinusTargetConst: number[];
} {
  const cam = lookAt(camPos, target);
  let pos: Vec3 = [...camPos] as Vec3;
  let tgt: Vec3 = [...target] as Vec3;
  const planePoint: Vec3 = [...target] as Vec3; // locked, never recomputed
  const normal = cam.forward; // locked
  const dist0 = len(sub(pos, tgt));
  const offset0 = sub(pos, tgt);

  const grab = intersectRayPlane(pos, rayThrough(cam, path[0][0], path[0][1]), planePoint, normal)!;
  expect(grab).not.toBeNull();

  const reprojErr: number[] = [];
  const distRelDrift: number[] = [];
  const camMinusTargetConst: number[] = [];

  for (const [nx, ny] of path) {
    const liveCam: PinholeCam = { ...cam, pos };
    const dir = rayThrough(liveCam, nx, ny);
    const delta = panPlaneDelta(pos, dir, grab, planePoint, normal);
    expect(delta).not.toBeNull();
    pos = add(pos, delta!);
    tgt = add(tgt, delta!);

    // Re-project the locked grab point through the moved camera: it must sit
    // under the pointer (the 1:1 "physically attached" acceptance).
    const [px, py] = projectToNdc({ ...cam, pos }, grab);
    reprojErr.push(Math.hypot(px - nx, py - ny));
    distRelDrift.push(Math.abs(len(sub(pos, tgt)) - dist0) / dist0);
    camMinusTargetConst.push(len(sub(sub(pos, tgt), offset0)));
  }
  return { reprojErr, distRelDrift, camMinusTargetConst };
}

/** A 24-step wandering pointer path across most of the viewport. */
const DRAG_PATH: Array<[number, number]> = Array.from({ length: 24 }, (_, i) => {
  const t = i / 23;
  return [-0.7 + 1.4 * t, 0.5 * Math.sin(t * Math.PI * 2) - 0.2 * t];
});

describe('scripted drag — locked-plane acceptance', () => {
  it('keeps the grabbed point under the pointer for the whole drag', () => {
    const { reprojErr } = runScriptedDrag([5, -30, 18], [0, 0, 2], DRAG_PATH);
    for (const err of reprojErr) expect(err).toBeLessThan(1e-9);
  });

  it('translates camera and target by the same vector at every step', () => {
    const { camMinusTargetConst } = runScriptedDrag([5, -30, 18], [0, 0, 2], DRAG_PATH);
    for (const d of camMinusTargetConst) expect(d).toBeLessThan(1e-9);
  });

  it('keeps camera-target distance constant within 1e-10 relative', () => {
    const { distRelDrift } = runScriptedDrag([5, -30, 18], [0, 0, 2], DRAG_PATH);
    for (const drift of distRelDrift) expect(drift).toBeLessThan(1e-10);
  });

  it('meets the same criteria at high post-recenter coordinates', () => {
    // The pipeline recentres survey coordinates to a per-cloud integer
    // origin in double precision (src/io/coordinateBridge.ts), so camera and
    // target live at modest local magnitudes — but a worst-case local frame
    // (a partially-recentred multi-cloud scene) can still reach ~1e5–1e6.
    // Deltas stay double-precision throughout, so 1:1 must survive.
    const base: Vec3 = [250_000, 1_000_000, 4_000];
    const { reprojErr, distRelDrift } = runScriptedDrag(
      add(base, [5, -30, 18]),
      add(base, [0, 0, 2]),
      DRAG_PATH,
    );
    for (const err of reprojErr) expect(err).toBeLessThan(1e-8);
    for (const drift of distRelDrift) expect(drift).toBeLessThan(1e-10);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// screenPanDelta — the grazing-angle fallback
// ─────────────────────────────────────────────────────────────────────────

describe('screenPanDelta', () => {
  const right: Vec3 = [1, 0, 0];
  const up: Vec3 = [0, 0, 1];

  it('moves the camera opposite the pointer horizontally, with it vertically', () => {
    // Pointer right (+dx) → scene follows pointer → camera moves LEFT.
    const d1 = screenPanDelta(10, 0, 800, 60, 20, right, up);
    expect(d1[0]).toBeLessThan(0);
    // Pointer down (+dy in canvas coords) → camera moves UP.
    const d2 = screenPanDelta(0, 10, 800, 60, 20, right, up);
    expect(d2[2]).toBeGreaterThan(0);
  });

  it('scales by world-units-per-pixel at the target distance', () => {
    // A full-height drag covers the full vertical view extent:
    // 2 · tan(fov/2) · dist world units.
    const h = 900;
    const dist = 25;
    const d = screenPanDelta(0, h, h, 60, dist, right, up);
    expect(len(d)).toBeCloseTo(2 * Math.tan(Math.PI / 6) * dist, 10);
  });

  it('clamps a near-zero target distance instead of degenerating', () => {
    const d = screenPanDelta(5, 5, 800, 60, 0, right, up);
    expect(Number.isFinite(d[0])).toBe(true);
    expect(Number.isFinite(d[1])).toBe(true);
    expect(Number.isFinite(d[2])).toBe(true);
    expect(len(d)).toBeLessThan(1e-6); // ~zero motion, never NaN/∞
  });
});

// ─────────────────────────────────────────────────────────────────────────
// panGestureKind — pointer-down eligibility
// ─────────────────────────────────────────────────────────────────────────

describe('panGestureKind', () => {
  const base = { button: 0, pointerType: 'mouse', mode: 'pan', handPanEnabled: true, activeTouchCount: 0 };

  it('primary mouse drag pans in pan mode only', () => {
    expect(panGestureKind({ ...base })).toBe('pan');
    for (const mode of ['orbit', 'walk', 'fly']) {
      expect(panGestureKind({ ...base, mode })).toBeNull();
    }
  });

  it('pen behaves like the primary mouse button', () => {
    expect(panGestureKind({ ...base, pointerType: 'pen' })).toBe('pan');
  });

  it('middle mouse is a temporary grab in ANY mode', () => {
    for (const mode of ['orbit', 'walk', 'fly', 'pan']) {
      expect(panGestureKind({ ...base, button: 1, mode })).toBe('temp');
    }
  });

  it('one-finger touch pans in pan mode; a second finger is never claimed', () => {
    const touch = { ...base, pointerType: 'touch', activeTouchCount: 1 };
    expect(panGestureKind(touch)).toBe('pan');
    // Two fingers belong to the Viewer's twist/pinch/pan recogniser.
    expect(panGestureKind({ ...touch, activeTouchCount: 2 })).toBeNull();
    // Touch outside pan mode stays with OrbitControls / the recogniser.
    expect(panGestureKind({ ...touch, mode: 'orbit' })).toBeNull();
  });

  it('?handPan=off disables every entry point', () => {
    expect(panGestureKind({ ...base, handPanEnabled: false })).toBeNull();
    expect(panGestureKind({ ...base, handPanEnabled: false, button: 1, mode: 'walk' })).toBeNull();
    expect(
      panGestureKind({ ...base, handPanEnabled: false, pointerType: 'touch', activeTouchCount: 1 }),
    ).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// panModeForKey — Digit4 / G bindings
// ─────────────────────────────────────────────────────────────────────────

describe('panModeForKey', () => {
  it('Digit4 selects pan mode (joins the Digit1/2/3 group)', () => {
    for (const mode of ['orbit', 'walk', 'fly', 'pan']) {
      expect(panModeForKey('Digit4', mode, true)).toBe('pan');
    }
  });

  it('G toggles: into pan from anywhere, back to orbit from pan', () => {
    for (const mode of ['orbit', 'walk', 'fly']) {
      expect(panModeForKey('KeyG', mode, true)).toBe('pan');
    }
    expect(panModeForKey('KeyG', 'pan', true)).toBe('orbit');
  });

  it('?handPan=off makes both keys inert', () => {
    expect(panModeForKey('Digit4', 'orbit', false)).toBeNull();
    expect(panModeForKey('KeyG', 'orbit', false)).toBeNull();
  });

  it('every other key is not a hand-tool binding', () => {
    for (const code of ['Digit1', 'Digit2', 'Digit3', 'KeyH', 'KeyP', 'Space']) {
      expect(panModeForKey(code, 'orbit', true)).toBeNull();
    }
  });
});
