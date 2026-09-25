/**
 * Scripted navigation trajectories for the `?benchmark=nav` camera driver.
 *
 * Pure data: each trajectory is a list of input steps the driver replays on
 * the viewer canvas. Pointer positions are fractions of the canvas box
 * ([0, 1] on each axis), and the app frames a scan's bounds to fill the
 * viewport on load, so the same trajectory covers the same share of any
 * scene. Step times sit on a nominal 60 Hz frame clock: the driver plays the
 * steps of nominal frame `round(tMs * 60 / 1000)` on its n-th animation frame.
 *
 * Randomness (small jitter, scrub reversal points) comes from the seeded
 * mulberry32 in `strideSample.ts`, so a trajectory is a fixed list and its
 * digest is stable.
 */
import { makePrng } from '../io/strideSample';
import { canonicalJson } from '../canonicalHash';
import { sha256Hex } from '../terrain/export/sha256';

export type NavStepKind = 'pointerdown' | 'pointermove' | 'pointerup' | 'wheel' | 'key';

/**
 * One scripted input. `x`/`y` are canvas fractions; `button` is the pointer
 * button (0 primary); `deltaY` is the wheel delta in pixels; `key` is a
 * `KeyboardEvent.code` suffixed `:down` or `:up` for key steps, else ''.
 */
export interface NavStep {
  readonly tMs: number;
  readonly kind: NavStepKind;
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly deltaY: number;
  readonly key: string;
}

/** Where the scene is densest, as a canvas fraction; the canvas centre when unknown. */
export interface NavSceneHint {
  readonly dense?: { readonly x: number; readonly y: number };
}

export const NAV_TRAJECTORY_NAMES = ['orbit', 'flythrough', 'zoomShock', 'scrub', 'stopInspect'] as const;
export type NavTrajectoryName = (typeof NAV_TRAJECTORY_NAMES)[number];

/** Nominal frame length of the step clock, in ms. */
export const NAV_FRAME_MS = 1000 / 60;

/** Seed shared by every trajectory; changing it changes every digest. */
export const NAV_TRAJECTORY_SEED = 0x6e617631;

/** Round to 1e-6 so the canonical JSON of a step list does not depend on float noise. */
const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
const clamp01 = (v: number): number => Math.min(0.98, Math.max(0.02, v));
const tOf = (frame: number): number => r6(frame * NAV_FRAME_MS);

/** Nominal frame of a step on the 60 Hz step clock. */
export function stepFrame(step: Pick<NavStep, 'tMs'>): number {
  return Math.round((step.tMs * 60) / 1000);
}

class Steps {
  readonly list: NavStep[] = [];
  frame = 0;
  x = 0.5;
  y = 0.5;
  add(kind: NavStepKind, extra: Partial<Pick<NavStep, 'button' | 'deltaY' | 'key'>> = {}): void {
    this.list.push({
      tMs: tOf(this.frame),
      kind,
      x: r6(clamp01(this.x)),
      y: r6(clamp01(this.y)),
      button: extra.button ?? 0,
      deltaY: extra.deltaY ?? 0,
      key: extra.key ?? '',
    });
  }
  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.add('pointermove');
  }
  wait(frames: number): void {
    this.frame += frames;
  }
}

/** Orbit slow, medium, fast, then the same in reverse, with pitch variation. */
function orbit(rand: () => number): NavStep[] {
  const s = new Steps();
  s.add('pointerdown');
  const speeds = [0.002, 0.006, 0.014];
  let phase = 0;
  for (const dir of [1, -1]) {
    for (const v of dir === 1 ? speeds : [...speeds].reverse()) {
      for (let k = 0; k < 60; k++) {
        s.wait(1);
        phase += 0.05;
        const x = s.x + dir * v * (1 + 0.1 * (rand() - 0.5));
        // Wrap horizontally inside the canvas: a drag keeps its delta per
        // move, so re-centring between moves would jump; instead reverse the
        // origin by lifting and pressing again at the other side.
        if (x < 0.1 || x > 0.9) {
          s.add('pointerup');
          s.x = dir === 1 ? 0.15 : 0.85;
          s.add('pointerdown');
          continue;
        }
        s.moveTo(x, 0.5 + 0.12 * Math.sin(phase));
      }
    }
  }
  s.wait(1);
  s.add('pointerup');
  return s.list;
}

/** Dolly from a sparse edge toward the dense area and back, the cursor leading. */
function flythrough(rand: () => number, dense: { x: number; y: number }): NavStep[] {
  const s = new Steps();
  const from = { x: 1 - dense.x < 0.5 ? 0.1 : 0.9, y: 0.5 };
  s.moveTo(from.x, from.y);
  const n = 90;
  for (let k = 1; k <= n; k++) {
    s.wait(1);
    const f = k / n;
    s.moveTo(from.x + (dense.x - from.x) * f, from.y + (dense.y - from.y) * f);
    if (k % 3 === 0) s.add('wheel', { deltaY: -(60 + Math.round(rand() * 40)) });
  }
  s.wait(20);
  for (let k = 1; k <= n; k++) {
    s.wait(1);
    const f = k / n;
    s.moveTo(dense.x + (from.x - dense.x) * f, dense.y + (from.y - dense.y) * f);
    if (k % 3 === 0) s.add('wheel', { deltaY: 60 + Math.round(rand() * 40) });
  }
  return s.list;
}

/** Pull out to an overview, then drive hard into the dense area. */
function zoomShock(rand: () => number, dense: { x: number; y: number }): NavStep[] {
  const s = new Steps();
  s.moveTo(0.5, 0.5);
  for (let k = 0; k < 10; k++) {
    s.wait(1);
    s.add('wheel', { deltaY: 120 });
  }
  s.wait(40);
  s.moveTo(dense.x, dense.y);
  for (let k = 0; k < 12; k++) {
    s.wait(1);
    s.add('wheel', { deltaY: -(220 + Math.round(rand() * 40)) });
  }
  return s.list;
}

/** Drag back and forth, reversing every few frames, then tap the arrow keys the same way. */
function scrub(rand: () => number): NavStep[] {
  const s = new Steps();
  s.x = 0.5;
  s.add('pointerdown');
  let dir = 1;
  let left = 4 + Math.floor(rand() * 7);
  for (let k = 0; k < 240; k++) {
    s.wait(1);
    if (--left <= 0) {
      dir = -dir;
      left = 4 + Math.floor(rand() * 7);
    }
    s.moveTo(Math.min(0.85, Math.max(0.15, s.x + dir * 0.01)), 0.5 + 0.02 * (rand() - 0.5));
  }
  s.wait(1);
  s.add('pointerup');
  for (let k = 0; k < 8; k++) {
    const code = k % 2 === 0 ? 'ArrowLeft' : 'ArrowRight';
    s.wait(2);
    s.add('key', { key: `${code}:down` });
    s.wait(3 + Math.floor(rand() * 5));
    s.add('key', { key: `${code}:up` });
  }
  return s.list;
}

/** Fast drag, abrupt stop with the button held, release, then hold still for 3 s. */
function stopInspect(rand: () => number): NavStep[] {
  const s = new Steps();
  s.x = 0.2;
  s.add('pointerdown');
  for (let k = 0; k < 30; k++) {
    s.wait(1);
    s.moveTo(s.x + 0.02, 0.5 + 0.01 * (rand() - 0.5));
  }
  s.wait(6);
  s.add('pointerup');
  s.wait(180);
  // A hover move closes the hold so the list spans the full 3 s.
  s.add('pointermove');
  return s.list;
}

/** Build a trajectory by name. */
export function buildTrajectory(name: NavTrajectoryName, hint: NavSceneHint = {}): NavStep[] {
  const rand = makePrng(NAV_TRAJECTORY_SEED ^ NAV_TRAJECTORY_NAMES.indexOf(name));
  const dense = { x: clamp01(hint.dense?.x ?? 0.5), y: clamp01(hint.dense?.y ?? 0.5) };
  switch (name) {
    case 'orbit': return orbit(rand);
    case 'flythrough': return flythrough(rand, dense);
    case 'zoomShock': return zoomShock(rand, dense);
    case 'scrub': return scrub(rand);
    case 'stopInspect': return stopInspect(rand);
  }
}

/** SHA-256 (hex) of the canonical JSON of a step list. */
export function trajectoryDigest(steps: readonly NavStep[]): string {
  return sha256Hex(new TextEncoder().encode(canonicalJson(steps)));
}
