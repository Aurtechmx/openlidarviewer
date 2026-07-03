/**
 * cameraPath.ts — deterministic inputs for the v0.5.5 P0 scheduler baseline.
 *
 * Two pieces, both pure and seeded:
 *
 *   1. A synthetic COPC octree layout (fixed-seed PRNG) large enough that
 *      the point budget actually bites — selection, eviction, and the
 *      velocity depth caps all engage.
 *   2. A scripted camera path — orbit sweep, wheel-zoom dolly profile, and
 *      rapid rotate-then-stop — expressed as (tMs, cameraPosition,
 *      viewProjection) steps with column-major matrices computed by plain
 *      math (no three.js), matching the Matrix4.elements convention the
 *      scheduler consumes.
 *
 * Everything here is deterministic by construction: same seed, same steps,
 * same floats, on every run and every machine (IEEE-754 basic ops only).
 */

import type { SynthNode } from '../copc/synthCopc';

/** mulberry32 — a tiny deterministic PRNG (public-domain algorithm). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixed seed for the baseline octree. Changing it invalidates the pin. */
export const BASELINE_SEED = 20260702;

/**
 * The baseline octree: root + all 8 depth-1 octants + a seeded subset of
 * depth-2 and depth-3 nodes, with seeded point counts. Node order is the
 * deterministic loop order below (it defines chunk layout and node ids).
 */
export function baselineOctreeNodes(seed = BASELINE_SEED): SynthNode[] {
  const rand = mulberry32(seed);
  const nodes: SynthNode[] = [{ key: [0, 0, 0, 0], pointCount: 8_000 }];
  // Depth 1 — all eight octants.
  for (let x = 0; x <= 1; x++) {
    for (let y = 0; y <= 1; y++) {
      for (let z = 0; z <= 1; z++) {
        nodes.push({ key: [1, x, y, z], pointCount: 3_000 + Math.floor(rand() * 2_000) });
      }
    }
  }
  // Depth 2 — a seeded ~35% subset of the 64 children.
  const depth2: [number, number, number][] = [];
  for (let x = 0; x <= 3; x++) {
    for (let y = 0; y <= 3; y++) {
      for (let z = 0; z <= 3; z++) {
        if (rand() < 0.35) {
          depth2.push([x, y, z]);
          nodes.push({ key: [2, x, y, z], pointCount: 1_200 + Math.floor(rand() * 1_200) });
        }
      }
    }
  }
  // Depth 3 — a seeded ~25% subset of each included depth-2 node's children.
  for (const [px, py, pz] of depth2) {
    for (let dx = 0; dx <= 1; dx++) {
      for (let dy = 0; dy <= 1; dy++) {
        for (let dz = 0; dz <= 1; dz++) {
          if (rand() < 0.25) {
            nodes.push({
              key: [3, px * 2 + dx, py * 2 + dy, pz * 2 + dz],
              pointCount: 500 + Math.floor(rand() * 700),
            });
          }
        }
      }
    }
  }
  return nodes;
}

// ── Column-major matrix math (Matrix4.elements convention) ─────────────────

type Vec3 = readonly [number, number, number];
export type Mat4 = number[];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function normalize(a: Vec3): Vec3 {
  const len = Math.sqrt(dot(a, a));
  return [a[0] / len, a[1] / len, a[2] / len];
}

/** World→camera view matrix for an eye looking at a target (right-handed). */
export function lookAtView(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const z = normalize(sub(eye, target)); // camera looks down −z
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  // prettier-ignore
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

/** Standard perspective projection (OpenGL clip conventions). */
export function perspective(
  fovYRadians: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  const f = 1 / Math.tan(fovYRadians / 2);
  const m: Mat4 = new Array<number>(16).fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** Column-major 4×4 multiply: `out = a × b`. */
export function multiply4(a: Mat4, b: Mat4): Mat4 {
  const out: Mat4 = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[row + 4 * k] * b[k + 4 * col];
      out[row + 4 * col] = sum;
    }
  }
  return out;
}

// ── The scripted camera path ────────────────────────────────────────────────

/** One scheduler tick of the scripted path. */
export interface CameraStep {
  /** Which scenario phase this tick belongs to. */
  phase: 'orbit' | 'wheel-zoom' | 'rotate-fast' | 'settle';
  /** Mock wall-clock time fed to the scheduler's injected `now`. */
  tMs: number;
  cameraPosition: [number, number, number];
  viewProjection: number[];
}

const FOV = (60 * Math.PI) / 180;
const ASPECT = 16 / 9;
const NEAR = 0.1;
const FAR = 5_000;
const UP: Vec3 = [0, 0, 1];
const CENTER: Vec3 = [0, 0, 0];

function step(
  phase: CameraStep['phase'],
  tMs: number,
  eye: Vec3,
): CameraStep {
  const vp = multiply4(perspective(FOV, ASPECT, NEAR, FAR), lookAtView(eye, CENTER, UP));
  return {
    phase,
    tMs,
    cameraPosition: [eye[0], eye[1], eye[2]],
    viewProjection: vp,
  };
}

/**
 * The scripted baseline path (all around the octree centre at the origin):
 *
 *   orbit       24 ticks, 100 ms apart — full 360° sweep at radius 300.
 *   wheel-zoom  12 ticks,  80 ms apart — exponential dolly 300 → 80.
 *   rotate-fast  8 ticks,  50 ms apart — 45°/tick at radius 80 (fast).
 *   settle       8 ticks, 200 ms apart — stationary; the settle window
 *                (250 ms) and the stable-camera fast path both engage.
 */
export function baselineCameraPath(): CameraStep[] {
  const steps: CameraStep[] = [];
  let t = 0;

  // Phase 1 — orbit sweep.
  for (let i = 0; i < 24; i++) {
    const az = (i * 2 * Math.PI) / 24;
    steps.push(step('orbit', t, [300 * Math.cos(az), 300 * Math.sin(az), 150]));
    t += 100;
  }

  // Phase 2 — wheel-zoom dolly profile (azimuth 0, height tracks radius).
  for (let i = 0; i < 12; i++) {
    const radius = 300 * Math.pow(80 / 300, i / 11);
    steps.push(step('wheel-zoom', t, [radius, 0, 150 * (radius / 300)]));
    t += 80;
  }

  // Phase 3 — rapid rotation at close radius (velocity depth caps engage).
  for (let i = 1; i <= 8; i++) {
    const az = (i * Math.PI) / 4;
    steps.push(step('rotate-fast', t, [80 * Math.cos(az), 80 * Math.sin(az), 40]));
    t += 50;
  }

  // Phase 4 — hard stop; hold still well past STABLE_SETTLE_MS.
  const last = steps[steps.length - 1];
  for (let i = 0; i < 8; i++) {
    steps.push(step('settle', t, last.cameraPosition));
    t += 200;
  }

  return steps;
}
